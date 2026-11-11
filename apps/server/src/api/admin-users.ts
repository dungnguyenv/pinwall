import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { AdminUser, AdminUserList, ErrorBody, RevokeResult, SetRoleRequest } from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { listUsers, setRoleOverride, userExists } from '../auth/admin-users.ts';
import { authOf, requireAdmin } from '../auth/guards.ts';
import { revokeAllCredentials } from '../auth/revoke.ts';
import { effectiveRole } from '../auth/roles.ts';
import type { UserRow } from '../db/schema.ts';
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
  description: 'Oldest first, with the role each user has and where it comes from.',
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
    'An override wins over the identity provider role; `null` clears it. `blocked` locks the user out at once. You cannot change your own role.',
  middleware: [requireAdmin, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: UserId,
    body: { required: true, content: { 'application/json': { schema: SetRoleRequest } } },
  },
  responses: {
    200: { description: 'The user', content: { 'application/json': { schema: AdminUser } } },
    ...adminErrors,
    404: error('No such user (`not_found`)'),
  },
});

const revokeNow = createRoute({
  method: 'post',
  path: '/admin/users/{id}/revoke',
  tags: ['admin'],
  summary: 'Revoke now',
  description:
    "Ends all of the user's browser sessions, API tokens and OAuth grants at once. Revoking yourself is allowed and signs you out everywhere.",
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

function toAdminUser(user: UserRow): AdminUser {
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
  };
}

const noStore = { 'Cache-Control': 'no-store' };

export function registerAdminUserRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listAdminUsers, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const { items, nextCursor } = await listUsers(c.var.deps, { limit, cursor: cursor ?? null });
    return c.json({ items: items.map(toAdminUser), next_cursor: nextCursor }, 200, noStore);
  });

  api.openapi(putRole, async (c) => {
    const { deps } = c.var;
    const actor = authOf(c).user;
    const { id } = c.req.valid('param');
    const { role_override } = c.req.valid('json');
    const user = await setRoleOverride(deps, actor, id, role_override);
    deps.logger.info({ actor_id: actor.id, user_id: id, role_override }, 'role override changed');
    return c.json(toAdminUser(user), 200, noStore);
  });

  api.openapi(revokeNow, async (c) => {
    const { deps } = c.var;
    const actor = authOf(c).user;
    const { id } = c.req.valid('param');
    if (!(await userExists(deps, id))) throw notFound(t('auth.userNotFound'));
    const result = await revokeAllCredentials(deps, id);
    deps.logger.info(
      {
        actor_id: actor.id,
        user_id: id,
        sessions: result.sessions,
        api_tokens: result.apiTokens,
        oauth_grants: result.oauthGrants,
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
