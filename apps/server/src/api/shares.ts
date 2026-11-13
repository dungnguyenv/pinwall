import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  CreatedShareLink,
  CreateShareLinkRequest,
  ErrorBody,
  ShareLinkList,
  ShareLinkQuery,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth } from '../auth/guards.ts';
import { perUser, RATE_RULES } from '../auth/rate-limits.ts';
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
  shareUrl,
  toShareLinks,
} from '../domain/shares.ts';
import { scopeOf } from '../domain/spaces.ts';
import { gone } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { jsonBodyLimit } from './body-limit.ts';
import { IdParam } from './pagination.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const security: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];
const authErrors = {
  401: error('Not signed in'),
  403: error('A cross-site request with the session cookie (`forbidden`)'),
};
const missingArtifact = {
  404: error('The artifact does not exist (`not_found`)'),
  410: error('The artifact was deleted (`gone`)'),
};

const listRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/share-links',
  tags: ['share links'],
  summary: 'List the share links of an artifact',
  description:
    'Newest first. Revoked links are left out unless `include_revoked` is true; expired ones are listed with status `expired`. Tokens are never listed: each is shown once, when its link is made.',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam, query: ShareLinkQuery },
  responses: {
    200: {
      description: 'A page of share links',
      content: { 'application/json': { schema: ShareLinkList } },
    },
    400: error('A bad `include_revoked`, `limit` or `cursor`'),
    ...authErrors,
    ...missingArtifact,
  },
});

const createLinkRoute = createRoute({
  method: 'post',
  path: '/artifacts/{id}/share-links',
  tags: ['share links'],
  summary: 'Make a share link',
  description:
    "A link to version `version_id`, or following the current version without it; behind `password` (8 to 256 characters) or open to anyone with it; until `expires_at` (in the future) or until revoked. Any member can make one; in personal mode, the project's owner or an editor. The answer holds the token and the link URL: they are shown this once and cannot be read again. Limited to 30 per user per hour.",
  middleware: [
    requireAuth,
    perUser(RATE_RULES.shareLinkCreate),
    jsonBodyLimit,
  ] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: IdParam,
    body: { required: true, content: { 'application/json': { schema: CreateShareLinkRequest } } },
  },
  responses: {
    201: {
      description: 'The new link, its token and its URL',
      content: { 'application/json': { schema: CreatedShareLink } },
    },
    400: error(
      'An invalid body, a password too short or too long, an expiry not in the future, or a `version_id` of another artifact',
    ),
    401: error('Not signed in'),
    403: error(
      'With `PINWALL_SHARE_LINKS=approved`, someone neither an admin nor approved (`forbidden`, `details.reason` `share_links_not_approved`); in personal mode, a viewer of the project (`forbidden`, `details.reason` `role`); or a cross-site request with the session cookie (`forbidden`)',
    ),
    ...missingArtifact,
    429: error('Over 30 new links per hour (`rate_limited`)'),
  },
});

const revokeRoute = createRoute({
  method: 'delete',
  path: '/share-links/{id}',
  tags: ['share links'],
  summary: 'Revoke a share link',
  description:
    "The link stops working at once, and so does the content it opened. The link's creator, the artifact's publisher or an admin can revoke it; in personal mode, the project's owner, or the editor who made it. Revoking a revoked link changes nothing.",
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    204: { description: 'Revoked' },
    401: error('Not signed in'),
    403: error(
      "Neither the link's creator, the artifact's publisher nor an admin, in personal mode neither the project's owner nor the editor who made it (`details.reason` `role`), or a cross-site request with the session cookie (`forbidden`)",
    ),
    404: error('The share link does not exist (`not_found`)'),
  },
});

const noStore = { 'Cache-Control': 'no-store' };

export function registerShareRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { include_revoked, limit, cursor } = c.req.valid('query');
    const { items, nextCursor } = await listShareLinks(c.var.deps, scopeOf(c), id, {
      includeRevoked: include_revoked,
      limit,
      cursor: cursor ?? null,
    });
    return c.json({ items, next_cursor: nextCursor }, 200, noStore);
  });

  api.openapi(createLinkRoute, async (c) => {
    const { deps } = c.var;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const { row, token } = await createShareLink(deps, authOf(c).user, id, {
      versionId: body.version_id ?? null,
      password: body.password ?? null,
      expiresAt: body.expires_at ?? null,
      allowComments: body.allow_comments,
    });
    const [link] = await toShareLinks(deps, [row]);
    // Its version was deleted, taking the link along, the moment it was made.
    if (link === undefined) throw gone(t('version.gone'));
    return c.json({ link, token, url: shareUrl(deps.config, token) }, 201, noStore);
  });

  api.openapi(revokeRoute, async (c) => {
    await revokeShareLink(c.var.deps, authOf(c).user, c.req.valid('param').id);
    return c.body(null, 204);
  });
}
