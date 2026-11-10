import type { AuthContext } from '../app.ts';
import type { ApiTokenRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newId, newSecret } from '../lib/ids.ts';
import type { BearerResolver } from './resolve.ts';

/** Every API token secret starts with this; the bearer resolvers tell token kinds apart by it. */
export const API_TOKEN_PREFIX = 'pw_';
/** Tokens a user can hold at once, not counting revoked or expired ones. */
export const MAX_ACTIVE_TOKENS = 100;
/** `last_used_at` is rewritten at most this often, so busy clients do not write on every call. */
export const TOKEN_TOUCH_INTERVAL_MS = 60_000;

const DAY_MS = 86_400_000;
/** `pw_` and the first eight characters of the random part: enough to tell tokens apart. */
const PREFIX_CHARS = 11;

/**
 * Makes a token for `userId`. The secret is returned here and nowhere else: only its hash is
 * stored, so a database dump holds nothing that can be sent as a bearer token. `expiresInDays`
 * `null` makes a token that never expires.
 */
export async function createApiToken(
  deps: AppDeps,
  userId: string,
  p: { name: string; expiresInDays: number | null },
): Promise<{ row: ApiTokenRow; secret: string }> {
  const secret = `${API_TOKEN_PREFIX}${newSecret()}`;
  const now = deps.clock.now();
  const row: ApiTokenRow = {
    id: newId('tok'),
    user_id: userId,
    name: p.name,
    token_hash: hashSecret(secret),
    prefix: secret.slice(0, PREFIX_CHARS),
    created_at: now,
    last_used_at: null,
    expires_at: p.expiresInDays === null ? null : now + p.expiresInDays * DAY_MS,
    revoked_at: null,
  };
  // Count and insert together: on SQLite writers take turns, so the limit holds exactly there.
  await deps.db.db.transaction().execute(async (trx) => {
    const active = await trx
      .selectFrom('api_tokens')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .executeTakeFirstOrThrow();
    if (Number(active.n) >= MAX_ACTIVE_TOKENS) {
      throw conflict(t('auth.tokenLimit', { max: MAX_ACTIVE_TOKENS }));
    }
    await trx.insertInto('api_tokens').values(row).execute();
  });
  return { row, secret };
}

/** The user's tokens that are not revoked, newest first. Expired ones stay until revoked. */
export function listApiTokens(deps: AppDeps, userId: string): Promise<ApiTokenRow[]> {
  return deps.db.db
    .selectFrom('api_tokens')
    .selectAll()
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}

/**
 * Revokes one of the user's tokens at once. A token that is not theirs, does not exist or was
 * revoked already is `not_found`, so a caller learns nothing about other users' tokens.
 */
export async function revokeApiToken(
  deps: AppDeps,
  userId: string,
  tokenId: string,
): Promise<void> {
  const result = await deps.db.db
    .updateTable('api_tokens')
    .set({ revoked_at: deps.clock.now() })
    .where('id', '=', tokenId)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) throw notFound(t('auth.tokenNotFound'));
}

/**
 * Bearer tokens that start with `pw_`. Whether the user may use Pinwall at all is the caller's
 * check (`resolveAuth`), so a blocked user's token resolves and is then refused as
 * `access_denied`.
 */
export const apiTokenResolver: BearerResolver = {
  name: 'api_token',
  matches: (token) => token.startsWith(API_TOKEN_PREFIX),
  async resolve(deps, token): Promise<AuthContext | null> {
    const { db } = deps.db;
    const found = await db
      .selectFrom('api_tokens')
      .selectAll()
      .where('token_hash', '=', hashSecret(token))
      .executeTakeFirst();
    if (!found || found.revoked_at !== null) return null;
    const now = deps.clock.now();
    if (found.expires_at !== null && found.expires_at <= now) return null;
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', found.user_id)
      .executeTakeFirst();
    if (!user) return null;

    if (found.last_used_at === null || now - found.last_used_at >= TOKEN_TOUCH_INTERVAL_MS) {
      const touched = await db
        .updateTable('api_tokens')
        .set({ last_used_at: now })
        .where('id', '=', found.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      // Revoked by a request that ran in between: do not let this one through.
      if (touched.numUpdatedRows === 0n) return null;
      await db.updateTable('users').set({ last_seen_at: now }).where('id', '=', user.id).execute();
      return { user: { ...user, last_seen_at: now }, via: 'api_token' };
    }
    return { user, via: 'api_token' };
  },
};
