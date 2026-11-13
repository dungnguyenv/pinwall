import { PASSWORD_MAX_LENGTH, SHARE_PASSWORD_MIN_LENGTH, type ShareLink } from '@pinwall/shared';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import { normalizePassword } from '../auth/password.ts';
import { effectiveRole } from '../auth/roles.ts';
import type { Config, Visibility } from '../config/types.ts';
import type { DbDialect } from '../db/connect.ts';
import type { ArtifactRow, Database, ShareLinkRow, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { publicUrl } from '../http/public-url.ts';
import { hashPassword } from '../lib/crypto.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newId, newSecret } from '../lib/ids.ts';
import { getArtifact, holdArtifact } from './artifacts.ts';
import { mayExpose, notApproved } from './exposure.ts';
import { endShareLinkStreams } from './live.ts';
import {
  assertCan,
  can,
  forbiddenRole,
  holdProject,
  holdRoleIn,
  type ProjectRole,
  type Scope,
  type SystemScope,
  scopeForUser,
  seesAll,
  whereVisible,
} from './spaces.ts';
import { addTombstones } from './tombstones.ts';
import { versionOf } from './versions.ts';

/**
 * How many share links of each artifact in `artifactIds` still open: not revoked, and without an
 * expiry or expiring after `now`. Artifacts without one are left out. One query.
 */
export async function countActiveShareLinks(
  db: Db,
  artifactIds: readonly string[],
  now: number,
): Promise<Map<string, number>> {
  if (artifactIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('share_links')
    .select((eb) => ['artifact_id', eb.fn.countAll().as('count')])
    .where('artifact_id', 'in', artifactIds)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .groupBy('artifact_id')
    .execute();
  return new Map(rows.map((row) => [row.artifact_id, Number(row.count)]));
}

/** Where the next page of links starts: after the one made at `c` with id `i`. */
const LinkCursor = z.object({ c: z.number().int(), i: z.string() });

/** The page a share link opens: `/s/<token>` on the public origin. */
export function shareUrl(config: Config, token: string): string {
  return publicUrl(config, `/s/${token}`);
}

/** The share viewer's "Open original": `/s/<token>/original`, a redirect to a new raw grant. */
export function shareOriginalUrl(config: Config, token: string): string {
  return publicUrl(config, `/s/${token}/original`);
}

/**
 * A share-link password someone is choosing, normalized and ready to hash. Its length is counted
 * in code points after normalization, as account passwords are.
 */
export function checkSharePassword(pw: string): string {
  const normalized = normalizePassword(pw);
  const length = [...normalized].length;
  if (length < SHARE_PASSWORD_MIN_LENGTH) {
    throw badRequest(t('share.passwordTooShort', { min: SHARE_PASSWORD_MIN_LENGTH }), {
      field: 'password',
    });
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw badRequest(t('share.passwordTooLong', { max: PASSWORD_MAX_LENGTH }), {
      field: 'password',
    });
  }
  return normalized;
}

/**
 * Makes a share link of the artifact: to version `versionId`, or following the current version
 * when null; open to anyone with it, or behind `password`; until `expiresAt` (which must be in
 * the future) or until revoked. Returns the row and the token, which is stored only as its hash
 * and cannot be shown again. Someone `mayExpose` refuses gets 403 (`notApproved`) before
 * anything else is checked, so the answer is the same whatever the artifact. A version of another
 * artifact answers 400; a missing artifact, or one `actor` does not see, 404, a deleted one 410.
 * In personal mode a role that may not `createShareLink` (a viewer) gets 403.
 */
export async function createShareLink(
  deps: AppDeps,
  actor: UserRow,
  artifactId: string,
  p: {
    versionId: string | null;
    password: string | null;
    expiresAt: number | null;
    allowComments: boolean;
  },
): Promise<{ row: ShareLinkRow; token: string }> {
  if (!mayExpose(deps.config, actor)) throw notApproved('shareLink');
  if (p.expiresAt !== null && p.expiresAt <= deps.clock.now()) {
    throw badRequest(t('share.badExpiry'), { field: 'expires_at' });
  }
  // Hashed before the transaction: scrypt is slow, and on SQLite the transaction holds the only
  // connection.
  const passwordHash =
    p.password === null ? null : await hashPassword(checkSharePassword(p.password));
  const token = newSecret();
  const { db, dialect } = deps.db;
  const scope = scopeForUser(deps, actor);
  const row = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const artifact = await holdArtifact(trx, dialect, scope, artifactId, now);
    assertCan(scope, await holdRoleIn(trx, dialect, scope, artifact.project_id), 'createShareLink');
    const version = p.versionId === null ? null : await versionOf(trx, artifact, p.versionId);
    const link: ShareLinkRow = {
      id: newId('shr'),
      artifact_id: artifact.id,
      version_id: version?.id ?? null,
      token_hash: hashSecret(token),
      password_hash: passwordHash,
      allow_comments: p.allowComments ? 1 : 0,
      expires_at: p.expiresAt,
      created_by: actor.id,
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    };
    await trx.insertInto('share_links').values(link).execute();
    return link;
  });
  return { row, token };
}

/**
 * One page of the artifact's share links, newest first (ties by id). Revoked links are left out
 * unless `includeRevoked`; expired ones are listed with status `expired`. The same queries
 * whatever the page size. A missing artifact, or one `scope` does not see, answers as
 * `getArtifact` does (404, or 410).
 */
export async function listShareLinks(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  p: { includeRevoked: boolean; limit: number; cursor: string | null },
): Promise<{ items: ShareLink[]; nextCursor: string | null }> {
  const { db } = deps.db;
  const artifact = await getArtifact(db, scope, artifactId, deps.clock.now());
  let query = db.selectFrom('share_links').selectAll().where('artifact_id', '=', artifact.id);
  if (!p.includeRevoked) query = query.where('revoked_at', 'is', null);
  if (p.cursor !== null) {
    const after = decodeCursor(p.cursor, LinkCursor);
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', after.c),
        eb.and([eb('created_at', '=', after.c), eb('id', '<', after.i)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(p.limit + 1)
    .execute();
  const links = rows.slice(0, p.limit);
  const last = links.at(-1);
  const nextCursor =
    rows.length > p.limit && last ? encodeCursor({ c: last.created_at, i: last.id }) : null;
  return { items: await toShareLinks(deps, links), nextCursor };
}

/**
 * Share links as members see them, in the order given: one query for the versions they point
 * at and one for their creators, whatever their number. A per-version link whose version is
 * gone was deleted with it (a read that raced the deletion) and is left out.
 */
export async function toShareLinks(
  deps: AppDeps,
  rows: readonly ShareLinkRow[],
): Promise<ShareLink[]> {
  const { db } = deps.db;
  const now = deps.clock.now();
  const numbers = await versionNumbers(db, distinct(rows.map((row) => row.version_id)));
  const names = await userNames(db, distinct(rows.map((row) => row.created_by)));
  const links: ShareLink[] = [];
  for (const row of rows) {
    let version: ShareLink['version'] = null;
    if (row.version_id !== null) {
      const number = numbers.get(row.version_id);
      if (number === undefined) continue;
      version = { id: row.version_id, number };
    }
    const creator = row.created_by;
    links.push({
      id: row.id,
      artifact_id: row.artifact_id,
      version,
      has_password: row.password_hash !== null,
      allow_comments: row.allow_comments === 1,
      expires_at: row.expires_at,
      // A creator whose account is gone shows as an unknown member.
      created_by:
        creator !== null && names.has(creator)
          ? { user_id: creator, name: names.get(creator) ?? null }
          : { user_id: null, name: null },
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
      status: shareLinkStatus(row, now),
    });
  }
  return links;
}

/**
 * Revokes the share link `linkId` when `canRevoke` allows `actor` to (403 otherwise). In one
 * transaction it marks the link revoked and ends the content grants made from it, so what it
 * opened stops being served at once (those grants answer 410); once that has committed, the
 * link's live streams end too. Revoking a revoked link changes nothing. A link on an artifact
 * `actor` does not see answers 404, as a missing one does.
 */
export async function revokeShareLink(
  deps: AppDeps,
  actor: UserRow,
  linkId: string,
): Promise<void> {
  const { db, dialect } = deps.db;
  const scope = scopeForUser(deps, actor);
  await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const seen = await getShareLink(trx, scope, linkId);
    // The artifact is held before anything else, as deletions lock it first, so a deletion and
    // this revoke take turns on the link's grants and their tombstones instead of deadlocking.
    const artifact = await holdArtifact(trx, dialect, scope, seen.artifact_id, now);
    // A deletion the hold waited for may have taken the link along.
    const link = dialect === 'postgres' ? await getShareLink(trx, scope, linkId) : seen;
    const role = await holdRoleIn(trx, dialect, scope, artifact.project_id);
    if (!canRevoke(scope, role, actor, link, artifact)) {
      throw seesAll(scope)
        ? forbidden(t('share.revokeForbidden'))
        : forbiddenRole('revokeShareLink');
    }
    await markRevoked(trx, link.id, now);
  });
  endShareLinkStreams(deps, linkId);
}

/**
 * `revokeShareLink` for the system, as a moderation action: no one's role is asked, and the link
 * is found whichever space its artifact is in. The artifact is held first, then its project, as
 * every write takes them. An unknown link answers 404; a revoked one stays as it was.
 */
export async function systemRevokeShareLink(
  deps: AppDeps,
  scope: SystemScope,
  linkId: string,
): Promise<void> {
  const { db, dialect } = deps.db;
  await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const seen = await getShareLink(trx, scope, linkId);
    const artifact = await holdArtifact(trx, dialect, scope, seen.artifact_id, now);
    await holdProject(trx, dialect, deps.config.visibility, artifact.project_id);
    // A deletion the hold waited for may have taken the link along.
    const link = dialect === 'postgres' ? await getShareLink(trx, scope, linkId) : seen;
    await markRevoked(trx, link.id, now);
  });
  endShareLinkStreams(deps, linkId);
}

/** Marks link `linkId` revoked (a revoked one keeps its time) and ends the grants made from it. */
async function markRevoked(trx: Transaction<Database>, linkId: string, now: number) {
  await trx
    .updateTable('share_links')
    .set({ revoked_at: now })
    .where('id', '=', linkId)
    .where('revoked_at', 'is', null)
    .execute();
  await endGrantsOf(trx, [linkId], now);
}

/**
 * Revokes, in `trx`, every share link `userId` made that is not revoked yet, as part of ending
 * that person's access: "Revoke now", a block, or the IdP no longer admitting them. Each link
 * ends as `revokeShareLink` ends one, with the content grants made from it, and takes its locks
 * in the same order as every write: the artifact first (in id order, one artifact at a time),
 * then its project (`holdProject`), then its links. A membership change holds the project
 * before it touches links, so it and this transaction take turns at the project. Call it before
 * `trx` touches any content grant or tombstone, so a deletion waiting on one of those artifacts
 * cannot be waiting on this transaction too. A link whose artifact a deletion took meanwhile is
 * skipped. Returns the ids of the links revoked: once `trx` has committed, end their live
 * streams with `endShareLinkStreams`.
 */
export async function revokeShareLinksOf(
  trx: Transaction<Database>,
  dialect: DbDialect,
  visibility: Visibility,
  userId: string,
  now: number,
): Promise<string[]> {
  const open = await trx
    .selectFrom('share_links')
    .select('artifact_id')
    .distinct()
    .where('created_by', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  const revoked: string[] = [];
  for (const artifactId of open.map((row) => row.artifact_id).sort()) {
    if (!(await holdIfPresent(trx, dialect, visibility, artifactId))) continue;
    // Read under the hold: a deletion the hold waited for has taken its links along.
    revoked.push(...(await revokeLinksOn(trx, userId, artifactId, now)));
  }
  return revoked;
}

/**
 * `revokeShareLinksOf` for the artifacts of `projectId` only, as the person leaves the project
 * or stops being one of its editors. For a transaction that holds the project (`lockProject`):
 * the artifacts go in id order, and none is held, since a write that holds one may be waiting
 * on the project. A link whose artifact a deletion took meanwhile is skipped. Returns the ids of
 * the links revoked: once `trx` has committed, end their live streams with
 * `endShareLinkStreams`.
 */
export async function revokeProjectShareLinksOf(
  trx: Transaction<Database>,
  userId: string,
  projectId: string,
  now: number,
): Promise<string[]> {
  const open = await trx
    .selectFrom('share_links')
    .innerJoin('artifacts', 'artifacts.id', 'share_links.artifact_id')
    .select('share_links.artifact_id')
    .distinct()
    .where('artifacts.project_id', '=', projectId)
    .where('share_links.created_by', '=', userId)
    .where('share_links.revoked_at', 'is', null)
    .execute();
  const revoked: string[] = [];
  for (const artifactId of open.map((row) => row.artifact_id).sort()) {
    revoked.push(...(await revokeLinksOn(trx, userId, artifactId, now)));
  }
  return revoked;
}

/**
 * Revokes the links `userId` made on `artifactId` that are not revoked yet, and ends the content
 * grants made from them. Returns their ids.
 */
async function revokeLinksOn(
  trx: Transaction<Database>,
  userId: string,
  artifactId: string,
  now: number,
): Promise<string[]> {
  const links = await trx
    .selectFrom('share_links')
    .select('id')
    .where('artifact_id', '=', artifactId)
    .where('created_by', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
  if (links.length === 0) return [];
  const ids = links.map((link) => link.id);
  await trx
    .updateTable('share_links')
    .set({ revoked_at: now })
    .where('id', 'in', ids)
    .where('revoked_at', 'is', null)
    .execute();
  await endGrantsOf(trx, ids, now);
  return ids;
}

/**
 * Holds the artifact `id` as `holdArtifact` does, then its project as a write does
 * (`holdProject`); false when the artifact no longer exists.
 */
async function holdIfPresent(
  trx: Transaction<Database>,
  dialect: DbDialect,
  visibility: Visibility,
  id: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('artifacts')
    .select(['id', 'project_id'])
    .where('id', '=', id)
    .$if(dialect === 'postgres', (qb) => qb.forShare())
    .executeTakeFirst();
  if (row === undefined) return false;
  await holdProject(trx, dialect, visibility, row.project_id);
  return true;
}

/** `revoked` once revoked, else `expired` from `expires_at` on, else `active`. */
function shareLinkStatus(row: ShareLinkRow, now: number): ShareLink['status'] {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at !== null && row.expires_at <= now) return 'expired';
  return 'active';
}

/**
 * Whether `user`, with `role` in the project, may revoke `link`. Team mode and the system (the
 * 1.0 rule): its creator, the artifact's publisher, or an admin. Personal mode: the project's
 * owner, or an editor who made it.
 */
function canRevoke(
  scope: Scope,
  role: ProjectRole,
  user: UserRow,
  link: ShareLinkRow,
  artifact: ArtifactRow,
): boolean {
  if (seesAll(scope)) {
    return (
      link.created_by === user.id ||
      artifact.created_by === user.id ||
      effectiveRole(user) === 'admin'
    );
  }
  return can(role, 'revokeShareLink', { publishedBy: link.created_by, userId: user.id });
}

/** The share link `id`; 404 when there is none or `scope` does not see its artifact. */
async function getShareLink(db: Db, scope: Scope, id: string): Promise<ShareLinkRow> {
  const row = await whereVisible(
    db
      .selectFrom('share_links')
      .innerJoin('artifacts', 'artifacts.id', 'share_links.artifact_id')
      .selectAll('share_links')
      .where('share_links.id', '=', id),
    scope,
    'artifacts.project_id',
  ).executeTakeFirst();
  if (row === undefined) throw notFound(t('share.unknown'));
  return row;
}

/**
 * Deletes the content grants made from the links `linkIds` (of one artifact), tombstoning those
 * still live until they would have expired, so they answer 410 rather than 404. The tombstones
 * go in token order, as every grant ending inserts them.
 */
async function endGrantsOf(trx: Transaction<Database>, linkIds: readonly string[], now: number) {
  const live = await trx
    .selectFrom('content_grants')
    .select(['token', 'expires_at'])
    .where('share_link_id', 'in', linkIds)
    .where('expires_at', '>', now)
    .orderBy('token')
    .execute();
  await addTombstones(
    trx,
    live.map((grant) => ({ kind: 'content_grant', key: grant.token, expiresAt: grant.expires_at })),
    now,
  );
  await trx.deleteFrom('content_grants').where('share_link_id', 'in', linkIds).execute();
}

/** The number of each version in `ids` that still exists, by id. One query. */
async function versionNumbers(db: Db, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('versions')
    .select(['id', 'number'])
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((row) => [row.id, row.number]));
}

/** The name of each user in `ids` that still exists, by id. One query. */
async function userNames(db: Db, ids: readonly string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom('users').select(['id', 'name']).where('id', 'in', ids).execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The non-null values of `values`, each once. */
function distinct(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}
