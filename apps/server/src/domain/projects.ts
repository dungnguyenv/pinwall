import { type RawBuilder, sql, type Updateable } from 'kysely';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import type { DbBool, ProjectRow, ProjectsTable, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { newId } from '../lib/ids.ts';
import {
  assertCan,
  roleIn,
  type Scope,
  seesAll,
  teamDefaultProject,
  whereVisible,
} from './spaces.ts';

/** The project new artifacts land in when the publisher names none. Fixed, so it exists once. */
export const DEFAULT_PROJECT_ID = 'prj_00000000000000000000';

/**
 * Creates the default project unless it exists, and returns it as it is now (perhaps renamed).
 * Safe to call at the same time from several places: the fixed id makes all but one insert a
 * no-op.
 */
export async function ensureDefaultProject(deps: AppDeps): Promise<ProjectRow> {
  const now = deps.clock.now();
  await deps.db.db
    .insertInto('projects')
    .values({
      id: DEFAULT_PROJECT_ID,
      name: t('project.defaultName'),
      instructions: '',
      is_default: 1,
      archived_at: null,
      created_by: null,
      created_at: now,
      updated_at: now,
      owner_id: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  return deps.db.db
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', DEFAULT_PROJECT_ID)
    .executeTakeFirstOrThrow();
}

/** The project `id`, if `scope` sees it; 404 for a missing one and one it does not see alike. */
export async function getProject(db: Db, scope: Scope, id: string): Promise<ProjectRow> {
  const project = await whereVisible(
    db.selectFrom('projects').selectAll().where('id', '=', id),
    scope,
    'projects.id',
  ).executeTakeFirst();
  if (project === undefined) throw notFound(t('project.notFound'));
  return project;
}

export async function createProject(
  deps: AppDeps,
  actor: UserRow,
  p: { name: string; instructions?: string },
): Promise<ProjectRow> {
  const now = deps.clock.now();
  const project: ProjectRow = {
    id: newId('prj'),
    name: p.name,
    instructions: p.instructions ?? '',
    is_default: 0,
    archived_at: null,
    created_by: actor.id,
    created_at: now,
    updated_at: now,
    owner_id: actor.id,
  };
  await deps.db.db.insertInto('projects').values(project).execute();
  return project;
}

/**
 * Renames a project, replaces its instructions, or archives or unarchives it. Archiving one that
 * is already archived keeps the time it was first archived. A default project cannot be
 * archived: it is where publishes without a project go (in team mode, the later ones left from
 * a personal period stay unarchivable too). A project `scope` does not see answers 404, as a
 * missing one does; in personal mode only its owner may change it.
 */
export function updateProject(
  deps: AppDeps,
  scope: Scope,
  id: string,
  p: { name?: string; instructions?: string; archived?: boolean },
): Promise<ProjectRow> {
  return deps.db.db.transaction().execute(async (trx) => {
    const project = await getProject(trx, scope, id);
    assertCan(scope, await roleIn(trx, scope, id), 'manageProject');
    if (p.archived === true && project.is_default === 1) {
      throw conflict(t('project.defaultArchive'));
    }
    const now = deps.clock.now();
    const patch = {
      updated_at: now,
      ...(p.name === undefined ? {} : { name: p.name }),
      ...(p.instructions === undefined ? {} : { instructions: p.instructions }),
      ...(p.archived === undefined
        ? {}
        : { archived_at: p.archived ? (project.archived_at ?? now) : null }),
    } satisfies Updateable<ProjectsTable>;
    await trx.updateTable('projects').set(patch).where('id', '=', id).execute();
    return { ...project, ...patch };
  });
}

export type ProjectWithCount = ProjectRow & { artifact_count: number };

/**
 * Where the next page starts: after the project with list key `d` (1 for the project the list
 * starts with, else 0), created at `c`, id `i`.
 */
const ProjectCursor = z.object({
  d: z.union([z.literal(0), z.literal(1)]),
  c: z.number().int(),
  i: z.string(),
});

/**
 * The list key `d` of a projects row: 1 for the one project `scope`'s list starts with, its
 * default, else 0. A personal viewer: their own default project. Team mode and the system: the
 * shared default (the oldest), so later defaults, left from a personal period, list as ordinary
 * projects.
 */
async function listKey(db: Db, scope: Scope): Promise<RawBuilder<DbBool>> {
  if (!seesAll(scope) && scope.kind === 'viewer') {
    const viewer = scope.user.id;
    return sql<DbBool>`case when projects.owner_id = ${viewer} and projects.is_default = 1 then 1 else 0 end`;
  }
  const shared = await teamDefaultProject(db);
  if (shared === undefined) return sql<DbBool>`0`;
  return sql<DbBool>`case when projects.id = ${shared.id} then 1 else 0 end`;
}

/**
 * One page of the archived or the active projects `scope` sees: its default project first, then
 * by creation time, then by id, so a page boundary between two projects made in the same
 * millisecond neither repeats nor skips one. In team mode only the shared default is
 * `is_default`; a personal viewer's list keeps the flag of each project.
 */
export async function listProjects(
  deps: AppDeps,
  scope: Scope,
  p: { archived: boolean; limit: number; cursor: string | null },
): Promise<{ items: ProjectWithCount[]; nextCursor: string | null }> {
  const { db } = deps.db;
  const d = await listKey(db, scope);
  let query = whereVisible(
    db.selectFrom('projects').selectAll().select(d.as('d')),
    scope,
    'projects.id',
  ).where('archived_at', p.archived ? 'is not' : 'is', null);
  if (p.cursor !== null) {
    const after = decodeCursor(p.cursor, ProjectCursor);
    query = query.where((eb) =>
      eb.or([
        eb(d, '<', after.d),
        eb.and([eb(d, '=', after.d), eb('created_at', '>', after.c)]),
        eb.and([eb(d, '=', after.d), eb('created_at', '=', after.c), eb('id', '>', after.i)]),
      ]),
    );
  }
  const rows = await query
    .orderBy(d, 'desc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(p.limit + 1)
    .execute();
  const page = rows.slice(0, p.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > p.limit && last
      ? encodeCursor({ d: Number(last.d), c: last.created_at, i: last.id })
      : null;
  const sharedDefault = seesAll(scope);
  const projects = page.map(
    ({ d: key, ...row }): ProjectRow =>
      sharedDefault ? { ...row, is_default: Number(key) === 1 ? 1 : 0 } : row,
  );
  return { items: await withArtifactCounts(db, projects), nextCursor };
}

/** The projects with the number of artifacts in each, archived or not, in one query. */
export async function withArtifactCounts(
  db: Db,
  projects: readonly ProjectRow[],
): Promise<ProjectWithCount[]> {
  if (projects.length === 0) return [];
  const counts = await db
    .selectFrom('artifacts')
    .select(['project_id', (eb) => eb.fn.countAll().as('n')])
    .where(
      'project_id',
      'in',
      projects.map((project) => project.id),
    )
    .groupBy('project_id')
    .execute();
  // Postgres counts as bigint and node-postgres hands those over as strings.
  const byProject = new Map(counts.map((row) => [row.project_id, Number(row.n)]));
  return projects.map((project) => ({
    ...project,
    artifact_count: byProject.get(project.id) ?? 0,
  }));
}
