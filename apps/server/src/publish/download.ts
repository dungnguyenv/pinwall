import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { type Pack, pack } from 'tar-stream';
import type { UserRow, VersionFileRow, VersionRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { getArtifact } from '../domain/artifacts.ts';
import { scopeForUser } from '../domain/spaces.ts';
import { versionFor } from '../domain/version-files.ts';
import { versionOf } from '../domain/versions.ts';
import { publicUrl } from '../http/public-url.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newSecret } from '../lib/ids.ts';
import { activeUser, shellQuote, userGroup } from './sessions.ts';

/** What a download URL fetches, and for whom; stored under the hash of its token. */
export interface DownloadSession {
  actorId: string;
  versionId: string;
  artifactId: string;
}

const sessionKey = (h: string) => `download:${h}`;

/** Files go into the archive with this mode: a download is a copy to read and edit. */
const FILE_MODE = 0o644;

/**
 * Makes a one-time download URL for version `p.version` of the artifact `p.artifactId` (the
 * current version when left out), valid for `PINWALL_UPLOAD_SESSION_TTL`, with the shell command
 * that unpacks it into `p.directory` (default `./pinwall-<artifactId>`). The caller must see the
 * artifact now, so another space's id answers `not_found` here, as for an id that does not exist.
 * The URL is a capability, like an upload URL: only the hash of its token is stored, in the
 * user's group, so "Revoke now" drops it with the rest.
 */
export async function createDownloadSession(
  deps: AppDeps,
  actor: UserRow,
  p: { artifactId: string; version?: number; directory?: string },
): Promise<{
  url: string;
  command: string;
  expiresAt: number;
  version: { id: string; number: number };
}> {
  const { artifact, version } = await versionFor(
    deps,
    scopeForUser(deps, actor),
    p.artifactId,
    p.version,
  );
  const token = newSecret();
  const ttl = deps.config.ttl.uploadSessionMs;
  const expiresAt = deps.clock.now() + ttl;
  const session: DownloadSession = {
    actorId: actor.id,
    versionId: version.id,
    artifactId: artifact.id,
  };
  await deps.oneTime.put(sessionKey(hashSecret(token)), session, ttl, userGroup(actor.id));

  const url = publicUrl(deps.config, `/download/${token}`);
  return {
    url,
    command: downloadCommand(url, p.directory ?? `./pinwall-${artifact.id}`),
    expiresAt,
    version: { id: version.id, number: version.number },
  };
}

/**
 * The shell command that fetches `url` and unpacks the archive into `directory`. `--fail-with-body`
 * makes curl exit non-zero, and show the error, for a refused URL; the pipe ends the archive
 * with tar's own check of the gzip stream, so one cut short fails as well.
 */
export function downloadCommand(url: string, directory: string): string {
  const dir = shellQuote(directory);
  return `mkdir -p ${dir} && curl --fail-with-body -sS "${url}" | tar -xzf - -C ${dir}`;
}

/** The answer for every URL that cannot be used, whatever the reason: it tells nothing more. */
const unknownDownload = () => notFound(t('download.session.unknown'));

/**
 * Uses the download URL behind `token`: it works once, and answers `not_found` (with how to get
 * a new one) when it is unknown, used or expired. The session's user must still have access and
 * see the artifact, and the version must still exist; if not, the answer is the same, so the
 * route never reveals whether an artifact exists. Returns the archive as a stream, a gzipped tar
 * of the version's files in path order, and the file name to offer it under.
 *
 * Nothing is buffered: each blob is read when the client has taken what came before it. When a
 * blob cannot be read the stream fails, so the response ends without its end (it was a 200
 * already): curl reports it, and what arrived is not a whole gzip stream, so tar fails too.
 */
export async function runDownload(
  deps: AppDeps,
  token: string,
): Promise<{ body: Readable; filename: string }> {
  const session = await deps.oneTime.take<DownloadSession>(sessionKey(hashSecret(token)));
  if (session === null) throw unknownDownload();
  const { artifactId, version } = await stillAllowed(deps, session);
  const files = await deps.db.db
    .selectFrom('version_files')
    .selectAll()
    .where('version_id', '=', version.id)
    .execute();
  // By bytes, whatever the database collates by.
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return {
    body: archiveOf(deps, version, files),
    filename: `pinwall-${artifactId}-v${version.number}.tar.gz`,
  };
}

/**
 * The version a session is for, once the user's access, their view of the artifact and the
 * version are checked again, as `runUpload` checks its creator again. Any refusal is the uniform
 * `not_found`; a failure that is not a refusal (the database) stays one.
 */
async function stillAllowed(
  deps: AppDeps,
  session: DownloadSession,
): Promise<{ artifactId: string; version: VersionRow }> {
  try {
    const actor = await activeUser(deps, session.actorId);
    const { db } = deps.db;
    const artifact = await getArtifact(
      db,
      scopeForUser(deps, actor),
      session.artifactId,
      deps.clock.now(),
    );
    return { artifactId: artifact.id, version: await versionOf(db, artifact, session.versionId) };
  } catch (error) {
    if (error instanceof AppError && error.status < 500) throw unknownDownload();
    throw error;
  }
}

/**
 * The files as a gzipped tar stream. The entries are written as the stream is read (the pack
 * and the gzip push back when the client is slow). A failure destroys both with its error. A
 * client that goes away destroys the gzip, which ends the pack: the blob being read is closed
 * and no other is opened.
 */
function archiveOf(deps: AppDeps, version: VersionRow, files: VersionFileRow[]): Readable {
  const archive = pack();
  const gzip = createGzip();
  // A failure reaches the reader through `gzip`; these keep it from also being thrown as an
  // 'error' event nobody listens for, which ends the process. A later reader still gets it.
  archive.on('error', () => {});
  gzip.on('error', () => {});
  archive.pipe(gzip);

  const mtime = new Date(version.created_at);
  void (async () => {
    for (const file of files) {
      if (archive.destroyed) return;
      await addFile(deps, archive, file, mtime);
    }
    archive.finalize();
  })().catch((error: Error) => {
    // A reader that went away destroyed the archive first: what failed is only the result.
    if (!archive.destroyed) {
      deps.logger.warn({ err: error, version_id: version.id }, 'A download archive failed');
    }
    archive.destroy(error);
    gzip.destroy(error);
  });
  return gzip;
}

/** Adds `file` to `archive`, its bytes read from the blob store as the archive takes them. */
async function addFile(
  deps: AppDeps,
  archive: Pack,
  file: VersionFileRow,
  mtime: Date,
): Promise<void> {
  // An empty file has no bytes to read (the store may not even hold it).
  const blob = file.size === 0 ? null : await blobOf(deps, file);
  try {
    let settle: (error?: Error | null) => void = () => {};
    const added = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    // Settles when the entry is complete, or with the error that ended it; it is awaited below,
    // and caught here so an early failure is never unhandled.
    added.catch(() => {});
    const sink = archive.entry(
      { name: file.path, size: file.size, mtime, type: 'file', mode: FILE_MODE },
      (error) => settle(error),
    );
    sink.on('error', () => {});
    for await (const chunk of blob ?? []) {
      if (!sink.write(chunk as Buffer)) await Promise.race([once(sink, 'drain'), added]);
    }
    sink.end(null); // no last chunk
    await added;
  } finally {
    blob?.destroy();
  }
}

/**
 * The stream of a stored file. A blob a version lists is never missing unless storage lost it,
 * so the store's `not_found` becomes a server error here, as `readText` makes it.
 */
async function blobOf(deps: AppDeps, file: VersionFileRow): Promise<Readable> {
  try {
    return await deps.blobs.get(file.sha256);
  } catch (error) {
    if (error instanceof AppError) {
      throw new Error(`The stored file ${file.path} (${file.sha256}) cannot be read`, {
        cause: error,
      });
    }
    throw error;
  }
}
