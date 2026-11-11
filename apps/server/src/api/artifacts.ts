import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ArtifactList, ArtifactSummary, ErrorBody, UpdateArtifactRequest } from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth } from '../auth/guards.ts';
import type { ArtifactRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { updateArtifact } from '../domain/artifact-edit.ts';
import {
  getArtifact,
  getTagsByArtifact,
  listArtifacts,
  listRecent,
  RECENT_MAX,
  SEARCH_MAX_CHARS,
} from '../domain/artifacts.ts';
import { getVersionsById } from '../domain/versions.ts';
import { publicUrl } from '../http/public-url.ts';
import { jsonBodyLimit } from './body-limit.ts';
import { IdParam, ListQuery } from './pagination.ts';
import { toVersionSummary } from './versions.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const security: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];
const authErrors = {
  401: error('Not signed in'),
  403: error('A cross-site request with the session cookie (`forbidden`)'),
};
const missing = {
  404: error('The artifact does not exist (`not_found`)'),
  410: error('The artifact was deleted (`gone`)'),
};

const ArtifactListQuery = ListQuery.extend({
  project_id: z.string().min(1).max(100).optional(),
  tag: z.string().min(1).max(200).optional(),
  q: z.string().max(SEARCH_MAX_CHARS).optional(),
});

const RecentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(RECENT_MAX).default(RECENT_MAX),
});

const listRoute = createRoute({
  method: 'get',
  path: '/artifacts',
  tags: ['artifacts'],
  summary: 'List or search artifacts',
  description: `Without \`q\`, the latest updated first. With \`q\`, the best match first: the words of \`q\` (at most 32; letters and digits, accents and case ignored) must each start a word in the name, the tags or the current version's text. Only the best 1,000 matches can be paged. \`tag\` keeps the artifacts with that tag. Artifacts of archived projects are left out unless \`project_id\` names that project.`,
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { query: ArtifactListQuery },
  responses: {
    200: {
      description: 'A page of artifacts',
      content: { 'application/json': { schema: ArtifactList } },
    },
    400: error(
      `A bad \`limit\`, \`cursor\` or \`tag\`, or a \`q\` over ${SEARCH_MAX_CHARS} characters`,
    ),
    ...authErrors,
    404: error('`project_id` names no project (`not_found`)'),
  },
});

const recentRoute = createRoute({
  method: 'get',
  path: '/artifacts/recent',
  tags: ['artifacts'],
  summary: 'The artifacts you opened last',
  description: `Your own views, the latest first, at most ${RECENT_MAX}. There is no next page.`,
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { query: RecentQuery },
  responses: {
    200: {
      description: 'The recent artifacts',
      content: { 'application/json': { schema: ArtifactList } },
    },
    400: error('A bad `limit`'),
    ...authErrors,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}',
  tags: ['artifacts'],
  summary: 'Read an artifact',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    200: {
      description: 'The artifact and its current version',
      content: { 'application/json': { schema: ArtifactSummary } },
    },
    ...authErrors,
    ...missing,
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/artifacts/{id}',
  tags: ['artifacts'],
  summary: 'Rename, move or tag an artifact',
  description:
    'Only the fields given change, together or not at all. `tags` replaces the whole set; tags are lowercased and trimmed, with at most 20 of 1 to 40 characters. `project_id` moves the artifact to another project, which must not be archived.',
  middleware: [requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: IdParam,
    body: { required: true, content: { 'application/json': { schema: UpdateArtifactRequest } } },
  },
  responses: {
    200: {
      description: 'The artifact',
      content: { 'application/json': { schema: ArtifactSummary } },
    },
    400: error('Invalid fields or tags'),
    ...authErrors,
    404: error('The artifact or the project does not exist (`not_found`)'),
    409: error('The project is archived (`conflict`)'),
    410: error('The artifact was deleted (`gone`)'),
  },
});

/**
 * Artifacts as the API shows them, with their tags and current versions loaded for all rows at
 * once, so a page costs the same few queries whatever its size.
 */
export async function toArtifactSummary(
  deps: AppDeps,
  rows: readonly ArtifactRow[],
): Promise<ArtifactSummary[]> {
  const { db } = deps.db;
  const [tags, versions] = await Promise.all([
    getTagsByArtifact(
      db,
      rows.map((row) => row.id),
    ),
    getVersionsById(
      db,
      rows.flatMap((row) => row.current_version_id ?? []),
    ),
  ]);
  return rows.map((row) => {
    const current =
      row.current_version_id === null ? undefined : versions.get(row.current_version_id);
    return {
      id: row.id,
      project_id: row.project_id,
      name: row.name,
      kind: row.kind,
      tags: tags.get(row.id) ?? [],
      current_version:
        current === undefined ? null : toVersionSummary(current, row.current_version_id),
      latest_number: row.latest_number,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      links: {
        review: publicUrl(deps.config, `/a/${row.id}`),
        raw: publicUrl(deps.config, `/a/${row.id}/raw`),
      },
    };
  });
}

async function summarize(deps: AppDeps, row: ArtifactRow): Promise<ArtifactSummary> {
  const [summary] = await toArtifactSummary(deps, [row]);
  if (summary === undefined) throw new Error(`no summary for artifact ${row.id}`);
  return summary;
}

const noStore = { 'Cache-Control': 'no-store' };

export function registerArtifactRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listRoute, async (c) => {
    const { deps } = c.var;
    const { project_id, tag, q, limit, cursor } = c.req.valid('query');
    const { items, nextCursor } = await listArtifacts(deps, {
      ...(project_id === undefined ? {} : { projectId: project_id }),
      ...(tag === undefined ? {} : { tag }),
      ...(q === undefined ? {} : { q }),
      limit,
      cursor: cursor ?? null,
    });
    return c.json(
      { items: await toArtifactSummary(deps, items), next_cursor: nextCursor },
      200,
      noStore,
    );
  });

  // Registered before `/artifacts/{id}`, which would take "recent" for an id.
  api.openapi(recentRoute, async (c) => {
    const { deps } = c.var;
    const { limit } = c.req.valid('query');
    const rows = await listRecent(deps, authOf(c).user.id, limit);
    return c.json({ items: await toArtifactSummary(deps, rows), next_cursor: null }, 200, noStore);
  });

  api.openapi(getRoute, async (c) => {
    const { deps } = c.var;
    const { id } = c.req.valid('param');
    const row = await getArtifact(deps.db.db, id, deps.clock.now());
    return c.json(await summarize(deps, row), 200, noStore);
  });

  api.openapi(patchRoute, async (c) => {
    const { deps } = c.var;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const row = await updateArtifact(deps, id, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.project_id === undefined ? {} : { projectId: body.project_id }),
      ...(body.tags === undefined ? {} : { tags: body.tags }),
    });
    return c.json(await summarize(deps, row), 200, noStore);
  });
}
