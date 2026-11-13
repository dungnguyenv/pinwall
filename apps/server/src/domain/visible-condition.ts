// What a scope sees, as SQL. Apart from `spaces.ts` and importing nothing but Kysely, so the
// database layer can use it (`searchQuery`) without loading the domain: Node loads the database
// modules by plain type stripping in the migrator child process of `test/db/migrate.test.ts`.
import { type RawBuilder, type SqlBool, sql } from 'kysely';
import type { Scope } from './spaces.ts';

/** The id of the person whose space limits `scope`, or null when it sees everything. */
export function personalViewer(scope: Scope): string | null {
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
