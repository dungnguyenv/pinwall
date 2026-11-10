import type { Kysely } from 'kysely';
import type { Database, UserRow } from '../db/schema.ts';

/** The built-in owner account, or `undefined` while setup is still pending. */
export function getOwner(db: Kysely<Database>): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('kind', '=', 'owner').executeTakeFirst();
}

export async function ownerExists(db: Kysely<Database>): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('kind', '=', 'owner')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
