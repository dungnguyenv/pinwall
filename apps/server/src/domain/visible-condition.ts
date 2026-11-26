// What a scope sees, as SQL. Apart from `spaces.ts` and importing nothing but Kysely, so the
// database layer can use it (`searchQuery`) without loading the domain: Node loads the database
// modules by plain type stripping in the migrator child process of `test/db/migrate.test.ts`.
import { type RawBuilder, type SqlBool, sql } from 'kysely';
import type { Scope } from './spaces.ts';

/**
 * Whose projects marked `visible_to_everyone` everyone who signs in sees (`PINWALL_EVERYONE_PROJECTS`):
 * 'off', nobody's; 'any', those of any owner who has access; 'approved', those of an owner who
 * has access and may expose content (`mayExpose` under `PINWALL_SHARE_LINKS=approved`).
 */
export type EveryoneRule = 'off' | 'any' | 'approved';

/**
 * What `everyoneProjects` needs to read the rule at one moment: 'off', or the rule with the times
 * after which an IdP owner's last IdP check must fall to count as current (`idpAccessCurrent`),
 * for an owner who holds a refresh token and for one who does not.
 */
export type EveryoneSight =
  | 'off'
  | { rule: 'any' | 'approved'; checkedAfterWithRefresh: number; checkedAfterWithout: number };

/** The id of the person whose space limits `scope`, or null when it sees everything. */
export function personalViewer(scope: Scope): string | null {
  return scope.kind === 'viewer' && scope.visibility === 'personal' ? scope.user.id : null;
}

/**
 * The ids of the projects everyone who signs in may view under `sight`, as a subquery; null for
 * 'off'. A project counts while its owner chose so, it is not a default project (where agents
 * publish without naming a project), and its owner could still use Pinwall themselves, as a share
 * link's maker must: `hasAccess` and `idpAccessCurrent` and, for 'approved', `mayExpose`
 * (auth/roles.ts, auth/oidc/gate.ts, domain/exposure.ts), written out in SQL. A test holds the
 * two to the same answers for every kind of account (test/spaces/everyone.test.ts).
 */
export function everyoneProjects(sight: EveryoneSight): RawBuilder<{ id: string }> | null {
  if (sight === 'off') return null;
  // effectiveRole: the owner account is always an admin; anyone else needs a role from the IdP
  // and no 'blocked' override, and then the override, if any, replaces the IdP's role.
  const hasRole = sql`(everyone_owner.idp_role is not null and (everyone_owner.role_override is null or everyone_owner.role_override <> 'blocked'))`;
  // idpAccessCurrent: a check never made (null) is never current.
  const current = sql`((everyone_owner.idp_refresh_token is not null and everyone_owner.idp_checked_at > ${sight.checkedAfterWithRefresh}) or (everyone_owner.idp_refresh_token is null and everyone_owner.idp_checked_at > ${sight.checkedAfterWithout}))`;
  const isAdmin = sql`coalesce(everyone_owner.role_override, everyone_owner.idp_role) = 'admin'`;
  const standing =
    sight.rule === 'any'
      ? sql`(everyone_owner.kind = 'owner' or (${hasRole} and ${current}))`
      : sql`(everyone_owner.kind = 'owner' or (${hasRole} and ${current} and (${isAdmin} or everyone_owner.share_approved = 1)))`;
  return sql<{ id: string }>`select everyone_project.id from projects as everyone_project
    inner join users as everyone_owner on everyone_owner.id = everyone_project.owner_id
    where everyone_project.visible_to_everyone = 1 and everyone_project.is_default = 0
      and everyone_owner.disabled_at is null and ${standing}`;
}

/**
 * "The project in projectIdColumn is owned by or shared with the viewer, or visible to everyone";
 * null when seesAll. `IN` subqueries and no join, so it fits any query on a project id column,
 * under `FOR UPDATE` and inside raw SQL alike.
 */
export function visibleCondition(
  scope: Scope,
  projectIdColumn: string,
): RawBuilder<SqlBool> | null {
  const userId = personalViewer(scope);
  if (userId === null || scope.kind !== 'viewer') return null;
  const column = sql.ref(projectIdColumn);
  const owned = sql`select id from projects where owner_id = ${userId}`;
  const shared = sql`select project_id from project_members where user_id = ${userId}`;
  const everyone = everyoneProjects(scope.everyone);
  return everyone === null
    ? sql<SqlBool>`(${column} in (${owned}) or ${column} in (${shared}))`
    : sql<SqlBool>`(${column} in (${owned}) or ${column} in (${shared}) or ${column} in (${everyone}))`;
}
