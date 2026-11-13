import { extractVersionText } from '../content/metadata.ts';
import { type DbScope, searchDelete, searchUpsert } from '../db/dialect.ts';
import type { ArtifactRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { getTags, lockArtifact } from './artifacts.ts';
import { SYSTEM_SCOPE } from './spaces.ts';

/** The event topic of one artifact: new versions, deletions and (from M5) comments. */
export const ARTIFACT_TOPIC = (artifactId: string) => `artifact:${artifactId}`;

/**
 * Indexes the artifact's name, tags and the search text of its current version. Inside a commit,
 * pass `{ db: trx, dialect }` so the index changes with the rows; on SQLite a call through the
 * outer handle would wait for the transaction forever.
 */
export function indexArtifact(
  scope: DbScope,
  artifact: ArtifactRow,
  tags: readonly string[],
  text: string,
): Promise<void> {
  return searchUpsert(scope, {
    artifactId: artifact.id,
    name: artifact.name,
    tags: tags.join(' '),
    body: text,
  });
}

/**
 * Indexes the artifact again from its rows and its current version's files, after a change that
 * did not index it itself (a rename, new tags). An artifact without a current version, or that
 * no longer exists, leaves the index.
 */
export async function reindexArtifact(deps: AppDeps, artifactId: string): Promise<void> {
  const { db, dialect } = deps.db;
  const before = await db
    .selectFrom('artifacts')
    .select('current_version_id')
    .where('id', '=', artifactId)
    .executeTakeFirst();
  const versionId = before?.current_version_id ?? null;
  // Read first: it reads blobs, and on SQLite the transaction below holds the only connection.
  const text = versionId === null ? '' : await extractVersionText(deps, versionId);

  await db.transaction().execute(async (trx) => {
    const scope = { db: trx, dialect };
    // Index maintenance serves every viewer: the index follows the artifact whoever sees it.
    const artifact = await lockArtifact(trx, dialect, SYSTEM_SCOPE, artifactId);
    if (artifact === undefined || artifact.current_version_id === null) {
      await searchDelete(scope, artifactId);
      return;
    }
    // Whatever changed the current version meanwhile indexed it, with newer text than ours.
    if (artifact.current_version_id !== versionId) return;
    await indexArtifact(scope, artifact, await getTags(trx, artifactId), text);
  });
}
