import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  ErrorBody,
  PublishWarning,
  RestoreRequest,
  type VersionFile,
  VersionFileList,
  VersionList,
  VersionSummary,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth } from '../auth/guards.ts';
import type { VersionFileRow, VersionRow } from '../db/schema.ts';
import { getArtifact } from '../domain/artifacts.ts';
import {
  getVersionByNumber,
  listVersionFiles,
  listVersions,
  restoreVersion,
} from '../domain/versions.ts';
import { jsonBodyLimit } from './body-limit.ts';
import { IdParam, ListQuery, VersionNumber } from './pagination.ts';

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
  404: error('The artifact or the version does not exist (`not_found`)'),
  410: error('The artifact or the version was deleted (`gone`)'),
};

const VersionParams = IdParam.extend({ n: VersionNumber });

const listRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/versions',
  tags: ['versions'],
  summary: 'List the versions of an artifact',
  description: 'Newest first. Numbers deleted versions used are not reused, so gaps are possible.',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam, query: ListQuery },
  responses: {
    200: {
      description: 'A page of versions',
      content: { 'application/json': { schema: VersionList } },
    },
    400: error('A bad `limit` or `cursor`'),
    ...authErrors,
    ...missing,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/versions/{n}',
  tags: ['versions'],
  summary: 'Read one version',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: VersionParams },
  responses: {
    200: {
      description: 'The version',
      content: { 'application/json': { schema: VersionSummary } },
    },
    400: error('`n` is not a positive integer'),
    ...authErrors,
    ...missing,
  },
});

const filesRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/versions/{n}/files',
  tags: ['versions'],
  summary: 'List the files of a version',
  description: 'In path order. `content_type` is what the file is served as.',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: VersionParams, query: ListQuery },
  responses: {
    200: {
      description: 'A page of files',
      content: { 'application/json': { schema: VersionFileList } },
    },
    400: error('A bad `n`, `limit` or `cursor`'),
    ...authErrors,
    ...missing,
  },
});

const restoreRoute = createRoute({
  method: 'post',
  path: '/artifacts/{id}/versions/{n}/restore',
  tags: ['versions'],
  summary: 'Restore an older version',
  description:
    'Copies version `n` into a new version on top of the current one, so history is kept. `expected_version_id` names the current version the caller saw; if a newer one exists the request fails with `version_conflict`.',
  middleware: [requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: VersionParams,
    body: { required: true, content: { 'application/json': { schema: RestoreRequest } } },
  },
  responses: {
    201: {
      description: 'The new version',
      content: { 'application/json': { schema: VersionSummary } },
    },
    400: error('Invalid fields'),
    ...authErrors,
    ...missing,
    409: error('The artifact has a newer version than `expected_version_id` (`version_conflict`)'),
  },
});

const WarningsMeta = z.object({ warnings: z.array(PublishWarning) });

/** The publish warnings kept in a version's `meta`; none when it has none or is unreadable. */
function warningsOf(meta: string): VersionSummary['warnings'] {
  try {
    const parsed = WarningsMeta.safeParse(JSON.parse(meta));
    return parsed.success ? parsed.data.warnings : [];
  } catch {
    return [];
  }
}

/** A version as the API shows it; `currentVersionId` is the artifact's current version. */
export function toVersionSummary(row: VersionRow, currentVersionId: string | null): VersionSummary {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    entry_path: row.entry_path,
    theme_color: row.theme_color,
    has_thumbnail: row.thumbnail_path !== null,
    file_count: row.file_count,
    total_bytes: row.total_bytes,
    message: row.message,
    source: row.source,
    restored_from_version_id: row.restored_from_version_id,
    warnings: warningsOf(row.meta),
    created_by: row.created_by,
    created_at: row.created_at,
    is_current: row.id === currentVersionId,
  };
}

function toVersionFile(row: VersionFileRow): VersionFile {
  return {
    path: row.path,
    size: row.size,
    content_type: row.content_type,
    sha256: row.sha256,
  };
}

const noStore = { 'Cache-Control': 'no-store' };

export function registerVersionRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { limit, cursor } = c.req.valid('query');
    const { items, nextCursor, currentVersionId } = await listVersions(c.var.deps, id, {
      limit,
      cursor: cursor ?? null,
    });
    return c.json(
      {
        items: items.map((row) => toVersionSummary(row, currentVersionId)),
        next_cursor: nextCursor,
      },
      200,
      noStore,
    );
  });

  api.openapi(getRoute, async (c) => {
    const { deps } = c.var;
    const { id, n } = c.req.valid('param');
    const artifact = await getArtifact(deps.db.db, id, deps.clock.now());
    const version = await getVersionByNumber(deps.db.db, artifact, n);
    return c.json(toVersionSummary(version, artifact.current_version_id), 200, noStore);
  });

  api.openapi(filesRoute, async (c) => {
    const { deps } = c.var;
    const { id, n } = c.req.valid('param');
    const { limit, cursor } = c.req.valid('query');
    const artifact = await getArtifact(deps.db.db, id, deps.clock.now());
    const version = await getVersionByNumber(deps.db.db, artifact, n);
    const { items, nextCursor } = await listVersionFiles(deps, version.id, {
      limit,
      cursor: cursor ?? null,
    });
    return c.json({ items: items.map(toVersionFile), next_cursor: nextCursor }, 200, noStore);
  });

  api.openapi(restoreRoute, async (c) => {
    const { id, n } = c.req.valid('param');
    const { expected_version_id } = c.req.valid('json');
    const { version } = await restoreVersion(
      c.var.deps,
      authOf(c).user,
      id,
      n,
      expected_version_id,
    );
    return c.json(toVersionSummary(version, version.id), 201, noStore);
  });
}
