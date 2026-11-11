import { pipeline, Readable, Transform } from 'node:stream';
import type { Config } from '../config/types.ts';
import { extractMetadata, type MetadataFile, type PublishWarning } from '../content/metadata.ts';
import { contentTypeFor, isTextType } from '../content/mime.ts';
import type { ArtifactRow, UserRow, VersionRow, VersionSource } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { checkTarget, commitVersion, type PublishTarget } from '../domain/versions.ts';
import { publicUrl } from '../http/public-url.ts';
import { badRequest, unsupportedMediaType } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import type { BlobStore } from '../storage/blob-store.ts';
import { type ArchiveEntry, readArchive, sniffArchive } from './archive.ts';
import { IngestBudget, limitExceeded } from './limits.ts';
import {
  chooseEntry,
  MAX_PATH_LENGTH,
  normalizeEntryPath,
  quotePath,
  rejectPath,
  stripWrapperFolder,
} from './paths.ts';
import { BlobStager, type StagedFile } from './stage.ts';

export interface PublishOptions {
  actor: UserRow;
  source: VersionSource;
  message: string | null;
}

export interface PublishOutcome {
  artifact: ArtifactRow;
  version: VersionRow;
  warnings: PublishWarning[];
}

export interface UploadInput {
  body: Readable;
  contentType: string | null;
  contentLength: number | null;
  filename: string | null;
}

export interface InlineFile {
  path: string;
  content: string;
}

/** The start of a body that tells the archive formats apart (`sniffArchive` needs 262 bytes). */
const SNIFF_BYTES = 512;

/**
 * Publishes an upload body. With a `filename` it is that one file; else a Content-Type of HTML
 * or Markdown makes it `index.html` or `index.md`; else it must be a tar, tar.gz or zip, told by
 * its magic bytes whatever the Content-Type says (curl sends `application/x-www-form-urlencoded`).
 * The target is checked before any byte is read, and every limit is counted while the body
 * streams. On failure the body is destroyed and the blobs this upload added that nothing else
 * uses are removed, so no version, file row or orphan blob is left.
 */
export async function ingestUpload(
  deps: AppDeps,
  target: PublishTarget,
  input: UploadInput,
  opts: PublishOptions,
): Promise<PublishOutcome> {
  const { body } = input;
  const maxUpload = deps.config.limits.maxUploadBytes;
  try {
    await checkTarget(deps, target);
    if (input.contentLength !== null && input.contentLength > maxUpload) {
      throw limitExceeded('max_upload_bytes', maxUpload);
    }
  } catch (error) {
    body.destroy();
    throw error;
  }

  const budget = new IngestBudget(deps.config.limits);
  const counted = countRequestBytes(body, budget);
  const destroyBody = () => {
    body.destroy();
    counted.destroy();
  };
  return ingest(deps, target, opts, budget, destroyBody, async (stager) => {
    const single = singleFilePath(input);
    if (single !== null) {
      await stager.stage(single, counted, input.contentLength);
      return { unwrap: false };
    }
    const { head, whole } = await peek(counted, SNIFF_BYTES);
    const format = sniffArchive(head);
    if (format === null) throw unsupportedMediaType(t('publish.unsupported'));
    const paths = new Set<string>();
    await readArchive(whole, format, budget, (entry) => stageEntry(stager, paths, entry));
    return { unwrap: true };
  });
}

/**
 * Publishes a set of files given by path, such as a dropped folder: paths are normalized, macOS
 * junk is skipped and one folder wrapping every file is removed, as for an archive.
 */
export async function ingestFiles(
  deps: AppDeps,
  target: PublishTarget,
  files: readonly { path: string; data: Buffer }[],
  opts: PublishOptions,
): Promise<PublishOutcome> {
  await checkTarget(deps, target);
  const budget = new IngestBudget(deps.config.limits);
  return ingest(deps, target, opts, budget, null, async (stager) => {
    const paths = new Set<string>();
    for (const file of files) {
      const normalized = normalizeEntryPath(file.path);
      if ('skip' in normalized) continue;
      claimPath(paths, normalized.path);
      await stager.stage(normalized.path, file.data, file.data.length);
    }
    return { unwrap: true };
  });
}

/**
 * Publishes text files given as strings (HTML, Markdown, CSS, JavaScript, SVG, JSON and other
 * text types), up to `maxInlineBytes` of UTF-8 in all, then as `ingestFiles` does.
 */
export async function ingestInline(
  deps: AppDeps,
  target: PublishTarget,
  files: readonly InlineFile[],
  opts: PublishOptions,
): Promise<PublishOutcome> {
  for (const { path } of files) {
    if (!isTextType(contentTypeFor(path))) {
      throw badRequest(t('publish.inline.textOnly', { path: quotePath(path) }), {
        reason: 'inline_text_only',
        path: quotePath(path, MAX_PATH_LENGTH),
      });
    }
  }
  const max = deps.config.limits.maxInlineBytes;
  let total = 0;
  for (const { content } of files) total += Buffer.byteLength(content, 'utf8');
  if (total > max) throw limitExceeded('max_inline_bytes', max);

  const set = files.map(({ path, content }) => ({ path, data: Buffer.from(content, 'utf8') }));
  return ingestFiles(deps, target, set, opts);
}

/** The links a publish returns: the artifact's review page and the raw files of version `n`. */
export function publishLinks(
  config: Pick<Config, 'publicOrigin'>,
  artifactId: string,
  n: number,
): { review_url: string; raw_url: string } {
  return {
    review_url: publicUrl(config, `/a/${artifactId}`),
    raw_url: publicUrl(config, `/a/${artifactId}/v/${n}/raw`),
  };
}

/**
 * The steps every publish shares once its files are staged: unwrap a wrapping folder (`unwrap`),
 * choose the entry, extract metadata and commit. Any failure runs `destroyInput`, removes what the
 * stager added that nothing else uses, and rethrows.
 */
async function ingest(
  deps: AppDeps,
  target: PublishTarget,
  opts: PublishOptions,
  budget: IngestBudget,
  destroyInput: (() => void) | null,
  stageAll: (stager: BlobStager) => Promise<{ unwrap: boolean }>,
): Promise<PublishOutcome> {
  const stager = new BlobStager(deps, budget);
  try {
    const { unwrap } = await stageAll(stager);
    const files = unwrap ? withoutWrapperFolder(stager.files) : [...stager.files];
    const { entryPath, kind } = chooseEntry(files.map((file) => file.path));
    const meta = await extractMetadata(
      files.map((file) => metadataFile(deps.blobs, file)),
      entryPath,
    );
    const { artifact, version } = await commitVersion(deps, opts.actor, target, {
      entryPath,
      kind,
      files,
      meta,
      message: opts.message,
      source: opts.source,
    });
    stager.release();
    return { artifact, version, warnings: meta.warnings };
  } catch (error) {
    destroyInput?.();
    try {
      await stager.abort();
    } catch (abortError) {
      // The rows of blobs not removed stay for the sweep; the caller needs the first error.
      deps.logger.error({ err: abortError }, 'A failed upload could not remove its blobs');
    }
    throw error;
  }
}

/**
 * Stages one archive member under its normalized path. Directories and macOS junk are left
 * unread; the archive reader discards their data, which still counts toward the expansion limit.
 */
async function stageEntry(
  stager: BlobStager,
  paths: Set<string>,
  entry: ArchiveEntry,
): Promise<void> {
  const normalized = normalizeEntryPath(entry.rawPath);
  if ('skip' in normalized || entry.type === 'directory') return;
  if (entry.type === 'symlink' || entry.type === 'hardlink') {
    throw rejectPath(entry.rawPath, 'link');
  }
  if (entry.type === 'other') throw rejectPath(entry.rawPath, 'special');
  claimPath(paths, normalized.path);
  await stager.stage(normalized.path, entry.body, entry.size);
}

/** Records `path`, refusing one already taken (NFC and NFD twins are the same path by now). */
function claimPath(paths: Set<string>, path: string): void {
  if (paths.has(path)) throw rejectPath(path, 'duplicate');
  paths.add(path);
}

/** Where a single-file upload is stored, or null when the body should be an archive. */
function singleFilePath(input: UploadInput): string | null {
  if (input.filename !== null) {
    const normalized = normalizeEntryPath(input.filename);
    if ('skip' in normalized) throw badRequest(t('publish.entry.empty'), { reason: 'empty' });
    return normalized.path;
  }
  const mediaType = (input.contentType ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'text/html') return 'index.html';
  if (mediaType === 'text/markdown' || mediaType === 'text/x-markdown') return 'index.md';
  return null;
}

/** The staged files with the folder that wraps all of them removed from their paths. */
function withoutWrapperFolder(files: readonly StagedFile[]): StagedFile[] {
  const { prefix } = stripWrapperFolder(files.map((file) => file.path));
  if (prefix === null) return [...files];
  return files.map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
}

/** A staged file as metadata extraction reads it: by ranged reads of its blob's head. */
function metadataFile(blobs: BlobStore, file: StagedFile): MetadataFile {
  return {
    path: file.path,
    contentType: file.contentType,
    size: file.size,
    read: (max) => readHead(blobs, file.sha256, Math.min(file.size, max)),
  };
}

async function readHead(blobs: BlobStore, sha256: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for await (const part of await blobs.get(sha256, { start: 0, end: length - 1 })) {
    parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  }
  return Buffer.concat(parts);
}

/**
 * `body` passed through a counter of request bytes, which fails with the 413 as soon as the
 * upload limit is crossed. An error on either side destroys both.
 */
function countRequestBytes(body: Readable, budget: IngestBudget): Readable {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        budget.onRequestBytes(chunk.length);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  // Errors reach whoever reads the counter; the pipeline only links the two streams' ends.
  pipeline(body, counter, () => {});
  return counter;
}

/**
 * The first `n` bytes of `stream` (all of it when shorter) and a stream of every byte: `stream`
 * itself with the head put back, or, when it has already ended, a stream of the head alone.
 */
function peek(stream: Readable, n: number): Promise<{ head: Buffer; whole: Readable }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const settle = () => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('close', onClose);
      return Buffer.concat(chunks);
    };
    const onReadable = () => {
      while (length < n) {
        const chunk: Buffer | null = stream.read();
        if (chunk === null) return;
        chunks.push(chunk);
        length += chunk.length;
      }
      const head = settle();
      stream.unshift(head);
      resolve({ head, whole: stream });
    };
    const onEnd = () => {
      const head = settle();
      resolve({ head, whole: Readable.from([head], { objectMode: false }) });
    };
    const onError = (error: Error) => {
      settle();
      reject(error);
    };
    const onClose = () => {
      settle();
      reject(new Error('The upload body closed before it ended'));
    };
    stream.on('readable', onReadable);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onClose);
  });
}
