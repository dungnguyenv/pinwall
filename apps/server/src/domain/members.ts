import type { MemberCandidate, ProjectMember } from '@pinwall/shared';
import type { Db } from '../auth/passkeys.ts';
import { hasAccess } from '../auth/roles.ts';
import type { MemberRole, ProjectMemberRow, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
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

/**
 * Active users (hasAccess) whose email equals `email` ignoring letter case: the owner account,
 * and OIDC accounts with a verified email. Oldest first (created_at, id). Both sides go through
 * the database's `lower`, which on SQLite folds ASCII letters only.
 */
export async function findUsersByEmail(db: Db, email: string): Promise<UserRow[]> {
  const rows = await db
    .selectFrom('users')
    .selectAll()
    .where((eb) => eb(eb.fn('lower', ['email']), '=', eb.fn('lower', [eb.val(email)])))
    .where((eb) => eb.or([eb('kind', '=', 'owner'), eb('email_verified', '=', 1)]))
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.filter(hasAccess);
}

const noAccount = () => notFound(t('spaces.members.noAccount'), { field: 'email' });

const candidate = (user: UserRow): MemberCandidate => ({
  user_id: user.id,
  name: user.name,
  kind: user.kind,
});

/**
 * The account to add among `matches`: the one `userId` names, else the only one. None (or a
 * `userId` that is not among them) answers like an unknown email; several without a `userId`
 * answer 409 with every match as a candidate.
 */
function pickAccount(matches: UserRow[], userId: string | null): UserRow {
  if (userId !== null) {
    const picked = matches.find((user) => user.id === userId);
    if (picked === undefined) throw noAccount();
    return picked;
  }
  const [only, ...others] = matches;
  if (only === undefined) throw noAccount();
  if (others.length > 0) {
    throw conflict(t('spaces.members.severalAccounts'), {
      reason: 'several_accounts',
      candidates: matches.map(candidate),
    });
  }
  return only;
}

/**
 * The owner lets the person with `email` into the project with `role`. The accounts are looked
 * up only once the viewer is known to be the owner: anyone else learns nothing about emails.
 * When several accounts use the email, `userId` picks one of them. Returns the new member in the
 * owner's view.
 */
export async function addMember(
  deps: AppDeps,
  scope: Scope,
  projectId: string,
  p: { email: string; role: MemberRole; userId: string | null },
): Promise<ProjectMember> {
  const { db, dialect } = deps.db;
  const viewer = personalScope(scope);
  assertCan(viewer, await roleIn(db, viewer, projectId), 'manageMembers');
  const user = pickAccount(await findUsersByEmail(db, p.email), p.userId);
  if (user.id === viewer.user.id) throw badRequest(t('spaces.members.self'), { field: 'email' });

  const now = deps.clock.now();
  await db.transaction().execute(async (trx) => {
    await lockProject(trx, dialect, projectId);
    const existing = await trx
      .selectFrom('project_members')
      .select('user_id')
      .where('project_id', '=', projectId)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw conflict(t('spaces.members.already'), { reason: 'already_member' });
    }
    await trx
      .insertInto('project_members')
      .values({
        project_id: projectId,
        user_id: user.id,
        role: p.role,
        added_by: viewer.user.id,
        created_at: now,
      })
      .execute();
  });
  const row = {
    user_id: user.id,
    role: p.role,
    created_at: now,
    name: user.name,
    email: user.email,
  };
  return toMember(row, true);
}
