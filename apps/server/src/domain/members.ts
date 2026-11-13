import type { ProjectMember } from '@pinwall/shared';
import type { Db } from '../auth/passkeys.ts';
import type { MemberRole, ProjectMemberRow, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { assertCan, lockProject, roleIn, type Scope, seesAll, type ViewerScope } from './spaces.ts';

/**
 * Members exist only in `personal` mode: any other scope (team mode, the system) gets the answer
 * of a missing project.
 */
function personalScope(scope: Scope): ViewerScope {
  if (scope.kind === 'viewer' && !seesAll(scope)) return scope;
  throw notFound(t('project.notFound'));
}

const notMember = () => notFound(t('spaces.members.notMember'));

/** The members of `projectId`, each with their account's name and email. */
function memberRows(db: Db, projectId: string) {
  return db
    .selectFrom('project_members')
    .innerJoin('users', 'users.id', 'project_members.user_id')
    .select([
      'project_members.user_id',
      'project_members.role',
      'project_members.created_at',
      'users.name',
      'users.email',
    ])
    .where('project_members.project_id', '=', projectId);
}

type MemberRow = Pick<ProjectMemberRow, 'user_id' | 'role' | 'created_at'> &
  Pick<UserRow, 'name' | 'email'>;

/** A member as the API shows them; only the owner's view carries their email. */
function toMember(row: MemberRow, ownersView: boolean): ProjectMember {
  return {
    user: { id: row.user_id, name: row.name, email: ownersView ? row.email : null },
    role: row.role,
    added_at: row.created_at,
  };
}

/**
 * The members of a project the viewer owns or is a member of, oldest first (then by user id),
 * without the owner. Only the owner sees their emails. A project the viewer does not see answers
 * 404, as a missing one does.
 */
export async function listMembers(
  deps: AppDeps,
  scope: Scope,
  projectId: string,
): Promise<ProjectMember[]> {
  const { db } = deps.db;
  const role = await roleIn(db, personalScope(scope), projectId);
  const rows = await memberRows(db, projectId)
    .orderBy('project_members.created_at')
    .orderBy('project_members.user_id')
    .execute();
  return rows.map((row) => toMember(row, role === 'owner'));
}

/**
 * The owner gives the member `userId` another role; giving the role they have changes nothing.
 * Returns the member in the owner's view. Someone who is not a member answers 404.
 */
export async function setMemberRole(
  deps: AppDeps,
  scope: Scope,
  projectId: string,
  userId: string,
  role: MemberRole,
): Promise<ProjectMember> {
  const { db, dialect } = deps.db;
  const viewer = personalScope(scope);
  assertCan(viewer, await roleIn(db, viewer, projectId), 'manageMembers');
  return db.transaction().execute(async (trx) => {
    await lockProject(trx, dialect, projectId);
    const row = await memberRows(trx, projectId)
      .where('project_members.user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) throw notMember();
    if (row.role !== role) {
      await trx
        .updateTable('project_members')
        .set({ role })
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .execute();
    }
    return toMember({ ...row, role }, true);
  });
}

/**
 * The owner removes `userId`, or a member removes themselves (leaves). Someone who is not a
 * member answers 404, and so does the owner leaving their own project.
 */
export async function removeMember(
  deps: AppDeps,
  scope: Scope,
  projectId: string,
  userId: string,
): Promise<void> {
  const { db, dialect } = deps.db;
  const viewer = personalScope(scope);
  const role = await roleIn(db, viewer, projectId);
  if (userId !== viewer.user.id) assertCan(viewer, role, 'manageMembers');
  await db.transaction().execute(async (trx) => {
    await lockProject(trx, dialect, projectId);
    const result = await trx
      .deleteFrom('project_members')
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) throw notMember();
  });
}
