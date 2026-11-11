import type { Updateable } from 'kysely';
import type { Db } from '../auth/passkeys.ts';
import type { ProjectRow, ProjectsTable, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
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
