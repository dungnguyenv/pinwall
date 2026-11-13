import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  CreateProjectRequest,
  ErrorBody,
  Project,
  ProjectList,
  UpdateProjectRequest,
} from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth } from '../auth/guards.ts';
import type { ProjectRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import {
  createProject,
  DEFAULT_PROJECT_ID,
  ensureDefaultProject,
  getProject,
  listProjects,
  type ProjectWithCount,
  updateProject,
  withArtifactCounts,
} from '../domain/projects.ts';
import { defaultProjectFor, rolesIn, type Scope, scopeOf, seesAll } from '../domain/spaces.ts';
import { jsonBodyLimit } from './body-limit.ts';
import { IdParam, ListQuery } from './pagination.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const security: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];
const authErrors = {
  401: error('Not signed in'),
  403: error('A cross-site request with the session cookie (`forbidden`)'),
};
const notFoundError = { 404: error('No such project (`not_found`)') };

const ProjectListQuery = ListQuery.extend({
  archived: z.enum(['true', 'false']).default('false'),
});

const listProjectsRoute = createRoute({
  method: 'get',
  path: '/projects',
  tags: ['projects'],
  summary: 'List projects',
  description:
    'The active projects, or with `archived=true` the archived ones. The default project comes first, then the others by creation time.',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { query: ProjectListQuery },
  responses: {
    200: {
      description: 'A page of projects',
      content: { 'application/json': { schema: ProjectList } },
    },
    400: error('A bad `archived`, `limit` or `cursor`'),
    ...authErrors,
  },
});

const createProjectRoute = createRoute({
  method: 'post',
  path: '/projects',
  tags: ['projects'],
  summary: 'Create a project',
  description:
    'Projects group artifacts. `instructions` is free text an agent reads before it publishes into the project.',
  middleware: [requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: CreateProjectRequest } } },
  },
  responses: {
    201: { description: 'The new project', content: { 'application/json': { schema: Project } } },
    400: error('Invalid fields'),
    ...authErrors,
  },
});

const getProjectRoute = createRoute({
  method: 'get',
  path: '/projects/{id}',
  tags: ['projects'],
  summary: 'Read a project',
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The project', content: { 'application/json': { schema: Project } } },
    ...authErrors,
    ...notFoundError,
  },
});

const patchProjectRoute = createRoute({
  method: 'patch',
  path: '/projects/{id}',
  tags: ['projects'],
  summary: 'Rename, describe, archive or unarchive a project',
  description:
    'Only the fields given change. `archived: true` archives the project, which hides its artifacts from the default list and from search, and stops publishes into it; `false` brings it back. The default project cannot be archived.',
  middleware: [requireAuth, jsonBodyLimit] as MiddlewareHandler<AppEnv>[],
  security,
  request: {
    params: IdParam,
    body: { required: true, content: { 'application/json': { schema: UpdateProjectRequest } } },
  },
  responses: {
    200: { description: 'The project', content: { 'application/json': { schema: Project } } },
    400: error('Invalid fields'),
    ...authErrors,
    403: error(
      "In personal mode, someone other than the project's owner (`forbidden`, `details.reason` `role`), or a cross-site request with the session cookie (`forbidden`)",
    ),
    ...notFoundError,
    409: error('The default project cannot be archived (`conflict`)'),
  },
});

export function toProject(row: ProjectWithCount): Project {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    is_default: row.is_default === 1,
    archived_at: row.archived_at,
    artifact_count: row.artifact_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Projects as the API shows them to `scope`. In personal mode each also names its owner and the
 * viewer's role in it, loaded for all rows at once (one query for the owners' names, one for the
 * roles); team mode adds neither. The rows come from lookups in the viewer's scope.
 */
export async function toProjects(
  deps: AppDeps,
  scope: Scope,
  rows: readonly ProjectWithCount[],
): Promise<Project[]> {
  if (seesAll(scope) || rows.length === 0) return rows.map(toProject);
  const { db } = deps.db;
  const ownerIds = [...new Set(rows.flatMap((row) => row.owner_id ?? []))];
  const [owners, roles] = await Promise.all([
    ownerIds.length === 0
      ? []
      : db.selectFrom('users').select(['id', 'name']).where('id', 'in', ownerIds).execute(),
    rolesIn(
      db,
      scope,
      rows.map((row) => row.id),
    ),
  ]);
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  return rows.map((row) => {
    const owner = row.owner_id === null ? undefined : ownerById.get(row.owner_id);
    const role = roles.get(row.id);
    return {
      ...toProject(row),
      owner: owner === undefined ? null : { id: owner.id, name: owner.name },
      ...(role === undefined ? {} : { role }),
    };
  });
}

/** One project as the API shows it to `scope`, with its artifact count. */
async function projectOf(deps: AppDeps, scope: Scope, row: ProjectRow): Promise<Project> {
  const [withCount] = await withArtifactCounts(deps.db.db, [row]);
  const [project] = await toProjects(deps, scope, [withCount ?? { ...row, artifact_count: 0 }]);
  if (project === undefined) throw new Error(`no project DTO for ${row.id}`);
  return project;
}

const noStore = { 'Cache-Control': 'no-store' };

export function registerProjectRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(listProjectsRoute, async (c) => {
    const { deps } = c.var;
    const scope = scopeOf(c);
    const { archived, limit, cursor } = c.req.valid('query');
    // Made with the first publish without a project; a library listed before then still shows it.
    if (archived === 'false') await defaultProjectFor(deps, scope);
    const { items, nextCursor } = await listProjects(deps, scope, {
      archived: archived === 'true',
      limit,
      cursor: cursor ?? null,
    });
    const projects = await toProjects(deps, scope, items);
    return c.json({ items: projects, next_cursor: nextCursor }, 200, noStore);
  });

  api.openapi(createProjectRoute, async (c) => {
    const body = c.req.valid('json');
    const row = await createProject(c.var.deps, authOf(c).user, {
      name: body.name,
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
    });
    return c.json(await projectOf(c.var.deps, scopeOf(c), row), 201, noStore);
  });

  api.openapi(getProjectRoute, async (c) => {
    const { deps } = c.var;
    const scope = scopeOf(c);
    const { id } = c.req.valid('param');
    // Only where the shared default is everyone's: in personal mode it is nobody's to make.
    if (id === DEFAULT_PROJECT_ID && seesAll(scope)) await ensureDefaultProject(deps);
    const row = await getProject(deps.db.db, scope, id);
    return c.json(await projectOf(deps, scope, row), 200, noStore);
  });

  api.openapi(patchProjectRoute, async (c) => {
    const { deps } = c.var;
    const scope = scopeOf(c);
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    if (id === DEFAULT_PROJECT_ID && seesAll(scope)) await ensureDefaultProject(deps);
    const row = await updateProject(deps, scope, id, {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      ...(body.archived === undefined ? {} : { archived: body.archived }),
    });
    return c.json(await projectOf(deps, scope, row), 200, noStore);
  });
}
