import type { UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { purgeArtifactOf } from './deletion.ts';
import { SYSTEM_SCOPE, type SystemScope } from './spaces.ts';

/** How many times a purge goes over a project: once, and again for each publish that slipped in. */
const MAX_PASSES = 3;

/**
 * Deletes every project `userId` owns, each of its artifacts as `systemDeleteArtifact` deletes
 * one (links answer "gone", blobs are collected), then the project. Never deletes the user, and
 * never touches a project they only belong to: each artifact's deletion checks, with its project
 * held, that the project is still theirs, so what a transfer moved meanwhile is left to its new
 * owner. Returns how many projects and artifacts it removed. Personal mode only (404 otherwise,
 * as `assertPurgeAvailable` answers).
 *
 * A project goes only while it holds no artifact, so a publish that lands between the last
 * artifact's deletion and the project's does not make the project take it unseen: the project
 * stays, and the artifact is deleted on another pass, up to `MAX_PASSES` in all. After that
 * (`purge.busy`, 409) the purge stops; what it already deleted stays deleted, and running it
 * again finishes the job.
 */
export async function purgeSpace(
  deps: AppDeps,
  scope: SystemScope,
  userId: string,
): Promise<{ projects: number; artifacts: number }> {
  assertPurgeAvailable(deps);
  const { db } = deps.db;
  const owned = await db
    .selectFrom('projects')
    .select('id')
    .where('owner_id', '=', userId)
    .orderBy('id')
    .execute();
  let artifacts = 0;
  let projects = 0;
  for (const { id: projectId } of owned) {
    for (let pass = 1; ; pass++) {
      // Gone, or moved to someone else, since the list was read: not this person's to delete.
      if (!(await isOwnedBy(deps, projectId, userId))) break;
      artifacts += await deleteArtifactsOf(deps, scope, projectId, userId);
      if (await deleteEmptyProject(deps, projectId, userId)) {
        projects++;
        break;
      }
      if (pass === MAX_PASSES) throw conflict(t('purge.busy'));
    }
  }
  return { projects, artifacts };
}

async function isOwnedBy(deps: AppDeps, projectId: string, userId: string): Promise<boolean> {
  const row = await deps.db.db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projectId)
    .where('owner_id', '=', userId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Deletes the artifacts the project holds now while it still belongs to `ownerId`; returns how
 * many it deleted itself.
 */
async function deleteArtifactsOf(
  deps: AppDeps,
  scope: SystemScope,
  projectId: string,
  ownerId: string,
): Promise<number> {
  const rows = await deps.db.db
    .selectFrom('artifacts')
    .select('id')
    .where('project_id', '=', projectId)
    .orderBy('id')
    .execute();
  let deleted = 0;
  for (const { id } of rows) {
    try {
      if (await purgeArtifactOf(deps, scope, id, ownerId)) deleted++;
    } catch (err) {
      // Someone deleted it first: it is gone either way.
      if (!(err instanceof AppError && (err.status === 404 || err.status === 410))) throw err;
    }
  }
  return deleted;
}

/**
 * Deletes the project if `ownerId` still owns it and it holds no artifact; false when it did not.
 * An artifact whose publish was committing at that moment also refuses the delete, as a foreign
 * key violation on PostgreSQL: it counts as one that slipped in.
 */
async function deleteEmptyProject(
  deps: AppDeps,
  projectId: string,
  ownerId: string,
): Promise<boolean> {
  try {
    const result = await deps.db.db
      .deleteFrom('projects')
      .where('id', '=', projectId)
      .where('owner_id', '=', ownerId)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('artifacts')
              .select('artifacts.id')
              .whereRef('artifacts.project_id', '=', 'projects.id'),
          ),
        ),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows) === 1;
  } catch (err) {
    if (isForeignKeyViolation(err)) return false;
    throw err;
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  // PostgreSQL's foreign_key_violation, and SQLite's.
  return code === '23503' || code === 'SQLITE_CONSTRAINT_FOREIGNKEY';
}

/**
 * A person's purge of their own space (`/me/purge`): `purgeSpace` bound to `user`'s own id, so
 * the route that asks for it holds no system scope of its own.
 */
export function purgeOwnSpace(
  deps: AppDeps,
  user: UserRow,
): Promise<{ projects: number; artifacts: number }> {
  return purgeSpace(deps, SYSTEM_SCOPE, user.id);
}

/**
 * Purging needs projects that belong to people, which only `personal` mode has: anywhere else it
 * answers 404 with the message of a route that does not exist. The purge routes refuse earlier,
 * before authentication (`personalOnly`); this keeps the domain safe on its own.
 */
function assertPurgeAvailable(deps: AppDeps): void {
  if (deps.config.visibility !== 'personal') throw notFound(t('error.notFound.message'));
}

/**
 * 400 `bad_request` (details `{ field: 'confirm_email' }`) unless `typed`, trimmed, is the user's
 * email address, in any letter case; a user without an email types their id.
 */
export function assertPurgeConfirmed(user: UserRow, typed: string): void {
  const expected = user.email === null || user.email === '' ? user.id : user.email;
  if (typed.trim().toLowerCase() === expected.toLowerCase()) return;
  throw badRequest(t('purge.confirm'), { field: 'confirm_email' });
}
