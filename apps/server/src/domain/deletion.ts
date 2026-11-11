import type { Transaction } from 'kysely';
import type { AuthContext } from '../app.ts';
import { effectiveRole } from '../auth/roles.ts';
import { extractVersionText } from '../content/metadata.ts';
import type { DbDialect } from '../db/connect.ts';
import { searchDelete } from '../db/dialect.ts';
import type { ArtifactRow, Database } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { forbidden } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { entryKind } from '../publish/paths.ts';
import { getArtifact, getTags, lockArtifact } from './artifacts.ts';
import { collectBlobs } from './blobs.ts';
import { ARTIFACT_TOPIC, indexArtifact, reindexArtifact } from './search.ts';
import { addTombstones, type NewTombstone } from './tombstones.ts';
import { getVersionByNumber } from './versions.ts';

/** Whether `auth` may delete the artifact or one of its versions: an admin, or its publisher. */
export function canDelete(auth: AuthContext, artifact: ArtifactRow): boolean {
  return effectiveRole(auth.user) === 'admin' || artifact.created_by === auth.user.id;
}

/**
 * Deletes version `n` for good, in one transaction: the version with its files, content grants,
 * the comment threads written on it and its per-version share links (the schema cascades), and
 * tombstones for its live grants and those share links, so they answer 410 rather than 404. Its
 * number is never given again. When it was current, the newest remaining version becomes
 * current and the search index follows; when it was the last one, the artifact goes as well,
 * as `deleteArtifact` would remove it.
 *
 * Once committed, its files that no remaining version uses are removed from storage (deferred
 * to the sweep while a backup runs), and `version.deleted` (or `artifact.deleted`) goes out on
 * `ARTIFACT_TOPIC`. A missing artifact or version answers 404, a deleted one 410, and a caller
 * that `canDelete` refuses 403.
 */
export async function deleteVersion(
  deps: AppDeps,
  auth: AuthContext,
  artifactId: string,
  n: number,
): Promise<{ artifactDeleted: boolean; currentVersionId: string | null }> {
  const { db, dialect } = deps.db;
  const seen = await getArtifact(db, artifactId, deps.clock.now());
  assertCanDelete(auth, seen);
  // Read before the transaction: it reads blobs, and on SQLite the transaction holds the only
  // connection.
  const successor = await readSuccessor(deps, seen, n);

  const outcome = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const artifact =
      (await lockArtifact(trx, dialect, artifactId)) ?? (await getArtifact(trx, artifactId, now));
    const version = await getVersionByNumber(trx, artifact, n);
    const scope: Scope = { versionId: version.id };

    const shas = await blobsOf(trx, scope);
    const perVersionLinks = await trx
      .selectFrom('share_links')
      .select('token_hash')
      .where('version_id', '=', version.id)
      .execute();
    await addTombstones(
      trx,
      [...(await grantTombstones(trx, scope, now)), ...perVersionLinks.map(shareLinkTombstone)],
      now,
    );
    await trx.deleteFrom('versions').where('id', '=', version.id).execute();

    if (artifact.current_version_id !== version.id) {
      const currentVersionId = artifact.current_version_id;
      return { shas, artifactDeleted: false, currentVersionId, reindex: false };
    }
    const next = await trx
      .selectFrom('versions')
      .select(['id', 'entry_path'])
      .where('artifact_id', '=', artifact.id)
      .orderBy('number', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (next === undefined) {
      await removeArtifact(trx, dialect, artifact.id, now);
      return { shas, artifactDeleted: true, currentVersionId: null, reindex: false };
    }

    const change = {
      current_version_id: next.id,
      kind: entryKind(next.entry_path),
      updated_at: now,
    };
    await trx.updateTable('artifacts').set(change).where('id', '=', artifact.id).execute();
    // The deleted version's text leaves the index now, whatever happens next. When the version
    // read before the transaction is no longer the one that becomes current (a concurrent
    // delete or publish), the body stays empty until `reindexArtifact` fills it after commit.
    const fresh = successor?.versionId === next.id;
    const tags = await getTags(trx, artifact.id);
    await indexArtifact(
      { db: trx, dialect },
      { ...artifact, ...change },
      tags,
      fresh ? successor.text : '',
    );
    return { shas, artifactDeleted: false, currentVersionId: next.id, reindex: !fresh };
  });

  await releaseBlobs(deps, outcome.shas);
  deps.events.publish(
    ARTIFACT_TOPIC(artifactId),
    outcome.artifactDeleted
      ? { type: 'artifact.deleted', artifact_id: artifactId }
      : { type: 'version.deleted', artifact_id: artifactId, number: n },
  );
  if (outcome.reindex) {
    // The deletion has committed; a failure here only leaves the body out of search for now.
    await reindexArtifact(deps, artifactId).catch((err: unknown) => {
      deps.logger.error({ err, artifact_id: artifactId }, 'Could not index the current version');
    });
  }
  return { artifactDeleted: outcome.artifactDeleted, currentVersionId: outcome.currentVersionId };
}

/**
 * Deletes the artifact for good, in one transaction: every version as `deleteVersion` deletes
 * one, its tags, views, share links and comments, its search entry, and the artifact row, with
 * a tombstone for the artifact and for each live grant and share link. Once committed, files no
 * other artifact uses are removed from storage (deferred to the sweep while a backup runs), and
 * `artifact.deleted` goes out on `ARTIFACT_TOPIC`. A missing artifact answers 404, a deleted one
 * 410, and a caller that `canDelete` refuses 403.
 */
export async function deleteArtifact(
  deps: AppDeps,
  auth: AuthContext,
  artifactId: string,
): Promise<void> {
  const { db, dialect } = deps.db;
  assertCanDelete(auth, await getArtifact(db, artifactId, deps.clock.now()));

  const shas = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const artifact =
      (await lockArtifact(trx, dialect, artifactId)) ?? (await getArtifact(trx, artifactId, now));
    const scope: Scope = { artifactId: artifact.id };
    const shas = await blobsOf(trx, scope);
    await addTombstones(trx, await grantTombstones(trx, scope, now), now);
    await removeArtifact(trx, dialect, artifact.id, now);
    return shas;
  });

  await releaseBlobs(deps, shas);
  deps.events.publish(ARTIFACT_TOPIC(artifactId), {
    type: 'artifact.deleted',
    artifact_id: artifactId,
  });
}

function assertCanDelete(auth: AuthContext, artifact: ArtifactRow): void {
  if (!canDelete(auth, artifact)) throw forbidden(t('artifact.deleteForbidden'));
}

/**
 * The version that becomes current if version `n` goes, and its search text, as things stand
 * now: the newest other version, when `n` is the current one; else null.
 */
async function readSuccessor(
  deps: AppDeps,
  artifact: ArtifactRow,
  n: number,
): Promise<{ versionId: string; text: string } | null> {
  const { db } = deps.db;
  if (artifact.current_version_id === null) return null;
  const current = await db
    .selectFrom('versions')
    .select('number')
    .where('id', '=', artifact.current_version_id)
    .executeTakeFirst();
  if (current?.number !== n) return null;
  const next = await db
    .selectFrom('versions')
    .select('id')
    .where('artifact_id', '=', artifact.id)
    .where('number', '!=', n)
    .orderBy('number', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (next === undefined) return null;
  return { versionId: next.id, text: await extractVersionText(deps, next.id) };
}

/** The versions a deletion covers: one, or all of an artifact's. */
type Scope = { versionId: string } | { artifactId: string };

function versionIdsIn(trx: Transaction<Database>, scope: Scope) {
  const versions = trx.selectFrom('versions').select('id');
  return 'versionId' in scope
    ? versions.where('id', '=', scope.versionId)
    : versions.where('artifact_id', '=', scope.artifactId);
}

/** Every blob the versions in `scope` use, once each. */
async function blobsOf(trx: Transaction<Database>, scope: Scope): Promise<string[]> {
  const rows = await trx
    .selectFrom('version_files')
    .select('sha256')
    .distinct()
    .where('version_id', 'in', versionIdsIn(trx, scope))
    .execute();
  return rows.map((row) => row.sha256);
}

/**
 * Tombstones for the grants of the versions in `scope` that have not expired, each kept until
 * its grant would have expired. An expired grant needs none: it no longer serves anything.
 */
async function grantTombstones(
  trx: Transaction<Database>,
  scope: Scope,
  now: number,
): Promise<NewTombstone[]> {
  const grants = await trx
    .selectFrom('content_grants')
    .select(['token', 'expires_at'])
    .where('version_id', 'in', versionIdsIn(trx, scope))
    .where('expires_at', '>', now)
    .execute();
  return grants.map((grant) => ({
    kind: 'content_grant',
    key: grant.token,
    expiresAt: grant.expires_at,
  }));
}

function shareLinkTombstone(link: { token_hash: string }): NewTombstone {
  return { kind: 'share_link', key: link.token_hash, expiresAt: null };
}

/**
 * The last step of deleting an artifact: tombstones for it and its share links, its search
 * entry (FTS5 has no foreign key to cascade), and the row, which takes everything that still
 * references it along.
 */
async function removeArtifact(
  trx: Transaction<Database>,
  dialect: DbDialect,
  artifactId: string,
  now: number,
): Promise<void> {
  const links = await trx
    .selectFrom('share_links')
    .select('token_hash')
    .where('artifact_id', '=', artifactId)
    .execute();
  await addTombstones(
    trx,
    [{ kind: 'artifact', key: artifactId, expiresAt: null }, ...links.map(shareLinkTombstone)],
    now,
  );
  await searchDelete({ db: trx, dialect }, artifactId);
  await trx.deleteFrom('artifacts').where('id', '=', artifactId).execute();
}

/**
 * Removes the freed blobs. The deletion has committed and its links already answer 410, so a
 * storage failure here is logged rather than failing the request: the blobs keep their rows,
 * and the blob sweep removes them later.
 */
async function releaseBlobs(deps: AppDeps, shas: readonly string[]): Promise<void> {
  try {
    await collectBlobs(deps, shas);
  } catch (err) {
    deps.logger.error({ err }, 'Could not remove the files of a deletion; the blob sweep retries');
  }
}
