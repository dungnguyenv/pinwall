import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  AdminLookup,
  AdminShareLinkList,
  EndGrantsResult,
  ErrorBody,
  LookupRequest,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { moderated } from '../auth/admin-users.ts';
import { authOf, requireAdmin } from '../auth/guards.ts';
import type { Config } from '../config/types.ts';
import { systemDeleteArtifact, systemDeleteVersion } from '../domain/deletion.ts';
import {
  endVersionGrants,
  listActiveShareLinks,
  lookupReportedUrl,
  parseReportedUrl,
} from '../domain/moderation.ts';
import { systemRevokeShareLink } from '../domain/shares.ts';
import { SYSTEM_SCOPE } from '../domain/spaces.ts';
import { jsonBodyLimit } from './body-limit.ts';
import { IdParam, ListQuery, VersionNumber } from './pagination.ts';

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
const missingArtifact = {
  404: error('The artifact or the version does not exist (`not_found`)'),
  410: error('The artifact or the version was deleted (`gone`)'),
};

const VersionParams = IdParam.extend({ n: VersionNumber });

const listLinks = createRoute({
  method: 'get',
  path: '/admin/share-links',
  tags: ['admin'],
  summary: 'List the active share links',
  description:
    "Every share link in the instance that is neither revoked nor expired, newest first, with the artifact's name, its owner, who made the link and when, whether it has a password and allows comments, and when it was last used. Metadata only: tokens are stored as hashes, so no address to open a link is listed or can be rebuilt, and nothing of the content is shown.",
  middleware: [requireAdmin] as MiddlewareHandler<AppEnv>[],
  security,
  request: { query: ListQuery },
  responses: {
    200: {
      description: 'A page of share links',
      content: { 'application/json': { schema: AdminShareLinkList } },
    },
    400: error('A bad `limit` or `cursor`'),
    ...adminErrors,
  },
});

const revokeLink = createRoute({
  method: 'delete',
  path: '/admin/share-links/{id}',
  tags: ['admin'],
  summary: 'Revoke a share link',
  description:
    'Whoever made it. The link stops working at once, and so does the content it opened. Revoking a revoked link changes nothing.',
  middleware: [requireAdmin] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    204: { description: 'Revoked' },
    ...adminErrors,
    404: error('No such share link (`not_found`)'),
  },
});

const lookup = createRoute({
  method: 'post',
  path: '/admin/lookup',
  tags: ['admin'],
  summary: 'Look up a reported address',
  description:
    'Takes an address from an abuse report: a share URL (`/s/<token>`), an artifact link (`/a/<id>`, with `/v/<n>`), or a content URL (`/c/<token>/…`, or `<token>.<content host>` where content has a host of its own). Answers with the artifact, its project and owner, the version, and the share link or grant the address belongs to. Nothing of the content is returned, and the address is not logged: only its kind and the artifact are.',
  middleware: [requireAdmin, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: LookupRequest } } },
  },
  responses: {
    200: {
      description: 'What it belongs to',
      content: { 'application/json': { schema: AdminLookup } },
    },
    400: error('Not an `http://` or `https://` address (`bad_request`)'),
    ...adminErrors,
    404: error('The address does not belong to anything on this Pinwall (`not_found`)'),
    410: error('What the address pointed to was already removed (`gone`)'),
  },
});

const deleteArtifact = createRoute({
  method: 'delete',
  path: '/admin/artifacts/{id}',
  tags: ['admin'],
  summary: 'Delete an artifact',
  description:
    'Deletes any artifact for good, in whichever space it is, as its publisher would: every version, share link and comment, with the files no other artifact uses. Its links and grants answer "gone" from then on.',
  middleware: [requireAdmin] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    204: { description: 'Deleted' },
    ...adminErrors,
    404: error('No such artifact (`not_found`)'),
    410: error('The artifact was deleted already (`gone`)'),
  },
});

const deleteVersion = createRoute({
  method: 'delete',
  path: '/admin/artifacts/{id}/versions/{n}',
  tags: ['admin'],
  summary: 'Delete a version',
  description:
    'Deletes version `n` of any artifact for good, as its publisher would: its files, comments, grants and per-version share links go, and answer "gone". If it was the current version, the newest remaining one becomes current; deleting the only version deletes the artifact.',
  middleware: [requireAdmin] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: VersionParams },
  responses: {
    204: { description: 'Deleted' },
    400: error('`n` is not a positive integer'),
    ...adminErrors,
    ...missingArtifact,
  },
});

const endGrants = createRoute({
  method: 'post',
  path: '/admin/versions/{id}/end-grants',
  tags: ['admin'],
  summary: 'End every grant of a version',
  description:
    'Ends every content grant of the version, those made for people and those a share link\'s guests hold, so what they opened answers "gone" at once. The version, its share links and the artifact stay; a link that follows the version makes new grants when it is opened again, so revoke it too to stop that.',
  middleware: [requireAdmin] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    200: {
      description: 'How many grants ended',
      content: { 'application/json': { schema: EndGrantsResult } },
    },
    ...adminErrors,
    404: error('No such version (`not_found`)'),
  },
});

const noStore = { 'Cache-Control': 'no-store' };

/**
 * What a look-up's log line says it was asked about: the kind of address (null when it is none
 * this Pinwall hands out), and the artifact when the address names one by id. Never the address,
 * and never a token.
 */
function lookupTarget(config: Config, url: string): Record<string, unknown> {
  const reported = parseReportedUrl(config, url);
  if (reported === null) return { kind: null };
  if (reported.kind === 'artifact') return { kind: 'artifact', artifact_id: reported.id };
  return { kind: reported.kind === 'share' ? 'share_link' : 'content_grant' };
}

export function registerAdminModerationRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listLinks, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const { items, nextCursor } = await listActiveShareLinks(c.var.deps, SYSTEM_SCOPE, {
      limit,
      cursor: cursor ?? null,
    });
    return c.json({ items, next_cursor: nextCursor }, 200, noStore);
  });

  api.openapi(revokeLink, async (c) => {
    const { deps } = c.var;
    const { id } = c.req.valid('param');
    await moderated(deps, authOf(c).user.id, 'share_link.revoke', { share_link_id: id }, () =>
      systemRevokeShareLink(deps, SYSTEM_SCOPE, id),
    );
    return c.body(null, 204);
  });

  api.openapi(lookup, async (c) => {
    const { deps } = c.var;
    const { url } = c.req.valid('json');
    const found = await moderated(
      deps,
      authOf(c).user.id,
      'lookup',
      lookupTarget(deps.config, url),
      () => lookupReportedUrl(deps, SYSTEM_SCOPE, url),
      (result) => ({ artifact_id: result.artifact.id }),
    );
    return c.json(found, 200, noStore);
  });

  api.openapi(deleteArtifact, async (c) => {
    const { deps } = c.var;
    const { id } = c.req.valid('param');
    await moderated(deps, authOf(c).user.id, 'artifact.delete', { artifact_id: id }, () =>
      systemDeleteArtifact(deps, SYSTEM_SCOPE, id),
    );
    return c.body(null, 204);
  });

  api.openapi(deleteVersion, async (c) => {
    const { deps } = c.var;
    const { id, n } = c.req.valid('param');
    await moderated(deps, authOf(c).user.id, 'version.delete', { artifact_id: id, number: n }, () =>
      systemDeleteVersion(deps, SYSTEM_SCOPE, id, n),
    );
    return c.body(null, 204);
  });

  api.openapi(endGrants, async (c) => {
    const { deps } = c.var;
    const { id } = c.req.valid('param');
    const grants = await moderated(
      deps,
      authOf(c).user.id,
      'version.end_grants',
      { version_id: id },
      () => endVersionGrants(deps, SYSTEM_SCOPE, id),
      (ended) => ({ grants: ended }),
    );
    return c.json({ grants }, 200, noStore);
  });
}
