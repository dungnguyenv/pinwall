import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import { idpAccessDeadline } from '../auth/oidc/gate.ts';
import type { Db } from '../auth/passkeys.ts';
import { hasAccess } from '../auth/roles.ts';
import type { Config } from '../config/types.ts';
import type {
  ContentGrantMode,
  ContentGrantRow,
  Database,
  UserRow,
  VersionRow,
} from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { scopeForUser, type ViewerScope, whereVisible } from '../domain/spaces.ts';
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
 * signed-in person asked for it (a share link's guest). Pass the transaction in `db` when one is
 * open.
 */
export async function createGrant(
  deps: AppDeps,
  p: {
    versionId: string;
    mode: GrantMode;
    user: UserRow | null;
    shareLinkId?: string | null;
    ttlMs?: number;
    db?: Db;
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
  await (p.db ?? deps.db.db).insertInto('content_grants').values(grant).execute();
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
 * Version `versionId` of a grant: for one made for a person (`holder`), only while the artifact
 * is still one they see; a share link's grant (`holder` null) follows the link's rules instead.
 */
function grantVersion(
  db: Db,
  versionId: string,
  holder: ViewerScope | null,
): Promise<VersionRow | undefined> {
  if (holder === null) {
    return db.selectFrom('versions').selectAll().where('id', '=', versionId).executeTakeFirst();
  }
  const version = db
    .selectFrom('versions')
    .innerJoin('artifacts', 'artifacts.id', 'versions.artifact_id')
    .selectAll('versions')
    .where('versions.id', '=', versionId);
  return whereVisible(version, holder, 'artifacts.project_id').executeTakeFirst();
}

/**
 * The grant `token` names and its version. A token never issued answers 404; one whose grant or
 * version was deleted or revoked (tombstoned) 410; an expired one 410 with `details.expired`; one
 * made for a person who has no access now (blocked, disabled), or who no longer sees the
 * version's artifact, 410 as well. Sight is checked at each request, so a grant refused that way
 * serves again once its holder sees the artifact again.
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
  let holder: ViewerScope | null = null;
  if (grant.user_id !== null) {
    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', grant.user_id)
      .executeTakeFirst();
    // A deleted user takes their grants along; this is a read that raced the delete.
    if (user === undefined || !hasAccess(user)) throw gone(t('content.gone.message'));
    holder = scopeForUser(deps, user);
  }
  const version = await grantVersion(db, grant.version_id, holder);
  // Deleting a version deletes its grants with it, so a miss is a read that raced the delete, or
  // a holder who lost sight of the artifact: either way, gone like a deleted version.
  if (version === undefined) throw gone(t('content.gone.message'));
  return { grant, version };
}

/** Which grants a revocation ends: a condition on `content_grants`. */
type GrantFilter = (eb: ExpressionBuilder<Database, 'content_grants'>) => Expression<SqlBool>;

/**
 * Deletes the grants `filter` keeps, and tombstones those still live until they would have
 * expired, so they answer 410 rather than 404. The tombstones go in token order, so two
 * revocations that end some of the same grants insert them in one order. Returns how many grants
 * were deleted.
 */
async function endGrants(db: Db, filter: GrantFilter, now: number): Promise<number> {
  const live = await db
    .selectFrom('content_grants')
    .select(['token', 'expires_at'])
    .where(filter)
    .where('expires_at', '>', now)
    .orderBy('token')
    .execute();
  await addTombstones(
    db,
    live.map((grant) => ({ kind: 'content_grant', key: grant.token, expiresAt: grant.expires_at })),
    now,
  );
  const deleted = await db.deleteFrom('content_grants').where(filter).executeTakeFirst();
  return Number(deleted.numDeletedRows);
}

/**
 * Ends every grant made for `userId` ("Revoke now"): deletes them, and tombstones those still
 * live until they would have expired, so they answer 410 rather than 404. Pass the transaction
 * that revokes the rest of the user's credentials. Returns how many grants were deleted.
 */
export async function revokeUserGrants(db: Db, userId: string, now: number): Promise<number> {
  return endGrants(db, (eb) => eb('user_id', '=', userId), now);
}

/**
 * Ends the grants made for `userId` on versions of `projectId`'s artifacts: deleted, live ones
 * tombstoned (410), so they stay gone even once the person sees the project again. Pass the
 * transaction that takes them out of the project. Returns how many.
 */
export async function revokeProjectGrants(
  db: Db,
  userId: string,
  projectId: string,
  now: number,
): Promise<number> {
  return endGrants(
    db,
    (eb) =>
      eb.and([
        eb('user_id', '=', userId),
        eb(
          'version_id',
          'in',
          eb
            .selectFrom('versions')
            .innerJoin('artifacts', 'artifacts.id', 'versions.artifact_id')
            .select('versions.id')
            .where('artifacts.project_id', '=', projectId),
        ),
      ]),
    now,
  );
}

/** Deletes the grants that have expired; returns how many. */
export async function purgeExpiredGrants(deps: AppDeps): Promise<number> {
  const result = await deps.db.db
    .deleteFrom('content_grants')
    .where('expires_at', '<=', deps.clock.now())
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
