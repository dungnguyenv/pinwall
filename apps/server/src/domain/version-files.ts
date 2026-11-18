import { isTextType } from '../content/mime.ts';
import type { ArtifactRow, VersionFileRow, VersionRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { formatBytes } from '../lib/format.ts';
import { t } from '../lib/i18n.ts';
import { flatten } from '../mcp/format.ts';
import { getArtifact } from './artifacts.ts';
import type { Scope } from './spaces.ts';
import { getCurrentVersion, getVersionByNumber } from './versions.ts';

/** A file larger than this is not read as text. */
export const READ_TEXT_MAX_BYTES = 5_000_000;

/** A NUL in the first this many bytes marks a file as binary. */
const NUL_SNIFF_BYTES = 8_000;

/** Folder requests try these, in order, as `content/serve.ts` does. */
const INDEX_NAMES = ['index.html', 'index.md'] as const;

/**
 * Keeps a leading BOM in the text, so a caller that writes the text back keeps it byte for byte;
 * invalid UTF-8 throws instead of becoming U+FFFD.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Version `n` of the artifact `artifactId`, or its current version when `n` is left out, for a
 * caller who sees it. An artifact that is missing or that `scope` does not see answers as
 * `getArtifact` does (404, or 410 when deleted); a version number that was never given out, or an
 * artifact without a current version, answers `not_found`; one that was deleted answers 410.
 */
export async function versionFor(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  n?: number,
): Promise<{ artifact: ArtifactRow; version: VersionRow }> {
  const { db } = deps.db;
  const artifact = await getArtifact(db, scope, artifactId, deps.clock.now());
  if (n !== undefined) return { artifact, version: await getVersionByNumber(db, artifact, n) };
  if (artifact.current_version_id === null) throw notFound(t('version.noCurrent'));
  return { artifact, version: await getCurrentVersion(db, artifact) };
}

/**
 * The file of `version` at `path`, which must match a stored path exactly (stored paths are in
 * NFC, so `path` is taken in NFC too), or the version's entry page when `path` is left out;
 * `not_found` with `details.reason: 'no_file'` when there is no such file.
 */
export async function fileOf(
  deps: AppDeps,
  version: VersionRow,
  path?: string,
): Promise<VersionFileRow> {
  const file = await deps.db.db
    .selectFrom('version_files')
    .selectAll()
    .where('version_id', '=', version.id)
    .where('path', '=', path === undefined ? version.entry_path : path.normalize('NFC'))
    .executeTakeFirst();
  if (file === undefined) throw notFound(t('version.fileNotFound'), { reason: 'no_file' });
  return file;
}

/**
 * The files of `version` at `paths`, by path, in one query: each path must match a stored path
 * exactly (already normalized, as stored paths are). A path with no file is left out.
 */
export async function filesAt(
  deps: AppDeps,
  version: VersionRow,
  paths: readonly string[],
): Promise<Map<string, VersionFileRow>> {
  if (paths.length === 0) return new Map();
  const rows = await deps.db.db
    .selectFrom('version_files')
    .selectAll()
    .where('version_id', '=', version.id)
    .where('path', 'in', paths)
    .execute();
  return new Map(rows.map((row) => [row.path, row]));
}

/** The 400 for a file that is not text, with what the caller needs to tell it from the rest. */
function notText(file: VersionFileRow): AppError {
  return badRequest(
    t('version.fileNotText', {
      // A path is the publisher's: one line, whatever it holds.
      path: flatten(file.path),
      content_type: file.content_type,
      size: formatBytes(file.size),
    }),
    { reason: 'not_text', size: file.size, content_type: file.content_type },
  );
}

/**
 * The bytes of a stored file. A blob a version lists is never missing unless storage lost it, so
 * the store's `not_found` becomes a server error here, not a 404 that reads as "no such file".
 */
async function bytesOf(deps: AppDeps, file: VersionFileRow): Promise<Buffer> {
  if (file.size === 0) return Buffer.alloc(0);
  try {
    return Buffer.concat(await (await deps.blobs.get(file.sha256)).toArray());
  } catch (error) {
    if (error instanceof AppError) {
      throw new Error(`The stored file ${file.path} (${file.sha256}) cannot be read`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * The text of a stored file, decoded as UTF-8 with a leading BOM kept. Refuses with
 * `bad_request` and `details.reason`: `not_text` (with `size` and `content_type`) for a file whose
 * type is not text, that has a NUL in its first 8,000 bytes or that is not valid UTF-8, and
 * `too_large` for one over `READ_TEXT_MAX_BYTES`, which is never read.
 */
export async function readText(deps: AppDeps, file: VersionFileRow): Promise<string> {
  if (!isTextType(file.content_type)) throw notText(file);
  if (file.size > READ_TEXT_MAX_BYTES) {
    throw badRequest(
      t('version.fileTooLarge', {
        path: flatten(file.path),
        size: formatBytes(file.size),
        max: formatBytes(READ_TEXT_MAX_BYTES),
      }),
      { reason: 'too_large', size: file.size, max: READ_TEXT_MAX_BYTES },
    );
  }
  const bytes = await bytesOf(deps, file);
  if (bytes.subarray(0, NUL_SNIFF_BYTES).includes(0)) throw notText(file);
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw notText(file);
    throw error;
  }
}

/**
 * The file a page of a version is served from, as `content/serve.ts` resolves a request: `''` is
 * the entry, `x/` is `x/index.html` and then `x/index.md`, and `x` is the file `x` itself, then
 * `x/index.html`, then `x/index.md`. `paths` are the version's file paths; null when none is there.
 */
export function pageFilePath(
  page: string,
  entryPath: string,
  paths: ReadonlySet<string>,
): string | null {
  if (page === '') return paths.has(entryPath) ? entryPath : null;
  const isFolder = page.endsWith('/');
  const folder = isFolder ? page : `${page}/`;
  const candidates = [...(isFolder ? [] : [page]), ...INDEX_NAMES.map((name) => folder + name)];
  return candidates.find((path) => paths.has(path)) ?? null;
}
