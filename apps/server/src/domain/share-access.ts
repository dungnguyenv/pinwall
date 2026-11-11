import { createHmac } from 'node:crypto';
import type { ShareInfo } from '@pinwall/shared';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Transaction } from 'kysely';
import type { AppEnv } from '../app.ts';
import { normalizePassword } from '../auth/password.ts';
import { enforceRateLimit, type RateRule } from '../auth/rate-limits.ts';
import type { Config } from '../config/types.ts';
import { contentUrl, createGrant, type GrantMode } from '../content/grants.ts';
import type { DbDialect } from '../db/connect.ts';
import type {
  ArtifactRow,
  ContentGrantRow,
  Database,
  ShareLinkRow,
  VersionRow,
} from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { clientIp } from '../http/client-ip.ts';
import { deriveKey, safeEqual, verifyPassword } from '../lib/crypto.ts';
import { AppError, conflict, forbidden, gone, notFound, unauthorized } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret } from '../lib/ids.ts';
import { entryKind } from '../publish/paths.ts';
import { shareOriginalUrl } from './shares.ts';
import { isTombstoned } from './tombstones.ts';

/** An unlock lasts at most a day, and never past the link's own expiry. */
export const UNLOCK_MAX_MS = 86_400_000;
/** `last_used_at` is written at most this often per link, so opening a link is mostly a read. */
export const SHARE_TOUCH_INTERVAL_MS = 60_000;

export const SHARE_RATES: {
  open: RateRule;
  info: RateRule;
  unlock: RateRule;
  unlockLink: RateRule;
  guestComment: RateRule;
  guestCommentLink: RateRule;
  guestEdit: RateRule;
  events: RateRule;
} = {
  /** Opening `/s/<token>`, per client address. */
  open: { name: 'share-open', limit: 120, windowMs: 600_000 },
  /** Share info, which makes a grant each time, per link and address (`<token hash>:<address>`). */
  info: { name: 'share-info', limit: 60, windowMs: 60_000 },
  /** Password attempts on one link from one address (`<link id>:<address>`). */
  unlock: { name: 'share-unlock', limit: 10, windowMs: 900_000 },
  /** Password attempts on one link from every address together (link id). */
  unlockLink: { name: 'share-unlock-link', limit: 100, windowMs: 3_600_000 },
  /** Guest comments on one link from one address (`<link id>:<address>`). */
  guestComment: { name: 'share-comment', limit: 10, windowMs: 600_000 },
  /** Guest comments on one link from every address together (link id). */
  guestCommentLink: { name: 'share-comment-link', limit: 200, windowMs: 3_600_000 },
  /** Guest edits and deletes on one link from one address (`<link id>:<address>`). */
  guestEdit: { name: 'share-comment-edit', limit: 30, windowMs: 600_000 },
  /** Opening a share link's live stream, per client address. */
  events: { name: 'share-events', limit: 60, windowMs: 60_000 },
};

/** The HKDF purpose of the key that signs unlock cookies. */
const UNLOCK_KEY_PURPOSE = 'share-unlock';
/** What `newSecret` makes: 43 base64url characters. Nothing else was ever a share token. */
const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** `v1.<expiresAt>.<mac>`: epoch milliseconds, then 32 bytes of HMAC-SHA256 in base64url. */
const UNLOCK_VALUE = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

/** A share link that can be opened, what it shows, and whether its password is still to give. */
export interface ShareState {
  link: ShareLinkRow;
  artifact: ArtifactRow;
  version: VersionRow;
  /** The link has a password, and the request carries no valid unlock for it. */
  locked: boolean;
}

/** Why a link that once worked answers 410; `expired` has copy of its own. */
type GoneReason = 'revoked' | 'expired' | 'deleted';

function linkGone(reason: GoneReason): AppError {
  return gone(t(reason === 'expired' ? 'share.expired.message' : 'share.gone.message'), {
    reason,
  });
}

function passwordRequired(): AppError {
  return unauthorized(t('share.passwordRequired'), { password_required: true });
}

/** Throws 410 when `link` is revoked, or expired at `now`. */
function assertOpen(link: ShareLinkRow, now: number): void {
  if (link.revoked_at !== null) throw linkGone('revoked');
  if (link.expires_at !== null && link.expires_at <= now) throw linkGone('expired');
}

/**
 * The share link `token` names, with its artifact and the version it shows (its own, or the
 * artifact's current one), and whether `unlockCookie` unlocks it. A token never issued answers
 * 404; a link deleted with its version or artifact, or revoked, 410 with `details.reason`
 * `deleted` or `revoked`; an expired one 410 with reason `expired`. Messages speak of the link
 * only, never of what it pointed to.
 */
export async function resolveShare(
  deps: AppDeps,
  token: string,
  unlockCookie: string | undefined,
): Promise<ShareState> {
  const { db } = deps.db;
  const now = deps.clock.now();
  if (!SHARE_TOKEN.test(token)) throw notFound(t('share.notFound.message'));
  const hash = hashSecret(token);
  const link = await db
    .selectFrom('share_links')
    .selectAll()
    .where('token_hash', '=', hash)
    .executeTakeFirst();
  if (link === undefined) {
    if (await isTombstoned(db, 'share_link', hash, now)) throw linkGone('deleted');
    throw notFound(t('share.notFound.message'));
  }
  assertOpen(link, now);
  const artifact = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('id', '=', link.artifact_id)
    .executeTakeFirst();
  const versionId = link.version_id ?? artifact?.current_version_id ?? null;
  const version =
    versionId === null
      ? undefined
      : await db.selectFrom('versions').selectAll().where('id', '=', versionId).executeTakeFirst();
  // A read that raced the deletion of what the link shows: the link goes with it.
  if (artifact === undefined || version === undefined) throw linkGone('deleted');
  const locked = link.password_hash !== null && checkUnlock(deps, link, unlockCookie) === null;
  return { link, artifact, version, locked };
}

/**
 * The share link `token` names, opened by this browser: a link still locked by its password
 * answers 401 (`details.password_required`). Otherwise it answers as `resolveShare` does.
 */
export async function resolveOpenShare(
  deps: AppDeps,
  token: string,
  unlockCookie: string | undefined,
): Promise<ShareState> {
  const s = await resolveShare(deps, token, unlockCookie);
  if (s.locked) throw passwordRequired();
  return s;
}

/**
 * The share link `token` names, for its guests' comments: one that does not allow comments
 * answers 403. Otherwise it answers as `resolveOpenShare` does.
 */
export async function resolveCommentShare(
  deps: AppDeps,
  token: string,
  unlockCookie: string | undefined,
): Promise<ShareState> {
  const s = await resolveOpenShare(deps, token, unlockCookie);
  if (s.link.allow_comments !== 1) throw forbidden(t('share.commentsOff'));
  return s;
}

/**
 * The share link `linkId` a guest writes a comment through, read again in the write's
 * transaction once the artifact is held, and share-locked on Postgres (the order `shareGrant`,
 * revokes and deletions lock in). A revoke, expiry or deletion that landed after the request
 * resolved the link refuses the write (410, `details.reason` as `resolveShare` gives it), and
 * one that comes later waits for the write; a link closed to comments answers 403.
 */
export async function holdCommentLink(
  trx: Transaction<Database>,
  dialect: DbDialect,
  linkId: string,
  now: number,
): Promise<ShareLinkRow> {
  const link = await trx
    .selectFrom('share_links')
    .selectAll()
    .where('id', '=', linkId)
    .$if(dialect === 'postgres', (qb) => qb.forShare())
    .executeTakeFirst();
  // A per-version link goes with its version, and every link with its artifact.
  if (link === undefined) throw linkGone('deleted');
  assertOpen(link, now);
  if (link.allow_comments !== 1) throw forbidden(t('share.commentsOff'));
  return link;
}

/**
 * Version `versionId` of `artifact`, which guest link `link` showed when the request resolved
 * it. Gone since: a link that follows the current version still works, so the page is only out
 * of date (409); a per-version link went with it (410).
 */
export async function sharedVersion(
  trx: Transaction<Database>,
  artifact: ArtifactRow,
  link: ShareLinkRow,
  versionId: string,
): Promise<VersionRow> {
  const version = await trx
    .selectFrom('versions')
    .selectAll()
    .where('id', '=', versionId)
    .where('artifact_id', '=', artifact.id)
    .executeTakeFirst();
  if (version !== undefined) return version;
  throw link.version_id === null ? conflict(t('share.versionGone')) : linkGone('deleted');
}

/**
 * The unlock cookie's name: `__Secure-` on an https public origin, so only a secure page can set
 * it. Like the session cookie's, it comes from the configuration, never from the request.
 */
export function shareCookieName(config: Config): '__Secure-pinwall_share' | 'pinwall_share' {
  return config.publicHttps ? '__Secure-pinwall_share' : 'pinwall_share';
}

/** The unlock value the browser sent, if any. Its path scopes it to one link. */
export function readUnlockCookie(c: Context<AppEnv>): string | undefined {
  const value = getCookie(c, shareCookieName(c.var.deps.config));
  return value === '' ? undefined : value;
}

function unlockKey(deps: AppDeps): Buffer {
  const { secretKey } = deps.config;
  if (secretKey === null) {
    throw new Error('No secret key to sign share unlocks with: createDeps sets one');
  }
  return deriveKey(secretKey, UNLOCK_KEY_PURPOSE);
}

/**
 * The MAC binds the link, the moment the unlock ends and the link's password hash, so a value
 * opens one link only, cannot be stretched, and stops working if the password changes.
 */
function unlockMac(deps: AppDeps, link: ShareLinkRow, expiresAt: number): string {
  return createHmac('sha256', unlockKey(deps))
    .update(`${link.id}.${expiresAt}.${link.password_hash}`)
    .digest('base64url');
}

/** The unlock cookie value for `link` until `expiresAt`: `v1.<expiresAt>.<mac>`. */
export function unlockValue(deps: AppDeps, link: ShareLinkRow, expiresAt: number): string {
  return `v1.${expiresAt}.${unlockMac(deps, link, expiresAt)}`;
}

/**
 * When the unlock in `value` ends, if it is one this server made for `link` (a link with a
 * password) and that end is still ahead; null otherwise.
 */
export function checkUnlock(
  deps: AppDeps,
  link: ShareLinkRow,
  value: string | undefined,
): number | null {
  if (value === undefined || link.password_hash === null) return null;
  const match = UNLOCK_VALUE.exec(value);
  if (match === null) return null;
  const expiresAt = Number(match[1]);
  if (expiresAt <= deps.clock.now()) return null;
  return safeEqual(match[2] ?? '', unlockMac(deps, link, expiresAt)) ? expiresAt : null;
}

/**
 * Unlocks the password link `token` for this browser. A link without a password needs nothing
 * and sets nothing. Otherwise the attempt counts against `SHARE_RATES.unlock` (this link from
 * this address) and `SHARE_RATES.unlockLink` (this link from anywhere) before the password,
 * in any Unicode form, is checked: a wrong one answers 401 `invalid_credentials`. The unlock
 * lasts until `UNLOCK_MAX_MS` from now or the link's expiry, whichever comes first, and goes
 * out as two cookies with one value, one for `/s/<token>` and one for `/api/v1/share/<token>`.
 * A link that cannot be opened answers as `resolveShare` does.
 */
export async function unlockShare(
  c: Context<AppEnv>,
  token: string,
  password: string,
): Promise<void> {
  const { deps } = c.var;
  const { config } = deps;
  const { link } = await resolveShare(deps, token, undefined);
  if (link.password_hash === null) return;
  const ip = clientIp(c, config.trustProxy);
  await enforceRateLimit(c, SHARE_RATES.unlock, `${link.id}:${ip}`);
  await enforceRateLimit(c, SHARE_RATES.unlockLink, link.id);
  if (!(await verifyPassword(normalizePassword(password), link.password_hash))) {
    throw new AppError('invalid_credentials', 401, t('auth.wrongPassword'));
  }
  const now = deps.clock.now();
  const expiresAt = Math.min(now + UNLOCK_MAX_MS, link.expires_at ?? Number.POSITIVE_INFINITY);
  const value = unlockValue(deps, link, expiresAt);
  // Rounded down, so the cookie never outlives the unlock it carries.
  const maxAge = Math.floor((expiresAt - now) / 1000);
  for (const path of [`/s/${token}`, `/api/v1/share/${token}`]) {
    setCookie(c, shareCookieName(config), value, {
      path,
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.publicHttps,
      maxAge,
    });
  }
}

/**
 * A new content grant of `mode` to the version `s` shows, made for the link's guest: no user,
 * the link recorded so revoking it ends the grant, and lasting `PINWALL_PREVIEW_TTL` but never
 * past the link's expiry. A locked link gets none (401). The link is checked again in the
 * transaction that writes the grant, with its artifact and its row share-locked on Postgres
 * (the order revokes and deletions lock them in), so a revoke, expiry or deletion that lands
 * after `s` was read either waits for the grant and then ends it, or wins and this answers 410.
 */
export async function shareGrant(
  deps: AppDeps,
  s: ShareState,
  mode: GrantMode,
): Promise<ContentGrantRow> {
  if (s.locked) throw passwordRequired();
  const { db, dialect } = deps.db;
  const postgres = dialect === 'postgres';
  return db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const artifact = await trx
      .selectFrom('artifacts')
      .select('id')
      .where('id', '=', s.artifact.id)
      .$if(postgres, (qb) => qb.forShare())
      .executeTakeFirst();
    const link = await trx
      .selectFrom('share_links')
      .selectAll()
      .where('id', '=', s.link.id)
      .$if(postgres, (qb) => qb.forShare())
      .executeTakeFirst();
    if (artifact === undefined || link === undefined) throw linkGone('deleted');
    assertOpen(link, now);
    const version = await trx
      .selectFrom('versions')
      .select('id')
      .where('id', '=', s.version.id)
      .executeTakeFirst();
    if (version === undefined) throw linkGone('deleted');
    const { previewMs } = deps.config.ttl;
    return createGrant(deps, {
      db: trx,
      versionId: version.id,
      mode,
      user: null,
      shareLinkId: link.id,
      ttlMs: link.expires_at === null ? previewMs : Math.min(previewMs, link.expires_at - now),
    });
  });
}

/** Records that `link` was used now, unless that was already recorded in the last minute. */
export async function touchShareLink(deps: AppDeps, link: ShareLinkRow): Promise<void> {
  const now = deps.clock.now();
  const recent = now - SHARE_TOUCH_INTERVAL_MS;
  if (link.last_used_at !== null && link.last_used_at > recent) return;
  await deps.db.db
    .updateTable('share_links')
    .set({ last_used_at: now })
    .where('id', '=', link.id)
    .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<=', recent)]))
    .execute();
}

/**
 * What the share viewer shows for `s`, opened with `token`: the artifact's name, the version and
 * how the link follows it, a new grant to its content, `review` when the link allows comments
 * (the viewer then pins them on the page) and `raw` otherwise, and the URL of "Open original",
 * which makes its raw grant only when followed. A locked link answers 401.
 */
export async function shareInfo(deps: AppDeps, s: ShareState, token: string): Promise<ShareInfo> {
  const allowComments = s.link.allow_comments === 1;
  const mode: GrantMode = allowComments ? 'review' : 'raw';
  const grant = await shareGrant(deps, s, mode);
  return {
    artifact_name: s.artifact.name,
    kind: entryKind(s.version.entry_path),
    version_number: s.version.number,
    follows_current: s.link.version_id === null,
    allow_comments: allowComments,
    expires_at: s.link.expires_at,
    original_url: shareOriginalUrl(deps.config, token),
    content: {
      url: contentUrl(deps.config, grant.token),
      mode,
      expires_at: grant.expires_at,
      isolation: deps.config.isolation.mode,
    },
  };
}
