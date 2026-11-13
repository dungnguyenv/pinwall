import type { Context } from 'hono';
import { type Expression, type RawBuilder, type SqlBool, sql } from 'kysely';
import type { AppEnv } from '../app.ts';
import { authOf } from '../auth/guards.ts';
import type { Db } from '../auth/passkeys.ts';
import { effectiveRole } from '../auth/roles.ts';
import type { Visibility } from '../config/types.ts';
import type { MemberRole, ProjectRow, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { type AppError, forbidden, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { newId } from '../lib/ids.ts';
import { ensureDefaultProject } from './projects.ts';

/** What someone is to a project they can see. */
export type ProjectRole = 'owner' | MemberRole;

/** Whose view a lookup serves: a signed-in person, in the instance's visibility mode. */
export type ViewerScope = { kind: 'viewer'; user: UserRow; visibility: Visibility; admin: boolean };

/** A viewer, or the system: Pinwall itself, which sees every project. */
export type Scope = ViewerScope | { kind: 'system' };

/**
 * Access without a viewer. Only the files `test/spaces/scope-guard.test.ts` allows may use it,
 * each bound to something else that grants access (a share link) or serving the whole instance.
 */
export const SYSTEM_SCOPE: Scope = Object.freeze({ kind: 'system' });

/**
 * `user`'s scope in the instance's mode: for callers without a request (MCP tools, upload URLs,
 * live streams) and for functions handed the acting person.
 */
export function scopeForUser(deps: AppDeps, user: UserRow): ViewerScope {
  return {
    kind: 'viewer',
    user,
    visibility: deps.config.visibility,
    admin: effectiveRole(user) === 'admin',
  };
}

/** The scope of the person making the request (401 when nobody is signed in). */
export function scopeOf(c: Context<AppEnv>): ViewerScope {
  return scopeForUser(c.var.deps, authOf(c).user);
}

/** Team mode or SYSTEM_SCOPE: no condition, every role 'owner', the 1.0 rules. */
export function seesAll(scope: Scope): boolean {
  return personalViewer(scope) === null;
}

/** The id of the person whose space limits `scope`, or null when it sees everything. */
function personalViewer(scope: Scope): string | null {
  return scope.kind === 'viewer' && scope.visibility === 'personal' ? scope.user.id : null;
}

/**
 * "The project in projectIdColumn is owned by or shared with the viewer"; null when seesAll.
 * Two `IN` subqueries and no join, so it fits any query on a project id column, under
 * `FOR UPDATE` and inside raw SQL alike.
 */
export function visibleCondition(
  scope: Scope,
  projectIdColumn: string,
): RawBuilder<SqlBool> | null {
  const userId = personalViewer(scope);
  if (userId === null) return null;
  const column = sql.ref(projectIdColumn);
  const owned = sql`select id from projects where owner_id = ${userId}`;
  const shared = sql`select project_id from project_members where user_id = ${userId}`;
  return sql<SqlBool>`(${column} in (${owned}) or ${column} in (${shared}))`;
}

/** `qb` limited to what the viewer may see, or `qb` itself when the scope sees everything. */
export function whereVisible<QB extends { where(e: Expression<SqlBool>): QB }>(
  qb: QB,
  scope: Scope,
  projectIdColumn: string,
): QB {
  const condition = visibleCondition(scope, projectIdColumn);
  return condition === null ? qb : qb.where(condition);
}

/** The role in a project row read together with the viewer's membership, or null for none. */
function roleFrom(
  row: { owner_id: string | null; member_role: MemberRole | null },
  userId: string,
): ProjectRole | null {
  return row.owner_id === userId ? 'owner' : row.member_role;
}

/** Projects, each with the viewer's membership role in it (null when not a member). */
function projectsWithMembership(db: Db, userId: string) {
  return db
    .selectFrom('projects')
    .leftJoin('project_members', (join) =>
      join
        .onRef('project_members.project_id', '=', 'projects.id')
        .on('project_members.user_id', '=', userId),
    )
    .select(['projects.id', 'projects.owner_id', 'project_members.role as member_role']);
}

/**
 * The viewer's role in a project they can see. A project they cannot see answers as a missing
 * one: 404 `project.notFound`. Team mode and the system: 'owner', without a query.
 */
export async function roleIn(db: Db, scope: Scope, projectId: string): Promise<ProjectRole> {
  const userId = personalViewer(scope);
  if (userId === null) return 'owner';
  const row = await projectsWithMembership(db, userId)
    .where('projects.id', '=', projectId)
    .executeTakeFirst();
  const role = row === undefined ? null : roleFrom(row, userId);
  if (role === null) throw notFound(t('project.notFound'));
  return role;
}

/**
 * The viewer's role in each of `projectIds` they can see; the others are left out. Team mode and
 * the system: 'owner' for each, without a query.
 */
export async function rolesIn(
  db: Db,
  scope: Scope,
  projectIds: readonly string[],
): Promise<Map<string, ProjectRole>> {
  const userId = personalViewer(scope);
  if (userId === null) return new Map(projectIds.map((id) => [id, 'owner']));
  if (projectIds.length === 0) return new Map();
  const rows = await projectsWithMembership(db, userId)
    .where('projects.id', 'in', projectIds)
    .execute();
  const roles = new Map<string, ProjectRole>();
  for (const row of rows) {
    const role = roleFrom(row, userId);
    if (role !== null) roles.set(row.id, role);
  }
  return roles;
}

export type SpaceAction =
  | 'comment'
  | 'publish'
  | 'editArtifact'
  | 'deleteArtifact'
  | 'deleteOthersComment'
  | 'createShareLink'
  | 'revokeShareLink'
  | 'manageProject'
  | 'manageMembers';

/** 'own': only on what the person published (an artifact or version) or made (a link). */
type Allowed = 'yes' | 'own' | 'no';

/** Spec §4.3: what each role may change in a project it sees, in `personal` mode. */
const ALLOWED: Record<SpaceAction, Record<ProjectRole, Allowed>> = {
  comment: { owner: 'yes', editor: 'yes', viewer: 'yes' },
  publish: { owner: 'yes', editor: 'yes', viewer: 'no' },
  editArtifact: { owner: 'yes', editor: 'own', viewer: 'no' },
  deleteArtifact: { owner: 'yes', editor: 'own', viewer: 'no' },
  deleteOthersComment: { owner: 'yes', editor: 'no', viewer: 'no' },
  createShareLink: { owner: 'yes', editor: 'yes', viewer: 'no' },
  revokeShareLink: { owner: 'yes', editor: 'own', viewer: 'no' },
  manageProject: { owner: 'yes', editor: 'no', viewer: 'no' },
  manageMembers: { owner: 'yes', editor: 'no', viewer: 'no' },
};

/**
 * Whether `role` may do `action`. Where only their own work counts, `ctx` says who published
 * (or made) it and who asks.
 */
export function can(
  role: ProjectRole,
  action: SpaceAction,
  ctx: { publishedBy?: string | null; userId?: string } = {},
): boolean {
  const allowed = ALLOWED[action][role];
  if (allowed !== 'own') return allowed === 'yes';
  return typeof ctx.publishedBy === 'string' && ctx.publishedBy === ctx.userId;
}

/** 403 for a role that sees the project but may not do `action` in it. */
export function forbiddenRole(action: SpaceAction): AppError {
  return forbidden(t(`spaces.role.${action}`), { reason: 'role' });
}

/**
 * seesAll: returns (the module's 1.0 rule applies); personal: throws forbiddenRole(action) unless
 * can().
 */
export function assertCan(
  scope: Scope,
  role: ProjectRole,
  action: SpaceAction,
  ctx?: { publishedBy?: string | null; userId?: string },
): void {
  if (seesAll(scope)) return;
  if (!can(role, action, ctx)) throw forbiddenRole(action);
}

/** The oldest is_default = 1 project (created_at, id): team mode's shared default. */
export async function teamDefaultProject(db: Db): Promise<ProjectRow | undefined> {
  return db
    .selectFrom('projects')
    .selectAll()
    .where('is_default', '=', 1)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
}

/** `userId`'s own default project, if they have one (at most one, by a unique index). */
function ownDefaultProject(db: Db, userId: string): Promise<ProjectRow | undefined> {
  return db
    .selectFrom('projects')
    .selectAll()
    .where('owner_id', '=', userId)
    .where('is_default', '=', 1)
    .executeTakeFirst();
}

/**
 * Gives `userId` the oldest default project that nobody owns and that holds no artifact (the
 * 1.0 default on a fresh instance), unless someone takes it first or they have a default already.
 * Returns it, or undefined when there was none to take.
 */
async function adoptDefaultProject(db: Db, userId: string): Promise<ProjectRow | undefined> {
  const candidate = await db
    .selectFrom('projects')
    .selectAll()
    .where('is_default', '=', 1)
    .where('owner_id', 'is', null)
    .where(({ exists, not, selectFrom }) =>
      not(
        exists(
          selectFrom('artifacts')
            .select('artifacts.id')
            .whereRef('artifacts.project_id', '=', 'projects.id'),
        ),
      ),
    )
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (candidate === undefined) return undefined;
  const result = await db
    .updateTable('projects')
    .set({ owner_id: userId })
    .where('id', '=', candidate.id)
    .where('owner_id', 'is', null)
    // A default another call made for them meanwhile: one default per owner.
    .where(({ exists, not, selectFrom }) =>
      not(
        exists(
          selectFrom('projects as own')
            .select('own.id')
            .where('own.owner_id', '=', userId)
            .where('own.is_default', '=', 1),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1 ? { ...candidate, owner_id: userId } : undefined;
}

/**
 * The project a publish without a project goes to, and the library's first. Team mode and the
 * system: the shared default, created when there is none. A personal viewer: their own, else
 * the unowned default of a fresh instance if it is still empty, else a new one. Safe to call at
 * the same time for one person: they still end up with one.
 */
export async function defaultProjectFor(deps: AppDeps, scope: Scope): Promise<ProjectRow> {
  const { db } = deps.db;
  const userId = personalViewer(scope);
  if (userId === null) return (await teamDefaultProject(db)) ?? ensureDefaultProject(deps);

  const own = await ownDefaultProject(db, userId);
  if (own !== undefined) return own;
  const adopted = await adoptDefaultProject(db, userId);
  if (adopted !== undefined) return adopted;

  const now = deps.clock.now();
  await db
    .insertInto('projects')
    .values({
      id: newId('prj'),
      name: t('project.defaultName'),
      instructions: '',
      is_default: 1,
      archived_at: null,
      owner_id: userId,
      created_by: userId,
      created_at: now,
      updated_at: now,
    })
    // Another call for the same person may have made or adopted one first: then it is theirs.
    // The target names the partial unique index by its predicate, which must be the literal 1:
    // a bound parameter matches no index on SQLite.
    .onConflict((oc) => oc.column('owner_id').where('is_default', '=', sql.lit(1)).doNothing())
    .execute();
  const made = await ownDefaultProject(db, userId);
  if (made === undefined) throw new Error(`No default project for ${userId} after creating one`);
  return made;
}
