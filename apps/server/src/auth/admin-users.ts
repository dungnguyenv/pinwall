import { z } from 'zod';
import type { UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import type { Role } from './roles.ts';

/** Where the next page starts: just after the user created at `c` with id `i`. */
const UserCursor = z.object({ c: z.number().int(), i: z.string() });

/**
 * One page of users, oldest first. Ties on `created_at` break by id, so a page boundary between
 * two users made in the same millisecond neither repeats nor skips one.
 */
export async function listUsers(
  deps: AppDeps,
  p: { limit: number; cursor: string | null },
): Promise<{ items: UserRow[]; nextCursor: string | null }> {
  let query = deps.db.db.selectFrom('users').selectAll();
  if (p.cursor !== null) {
    const after = decodeCursor(p.cursor, UserCursor);
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '>', after.c),
        eb.and([eb('created_at', '=', after.c), eb('id', '>', after.i)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(p.limit + 1)
    .execute();
  const items = rows.slice(0, p.limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > p.limit && last ? encodeCursor({ c: last.created_at, i: last.id }) : null;
  return { items, nextCursor };
}

/**
 * Sets, or with `null` clears, what an admin decided for a user's role. It wins over the
 * identity provider's role and takes effect on the user's next request. An admin cannot change
 * their own, so no one locks themselves out or leaves Pinwall without an admin.
 */
export async function setRoleOverride(
  deps: AppDeps,
  actor: UserRow,
  userId: string,
  role: Role | 'blocked' | null,
): Promise<UserRow> {
  if (actor.id === userId) throw forbidden(t('auth.ownRole'));
  const { db } = deps.db;
  const result = await db
    .updateTable('users')
    .set({ role_override: role })
    .where('id', '=', userId)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) throw notFound(t('auth.userNotFound'));
  return db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
}

/** Whether a user with this id exists. */
export async function userExists(deps: AppDeps, userId: string): Promise<boolean> {
  const row = await deps.db.db
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row !== undefined;
}
