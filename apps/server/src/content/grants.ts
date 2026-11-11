import { idpAccessDeadline } from '../auth/oidc/gate.ts';
import type { Db } from '../auth/passkeys.ts';
import { hasAccess } from '../auth/roles.ts';
import type { Config } from '../config/types.ts';
import type { ContentGrantMode, ContentGrantRow, UserRow, VersionRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { addTombstones, isTombstoned } from '../domain/tombstones.ts';
import { gone, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { newContentToken } from '../lib/ids.ts';

/** `review` grants feed the review frame (M5 adds the annotator); `raw` ones serve bytes as stored. */
export type GrantMode = ContentGrantMode;

/** What `newContentToken` makes: 32 lowercase Crockford base32 characters, a valid DNS label. */
const CONTENT_TOKEN = /^[0-9a-hjkmnp-tv-z]{32}$/;

export function isContentToken(value: string): boolean {
  return CONTENT_TOKEN.test(value);
}

/**
 * Issues a capability to read one version's files. It lasts `ttlMs` (default
 * `PINWALL_PREVIEW_TTL`), and never past the moment `user`'s IdP access stops being current, so
 * a grant cannot outlive the access of the person it was made for. It records `user`, so it
 * serves only while they have access and "Revoke now" ends it. `user` is null only when no
 * signed-in person asked for it (a share link's guest).
 */
export async function createGrant(
  deps: AppDeps,
  p: {
    versionId: string;
    mode: GrantMode;
    user: UserRow | null;
    shareLinkId?: string | null;
    ttlMs?: number;
  },
): Promise<ContentGrantRow> {
  const now = deps.clock.now();
  const ttlEnd = now + (p.ttlMs ?? deps.config.ttl.previewMs);
  const accessEnd = p.user === null ? null : idpAccessDeadline(p.user, deps.config);
  const grant: ContentGrantRow = {
    token: newContentToken(),
    version_id: p.versionId,
    mode: p.mode,
    share_link_id: p.shareLinkId ?? null,
    user_id: p.user?.id ?? null,
    created_at: now,
    expires_at: accessEnd === null ? ttlEnd : Math.min(ttlEnd, accessEnd),
  };
  await deps.db.db.insertInto('content_grants').values(grant).execute();
  return grant;
}

/**
 * Where a grant's files live in the current isolation mode: under `/c/<token>/` on the app
 * origin, or at the root of `<token>.<content host>`. Built per request and never handed out as
 * a permanent link: people hold app links, which mint grants.
 */
export function contentBaseUrl(config: Config, token: string): string {
  const { isolation } = config;
  if (isolation.mode === 'single-domain') return `${config.publicOrigin}/c/${token}/`;
  const { scheme, host, port } = isolation.contentOrigin;
  return `${scheme}://${token}.${host}${port === undefined ? '' : `:${port}`}/`;
}

/** The URL of the stored `path` inside a grant, each segment percent-encoded. */
export function contentUrl(config: Config, token: string, path = ''): string {
  const encoded = path === '' ? '' : path.split('/').map(encodeURIComponent).join('/');
  return contentBaseUrl(config, token) + encoded;
}

export interface ResolvedGrant {
  grant: ContentGrantRow;
  version: VersionRow;
}

/**
 * The grant `token` names and its version. A token never issued answers 404; one whose grant or
 * version was deleted or revoked (tombstoned) 410; an expired one 410 with `details.expired`; one
 * made for a person who has no access now (blocked, disabled) 410 as well.
 */
export async function resolveGrant(deps: AppDeps, token: string): Promise<ResolvedGrant> {
  const { db } = deps.db;
  const now = deps.clock.now();
  // Nothing else was ever issued, so anything else needs no query.
  if (!isContentToken(token)) throw notFound(t('content.notFound.message'));
  const grant = await db
    .selectFrom('content_grants')
    .selectAll()
    .where('token', '=', token)
    .executeTakeFirst();
  if (grant === undefined) {
    if (await isTombstoned(db, 'content_grant', token, now)) throw gone(t('content.gone.message'));
    throw notFound(t('content.notFound.message'));
  }
  if (grant.expires_at <= now) throw gone(t('content.expired.message'), { expired: true });
  if (grant.user_id !== null) {
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', grant.user_id)
      .executeTakeFirst();
    // A deleted user takes their grants along; this is a read that raced the delete.
    if (user === undefined || !hasAccess(user)) throw gone(t('content.gone.message'));
  }
  const version = await db
    .selectFrom('versions')
    .selectAll()
    .where('id', '=', grant.version_id)
    .executeTakeFirst();
  // Deleting a version deletes its grants with it; this is a read that raced the delete.
  if (version === undefined) throw gone(t('content.gone.message'));
  return { grant, version };
}

/**
 * Ends every grant made for `userId` ("Revoke now"): deletes them, and tombstones those still
 * live until they would have expired, so they answer 410 rather than 404. Pass the transaction
 * that revokes the rest of the user's credentials. Returns how many grants were deleted.
 */
export async function revokeUserGrants(db: Db, userId: string, now: number): Promise<number> {
  const live = await db
    .selectFrom('content_grants')
    .select(['token', 'expires_at'])
    .where('user_id', '=', userId)
    .where('expires_at', '>', now)
    .execute();
  await addTombstones(
    db,
    live.map((grant) => ({ kind: 'content_grant', key: grant.token, expiresAt: grant.expires_at })),
    now,
  );
  const deleted = await db
    .deleteFrom('content_grants')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return Number(deleted.numDeletedRows);
}

/** Deletes the grants that have expired; returns how many. */
export async function purgeExpiredGrants(deps: AppDeps): Promise<number> {
  const result = await deps.db.db
    .deleteFrom('content_grants')
    .where('expires_at', '<=', deps.clock.now())
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
