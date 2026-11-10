import type { SessionRow, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { hashSecret, newSecret } from '../lib/ids.ts';

/** How a browser session was signed in. */
export type AuthMethod = 'password' | 'passkey'; // M3 adds 'oidc'

/** A session is renewed (expiry moved, cookie re-sent) at most this often. */
export const SESSION_TOUCH_INTERVAL_MS = 300_000;

const USER_AGENT_MAX_CHARS = 512;

/**
 * Stores a new session for `userId` and returns its secret, the cookie value. Only the secret's
 * hash is kept, so a database dump cannot be replayed as cookies.
 */
export async function createSession(
  deps: AppDeps,
  userId: string,
  method: AuthMethod,
  meta: { ip: string; userAgent: string | null },
): Promise<{ secret: string; idHash: string; expiresAt: number }> {
  const secret = newSecret();
  const idHash = hashSecret(secret);
  const now = deps.clock.now();
  const expiresAt = now + deps.config.ttl.sessionMs;
  await deps.db.db
    .insertInto('sessions')
    .values({
      id_hash: idHash,
      user_id: userId,
      auth_method: method,
      created_at: now,
      expires_at: expiresAt,
      last_seen_at: now,
      ip: meta.ip,
      user_agent: meta.userAgent?.slice(0, USER_AGENT_MAX_CHARS) ?? null,
    })
    .execute();
  return { secret, idHash, expiresAt };
}

/**
 * The live session for a cookie secret, with its user, or `null`. An expired session is deleted.
 * Sliding expiry: once `SESSION_TOUCH_INTERVAL_MS` has passed since the session was last seen,
 * its expiry moves to a full TTL from now and `refreshed` tells the caller to re-send the cookie.
 * Access is not checked here; that is `resolveAuth`'s job.
 */
export async function resolveSession(
  deps: AppDeps,
  secret: string,
): Promise<{ session: SessionRow; user: UserRow; refreshed: boolean } | null> {
  const { db } = deps.db;
  const idHash = hashSecret(secret);
  const session = await db
    .selectFrom('sessions')
    .selectAll()
    .where('id_hash', '=', idHash)
    .executeTakeFirst();
  if (!session) return null;

  const now = deps.clock.now();
  if (session.expires_at <= now) {
    await deleteSession(deps, idHash);
    return null;
  }
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', session.user_id)
    .executeTakeFirst();
  if (!user) return null;

  if (now - session.last_seen_at < SESSION_TOUCH_INTERVAL_MS) {
    return { session, user, refreshed: false };
  }
  // M3's inline IdP re-check rides on these renewals, in resolveAuth's session branch.
  const expiresAt = now + deps.config.ttl.sessionMs;
  const touched = await db
    .updateTable('sessions')
    .set({ last_seen_at: now, expires_at: expiresAt })
    .where('id_hash', '=', idHash)
    .executeTakeFirst();
  // Signed out (or revoked) by a request that ran in between: do not hand the cookie back.
  if (touched.numUpdatedRows === 0n) return null;
  await db.updateTable('users').set({ last_seen_at: now }).where('id', '=', user.id).execute();
  return {
    session: { ...session, last_seen_at: now, expires_at: expiresAt },
    user: { ...user, last_seen_at: now },
    refreshed: true,
  };
}

export async function deleteSession(deps: AppDeps, idHash: string): Promise<void> {
  await deps.db.db.deleteFrom('sessions').where('id_hash', '=', idHash).execute();
}

/** Ends every session of the user, except `exceptIdHash` when given; returns how many ended. */
export async function deleteUserSessions(
  deps: AppDeps,
  userId: string,
  opts: { exceptIdHash?: string } = {},
): Promise<number> {
  let query = deps.db.db.deleteFrom('sessions').where('user_id', '=', userId);
  if (opts.exceptIdHash !== undefined) query = query.where('id_hash', '!=', opts.exceptIdHash);
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** Deletes sessions whose expiry has passed; returns how many. */
export async function purgeExpiredSessions(deps: AppDeps): Promise<number> {
  const result = await deps.db.db
    .deleteFrom('sessions')
    .where('expires_at', '<=', deps.clock.now())
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
