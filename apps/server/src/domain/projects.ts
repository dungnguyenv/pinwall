import type { Updateable } from 'kysely';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import type { ProjectRow, ProjectsTable, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { newId } from '../lib/ids.ts';

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
  return getProject(deps.db.db, DEFAULT_PROJECT_ID);
}

export async function getProject(db: Db, id: string): Promise<ProjectRow> {
  const project = await db
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
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
 * is already archived keeps the time it was first archived. The default project cannot be
 * archived: it is where publishes without a project go.
 */
export function updateProject(
  deps: AppDeps,
  id: string,
  p: { name?: string; instructions?: string; archived?: boolean },
): Promise<ProjectRow> {
  return deps.db.db.transaction().execute(async (trx) => {
    const project = await getProject(trx, id);
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

/** Where the next page starts: after the project with `is_default` `d`, created at `c`, id `i`. */
const ProjectCursor = z.object({
  d: z.union([z.literal(0), z.literal(1)]),
  c: z.number().int(),
  i: z.string(),
});

/**
 * One page of the archived or the active projects: the default project first, then by creation
 * time, then by id, so a page boundary between two projects made in the same millisecond neither
 * repeats nor skips one.
 */
export async function listProjects(
  deps: AppDeps,
  p: { archived: boolean; limit: number; cursor: string | null },
): Promise<{ items: ProjectWithCount[]; nextCursor: string | null }> {
  const { db } = deps.db;
  let query = db
    .selectFrom('projects')
    .selectAll()
    .where('archived_at', p.archived ? 'is not' : 'is', null);
  if (p.cursor !== null) {
    const after = decodeCursor(p.cursor, ProjectCursor);
    query = query.where((eb) =>
      eb.or([
        eb('is_default', '<', after.d),
        eb.and([eb('is_default', '=', after.d), eb('created_at', '>', after.c)]),
        eb.and([
          eb('is_default', '=', after.d),
          eb('created_at', '=', after.c),
          eb('id', '>', after.i),
        ]),
      ]),
    );
  }
  const rows = await query
    .orderBy('is_default', 'desc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(p.limit + 1)
    .execute();
  const page = rows.slice(0, p.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > p.limit && last
      ? encodeCursor({ d: last.is_default, c: last.created_at, i: last.id })
      : null;
  return { items: await withArtifactCounts(db, page), nextCursor };
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
