import { z } from 'zod';
import type { UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { endShareLinkStreams } from '../domain/live.ts';
import { revokeShareLinksOf } from '../domain/shares.ts';
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
 * identity provider's role and takes effect on the user's next request. Blocking also revokes
 * every share link the user made, in the same transaction (`revokeShareLinksOf`), and ends their
 * live streams once it commits: unblocking later does not bring them back. An admin cannot
 * change their own, and nobody can change the owner's: the owner is always an admin, so Pinwall
 * always has one way in. Returns the user as changed, and how many share links were revoked.
 */
export async function setRoleOverride(
  deps: AppDeps,
  actor: UserRow,
  userId: string,
  role: Role | 'blocked' | null,
): Promise<{ user: UserRow; shareLinks: number }> {
  if (actor.id === userId) throw forbidden(t('auth.ownRole'));
  const { db, dialect } = deps.db;
  const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!user) throw notFound(t('auth.userNotFound'));
  if (user.kind === 'owner') throw forbidden(t('auth.ownerRole'));
  const linkIds = await db.transaction().execute(async (trx) => {
    // The links' artifacts are held before the user row is written, as every revoke takes them.
    const revoked =
      role === 'blocked' ? await revokeShareLinksOf(trx, dialect, userId, deps.clock.now()) : [];
    await trx.updateTable('users').set({ role_override: role }).where('id', '=', userId).execute();
    return revoked;
  });
  for (const linkId of linkIds) endShareLinkStreams(deps, linkId);
  return { user: { ...user, role_override: role }, shareLinks: linkIds.length };
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
