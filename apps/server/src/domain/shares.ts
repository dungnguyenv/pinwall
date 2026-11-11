import { PASSWORD_MAX_LENGTH, SHARE_PASSWORD_MIN_LENGTH, type ShareLink } from '@pinwall/shared';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import { normalizePassword } from '../auth/password.ts';
import { effectiveRole } from '../auth/roles.ts';
import type { Config } from '../config/types.ts';
import type { ArtifactRow, Database, ShareLinkRow, UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { publicUrl } from '../http/public-url.ts';
import { hashPassword } from '../lib/crypto.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newId, newSecret } from '../lib/ids.ts';
import { getArtifact, holdArtifact } from './artifacts.ts';
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
 * and cannot be shown again. A version of another artifact answers 400; a missing artifact 404,
 * a deleted one 410.
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
  if (p.expiresAt !== null && p.expiresAt <= deps.clock.now()) {
    throw badRequest(t('share.badExpiry'), { field: 'expires_at' });
  }
  // Hashed before the transaction: scrypt is slow, and on SQLite the transaction holds the only
  // connection.
  const passwordHash =
    p.password === null ? null : await hashPassword(checkSharePassword(p.password));
  const token = newSecret();
  const { db, dialect } = deps.db;
  const row = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const artifact = await holdArtifact(trx, dialect, artifactId, now);
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
 * whatever the page size. A missing artifact answers as `getArtifact` does (404, or 410).
 */
export async function listShareLinks(
  deps: AppDeps,
  artifactId: string,
  p: { includeRevoked: boolean; limit: number; cursor: string | null },
): Promise<{ items: ShareLink[]; nextCursor: string | null }> {
  const { db } = deps.db;
  const artifact = await getArtifact(db, artifactId, deps.clock.now());
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
 * Revokes the share link `linkId`; its creator, the artifact's publisher or an admin may. In one
 * transaction it marks the link revoked and ends the content grants made from it, so what it
 * opened stops being served at once (those grants answer 410). Revoking a revoked link changes
 * nothing.
 */
export async function revokeShareLink(
  deps: AppDeps,
  actor: UserRow,
  linkId: string,
): Promise<void> {
  const { db, dialect } = deps.db;
  await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const seen = await getShareLink(trx, linkId);
    // The artifact is held before anything else, as deletions lock it first, so a deletion and
    // this revoke take turns on the link's grants and their tombstones instead of deadlocking.
    const artifact = await holdArtifact(trx, dialect, seen.artifact_id, now);
    // A deletion the hold waited for may have taken the link along.
    const link = dialect === 'postgres' ? await getShareLink(trx, linkId) : seen;
    if (!canRevoke(actor, link, artifact)) throw forbidden(t('share.revokeForbidden'));
    await trx
      .updateTable('share_links')
      .set({ revoked_at: now })
      .where('id', '=', link.id)
      .where('revoked_at', 'is', null)
      .execute();
    await endGrantsOf(trx, link.id, now);
  });
}

/** `revoked` once revoked, else `expired` from `expires_at` on, else `active`. */
function shareLinkStatus(row: ShareLinkRow, now: number): ShareLink['status'] {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at !== null && row.expires_at <= now) return 'expired';
  return 'active';
}

/** Whether `user` may revoke `link`: its creator, the artifact's publisher, or an admin. */
function canRevoke(user: UserRow, link: ShareLinkRow, artifact: ArtifactRow): boolean {
  return (
    link.created_by === user.id ||
    artifact.created_by === user.id ||
    effectiveRole(user) === 'admin'
  );
}

async function getShareLink(db: Db, id: string): Promise<ShareLinkRow> {
  const row = await db
    .selectFrom('share_links')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) throw notFound(t('share.unknown'));
  return row;
}

/**
 * Deletes the content grants made from link `linkId`, tombstoning those still live until they
 * would have expired, so they answer 410 rather than 404.
 */
async function endGrantsOf(trx: Transaction<Database>, linkId: string, now: number) {
  const live = await trx
    .selectFrom('content_grants')
    .select(['token', 'expires_at'])
    .where('share_link_id', '=', linkId)
    .where('expires_at', '>', now)
    .execute();
  await addTombstones(
    trx,
    live.map((grant) => ({ kind: 'content_grant', key: grant.token, expiresAt: grant.expires_at })),
    now,
  );
  await trx.deleteFrom('content_grants').where('share_link_id', '=', linkId).execute();
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
