import { createHash } from 'node:crypto';
import type { AppDeps } from '../../src/deps.ts';
import { newId } from '../../src/lib/ids.ts';

/** The lowercase hex SHA-256 of `text` as UTF-8: the blob key of those bytes. */
export function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Makes `sha256` referenced as a committed version would: inserts a project, an artifact, a
 * version and one `version_files` row pointing at it. Returns the version id.
 */
export async function ref(deps: AppDeps, sha256: string): Promise<string> {
  const now = deps.clock.now();
  const projectId = newId('prj');
  const artifactId = newId('art');
  const versionId = newId('ver');
  const { db } = deps.db;
  await db
    .insertInto('projects')
    .values({
      id: projectId,
      name: 'Blobs',
      instructions: '',
      is_default: 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('artifacts')
    .values({
      id: artifactId,
      project_id: projectId,
      name: 'Blob holder',
      kind: 'html',
      latest_number: 1,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('versions')
    .values({
      id: versionId,
      artifact_id: artifactId,
      number: 1,
      entry_path: 'index.html',
      file_count: 1,
      total_bytes: 0,
      source: 'api',
      meta: '{}',
      created_at: now,
    })
    .execute();
  await db
    .insertInto('version_files')
    .values({
      version_id: versionId,
      path: 'index.html',
      sha256,
      size: 0,
      content_type: 'text/html; charset=utf-8',
    })
    .execute();
  return versionId;
}

/** Stores `text` as a blob (object and `blobs` row) that no version references. */
export async function storeBlob(deps: AppDeps, text: string): Promise<string> {
  const bytes = Buffer.from(text);
  const key = sha(text);
  await deps.db.db
    .insertInto('blobs')
    .values({ sha256: key, size: bytes.length, created_at: deps.clock.now() })
    .execute();
  await deps.blobs.put(key, bytes, bytes.length);
  return key;
}

/** Whether the `blobs` row and the stored object of `sha256` exist. */
export async function blobState(
  deps: AppDeps,
  sha256: string,
): Promise<{ row: boolean; object: boolean }> {
  const row = await deps.db.db
    .selectFrom('blobs')
    .select('sha256')
    .where('sha256', '=', sha256)
    .executeTakeFirst();
  return { row: row !== undefined, object: await deps.blobs.has(sha256) };
}
