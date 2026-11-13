import { z } from 'zod';
import type { DbBool, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { endShareLinkStreams } from '../domain/live.ts';
import { revokeShareLinksOf } from '../domain/shares.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { effectiveRole, type Role } from './roles.ts';

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
 * Sets, or with `null` clears, what an admin decided for a user's role, from the user's next
 * request on. `admin` and `member` replace the identity provider's role only while the IdP
 * admits the user (see `effectiveRole`); `blocked` always applies. Blocking also revokes
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
    // The links' artifacts and projects are held before the user row is written, as every revoke
    // takes them.
    const revoked =
      role === 'blocked'
        ? await revokeShareLinksOf(trx, dialect, deps.config.visibility, userId, deps.clock.now())
        : [];
    await trx.updateTable('users').set({ role_override: role }).where('id', '=', userId).execute();
    return revoked;
  });
  for (const linkId of linkIds) endShareLinkStreams(deps, linkId);
  return { user: { ...user, role_override: role }, shareLinks: linkIds.length };
}

/** What an admin may change about one person besides their role; a key left out stays. */
export interface ModerationPatch {
  /** Whether they may expose content (`PINWALL_SHARE_LINKS=approved`). */
  shareApproved?: boolean;
  /** Their own bytes limit (0: none); null gives the instance's back. */
  quotaBytes?: number | null;
  /** Their own artifacts limit (0: none); null gives the instance's back. */
  quotaArtifacts?: number | null;
}

/**
 * Applies `patch` to the user (404 `auth.userNotFound` for an unknown id), in one transaction.
 * Taking approval from someone who had it, while links need approval (`approved`), also revokes
 * every share link they made, unless they are an admin, whom approval never gated: the links are
 * revoked first, with their artifacts and projects held, and the user row is written after, as
 * `setRoleOverride` orders it. Their live streams end once the transaction commits. Returns the
 * user as changed, and how many share links were revoked.
 */
export async function updateUserModeration(
  deps: AppDeps,
  userId: string,
  patch: ModerationPatch,
): Promise<{ user: UserRow; shareLinks: number }> {
  const { db, dialect } = deps.db;
  const { user, linkIds } = await db.transaction().execute(async (trx) => {
    const before = await trx
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!before) throw notFound(t('auth.userNotFound'));
    const changes: {
      share_approved?: DbBool;
      quota_bytes?: number | null;
      quota_artifacts?: number | null;
    } = {};
    if (patch.shareApproved !== undefined) changes.share_approved = patch.shareApproved ? 1 : 0;
    if (patch.quotaBytes !== undefined) changes.quota_bytes = patch.quotaBytes;
    if (patch.quotaArtifacts !== undefined) changes.quota_artifacts = patch.quotaArtifacts;

    const withdrawn =
      patch.shareApproved === false &&
      before.share_approved === 1 &&
      deps.config.shareLinks === 'approved' &&
      effectiveRole(before) !== 'admin';
    const revoked = withdrawn
      ? await revokeShareLinksOf(trx, dialect, deps.config.visibility, userId, deps.clock.now())
      : [];
    if (Object.keys(changes).length > 0) {
      await trx.updateTable('users').set(changes).where('id', '=', userId).execute();
    }
    return { user: { ...before, ...changes }, linkIds: revoked };
  });
  for (const linkId of linkIds) endShareLinkStreams(deps, linkId);
  return { user, shareLinks: linkIds.length };
}

/**
 * Logs what an admin did, as one structured line: who, what, and the ids it touched, never a
 * token or a URL. Every admin moderation route calls it, so the log is the audit trail.
 */
export function logModeration(
  deps: AppDeps,
  adminId: string,
  action: string,
  target: Record<string, unknown>,
): void {
  deps.logger.info({ admin_id: adminId, action, target }, 'moderation');
}

/** The user with this id; 404 `auth.userNotFound` when there is none. */
export async function getUser(deps: AppDeps, userId: string): Promise<UserRow> {
  const user = await deps.db.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) throw notFound(t('auth.userNotFound'));
  return user;
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
