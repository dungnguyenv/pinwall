import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  type AdminUsage,
  AdminUser,
  AdminUserList,
  ErrorBody,
  PurgeRequest,
  PurgeResult,
  RevokeResult,
  SetRoleRequest,
  UpdateAdminUserRequest,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import {
  getUser,
  listUsers,
  logModeration,
  setRoleOverride,
  updateUserModeration,
  userExists,
} from '../auth/admin-users.ts';
import { authOf, requireAdmin } from '../auth/guards.ts';
import { revokeAllCredentials } from '../auth/revoke.ts';
import { effectiveRole } from '../auth/roles.ts';
import { clearSessionCookie } from '../auth/session-cookie.ts';
import type { UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { assertPurgeAvailable, assertPurgeConfirmed, purgeSpace } from '../domain/purge.ts';
import { SYSTEM_SCOPE } from '../domain/spaces.ts';
import { usageSummaries } from '../domain/usage.ts';
import { notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { jsonBodyLimit } from './body-limit.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

/** Admins only, by a browser session or an API token. */
const security: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];
const adminErrors = {
  401: error('Not signed in'),
  403: error('Not an admin (`forbidden`)'),
};

const UserId = z.object({ id: z.string().min(1).max(100) });

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(1000).optional(),
});

const listAdminUsers = createRoute({
  method: 'get',
  path: '/admin/users',
  tags: ['admin'],
  summary: 'List users',
  description:
    'Oldest first, with the role each user has and where it comes from, what their space holds, whether they may expose content, and the quota overrides an admin set. These are sent in both visibility modes.',
  middleware: [requireAdmin] as MiddlewareHandler<AppEnv>[],
  security,
  request: { query: ListQuery },
  responses: {
    200: {
      description: 'A page of users',
      content: { 'application/json': { schema: AdminUserList } },
    },
    400: error('A bad `limit` or `cursor`'),
    ...adminErrors,
  },
});

const putRole = createRoute({
  method: 'put',
  path: '/admin/users/{id}/role',
  tags: ['admin'],
  summary: 'Set or clear a role override',
  description:
    "`admin` or `member` replaces the identity provider role, but only while the identity provider still admits the user: once it drops them, they lose access as if no override were set, and the override applies again if it admits them later. `blocked` always applies: it locks the user out at once and revokes every share link they made. `null` clears the override. You cannot change your own role, and nobody can change the owner's: the owner is always an admin.",
  middleware: [requireAdmin, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: UserId,
    body: { required: true, content: { 'application/json': { schema: SetRoleRequest } } },
  },
  responses: {
    200: { description: 'The user', content: { 'application/json': { schema: AdminUser } } },
    ...adminErrors,
    403: error('Not an admin, or the user is you or the owner (`forbidden`)'),
    404: error('No such user (`not_found`)'),
  },
});

const patchUser = createRoute({
  method: 'patch',
  path: '/admin/users/{id}',
  tags: ['admin'],
  summary: 'Approve a user, or set their quota',
  description:
    "`share_approved` lets the user expose content (share links and raw links) when the instance requires approval (`PINWALL_SHARE_LINKS=approved`); taking it away revokes every share link they made, unless they are an admin. `quota_bytes` and `quota_artifacts` replace the instance's limits for this user (0: no limit); `null` gives the instance's back. Only the keys sent change, and at least one is needed.",
  middleware: [requireAdmin, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: UserId,
    body: { required: true, content: { 'application/json': { schema: UpdateAdminUserRequest } } },
  },
  responses: {
    200: { description: 'The user', content: { 'application/json': { schema: AdminUser } } },
    400: error('An empty body, or a quota that is not a whole number of at least 0'),
    ...adminErrors,
    404: error('No such user (`not_found`)'),
  },
});

const purgeUser = createRoute({
  method: 'post',
  path: '/admin/users/{id}/purge',
  tags: ['admin'],
  summary: "Delete all of a user's content",
  description:
    'Only in `personal` mode (in `team` mode the route does not exist: `not_found`). Deletes every project the user owns, with all that is in them, as deleting each artifact does: their share links answer "gone" and the files are removed. Projects the user only belongs to stay, and so does the user. Send the user\'s email address (their id, when they have none) as `confirm_email`. This destroys work but shows none of it.',
  middleware: [requireAdmin, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: UserId,
    body: { required: true, content: { 'application/json': { schema: PurgeRequest } } },
  },
  responses: {
    200: {
      description: 'What was deleted',
      content: { 'application/json': { schema: PurgeResult } },
    },
    400: error("`confirm_email` is not the user's email address"),
    ...adminErrors,
    404: error('No such user, or the instance is in `team` mode (`not_found`)'),
    409: error('New artifacts kept arriving; try again (`conflict`)'),
  },
});

const revokeNow = createRoute({
  method: 'post',
  path: '/admin/users/{id}/revoke',
  tags: ['admin'],
  summary: 'Revoke now',
  description:
    "Ends all of the user's browser sessions, API tokens and OAuth grants at once, and revokes every share link they made. Revoking yourself is allowed and signs you out everywhere; from a browser, the response also clears the session cookie.",
  middleware: [requireAdmin] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: UserId },
  responses: {
    200: {
      description: 'What was ended',
      content: { 'application/json': { schema: RevokeResult } },
    },
    ...adminErrors,
    404: error('No such user (`not_found`)'),
  },
});

function toAdminUser(user: UserRow, usage: AdminUsage): AdminUser {
  return {
    id: user.id,
    kind: user.kind,
    name: user.name ?? user.email ?? '',
    email: user.email,
    email_verified: user.email_verified === 1,
    avatar_url: user.avatar_url,
    idp_role: user.idp_role,
    role_override: user.role_override,
    effective_role: effectiveRole(user),
    disabled_at: user.disabled_at,
    disabled_reason: user.disabled_reason,
    created_at: user.created_at,
    last_seen_at: user.last_seen_at,
    usage,
    share_approved: user.share_approved === 1,
    quota_bytes: user.quota_bytes,
    quota_artifacts: user.quota_artifacts,
  };
}

/** `user` as an admin sees them, with the usage of their space. */
async function adminUserOf(deps: AppDeps, user: UserRow): Promise<AdminUser> {
  const usage = await usageSummaries(deps.db.db, deps.config, [user.id], deps.clock.now());
  return toAdminUser(user, usageIn(usage, user.id));
}

/** The usage `usageSummaries` made for `userId`, which it does for everyone asked for. */
function usageIn(usage: ReadonlyMap<string, AdminUsage>, userId: string): AdminUsage {
  const found = usage.get(userId);
  if (found === undefined) throw new Error(`No usage was summarized for ${userId}`);
  return found;
}

const noStore = { 'Cache-Control': 'no-store' };

export function registerAdminUserRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listAdminUsers, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const { deps } = c.var;
    const { items, nextCursor } = await listUsers(deps, { limit, cursor: cursor ?? null });
    const usage = await usageSummaries(
      deps.db.db,
      deps.config,
      items.map((user) => user.id),
      deps.clock.now(),
    );
    return c.json(
      {
        items: items.map((user) => toAdminUser(user, usageIn(usage, user.id))),
        next_cursor: nextCursor,
      },
      200,
      noStore,
    );
  });

  api.openapi(putRole, async (c) => {
    const { deps } = c.var;
    const actor = authOf(c).user;
    const { id } = c.req.valid('param');
    const { role_override } = c.req.valid('json');
    const { user, shareLinks } = await setRoleOverride(deps, actor, id, role_override);
    deps.logger.info(
      { actor_id: actor.id, user_id: id, role_override, share_links: shareLinks },
      'role override changed',
    );
    return c.json(await adminUserOf(deps, user), 200, noStore);
  });

  api.openapi(patchUser, async (c) => {
    const { deps } = c.var;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const { user } = await updateUserModeration(deps, id, {
      ...(body.share_approved === undefined ? {} : { shareApproved: body.share_approved }),
      ...(body.quota_bytes === undefined ? {} : { quotaBytes: body.quota_bytes }),
      ...(body.quota_artifacts === undefined ? {} : { quotaArtifacts: body.quota_artifacts }),
    });
    logModeration(deps, authOf(c).user.id, 'user.update', { user_id: id });
    return c.json(await adminUserOf(deps, user), 200, noStore);
  });

  api.openapi(purgeUser, async (c) => {
    const { deps } = c.var;
    const { id } = c.req.valid('param');
    const { confirm_email } = c.req.valid('json');
    assertPurgeAvailable(deps);
    assertPurgeConfirmed(await getUser(deps, id), confirm_email);
    logModeration(deps, authOf(c).user.id, 'user.purge', { user_id: id });
    return c.json(await purgeSpace(deps, SYSTEM_SCOPE, id), 200, noStore);
  });

  api.openapi(revokeNow, async (c) => {
    const { deps } = c.var;
    const auth = authOf(c);
    const actor = auth.user;
    const { id } = c.req.valid('param');
    if (!(await userExists(deps, id))) throw notFound(t('auth.userNotFound'));
    const result = await revokeAllCredentials(deps, id);
    // The browser that asked just lost its session: say so, as sign-out does. A bearer request
    // never touches cookies.
    if (id === actor.id && auth.via === 'session') clearSessionCookie(c);
    deps.logger.info(
      {
        actor_id: actor.id,
        user_id: id,
        sessions: result.sessions,
        api_tokens: result.apiTokens,
        oauth_grants: result.oauthGrants,
        content_grants: result.contentGrants,
        share_links: result.shareLinks,
      },
      'credentials revoked',
    );
    return c.json(
      { sessions: result.sessions, api_tokens: result.apiTokens, oauth_grants: result.oauthGrants },
      200,
      noStore,
    );
  });
}
