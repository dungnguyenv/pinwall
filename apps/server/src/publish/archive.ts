import { PassThrough, Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { extract, type Header } from 'tar-stream';
import { AppError, badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import type { IngestBudget } from './limits.ts';
import { readZipDirectory, zipEntryChunks } from './zip.ts';

export type ArchiveFormat = 'tar' | 'tar.gz' | 'zip';

export type EntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';

/** One archive member as its archive describes it; nothing about it is checked yet. */
export interface ArchiveEntry {
  rawPath: string;
  type: EntryType;
  /** Declared size of a file; 0 for anything else. */
  size: number | null;
  /** The file's bytes; empty unless `type` is `'file'`. */
  body: Readable;
}

export type EntryHandler = (entry: ArchiveEntry) => Promise<void>;

const ZIP_LOCAL_MAGIC = Buffer.from('PK\x03\x04', 'latin1');
const ZIP_EMPTY_MAGIC = Buffer.from('PK\x05\x06', 'latin1');
const USTAR_MAGIC = Buffer.from('ustar', 'latin1');
const USTAR_OFFSET = 257;

export function corruptArchive(): AppError {
  return badRequest(t('publish.archive.corrupt'), { reason: 'corrupt_archive' });
}

/**
 * The archive format by magic bytes: gzip (taken to be tar.gz), zip (a local header, or the end
 * record of an empty zip), or ustar/GNU tar. `head` is the start of the upload; 262 bytes are
 * enough to tell them apart.
 */
export function sniffArchive(head: Buffer): ArchiveFormat | null {
  if (head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz';
  const magic = head.subarray(0, 4);
  if (magic.equals(ZIP_LOCAL_MAGIC) || magic.equals(ZIP_EMPTY_MAGIC)) return 'zip';
  const ustar = head.subarray(USTAR_OFFSET, USTAR_OFFSET + USTAR_MAGIC.length);
  if (ustar.equals(USTAR_MAGIC)) return 'tar';
  return null;
}

/**
 * Reads `input` as an archive and calls `onEntry` for each member, one at a time and in archive
 * order. `onEntry` must read `body` to the end or stop caring about it; whatever it leaves unread
 * is discarded when it resolves. Decompressed bytes are counted with `budget.onExpandedBytes`.
 *
 * Rejects with the first failure, and only once a running `onEntry` has settled: an error thrown
 * by `onEntry`, by the budget or by `input` as it is; damage, truncation or a decoder error as
 * `corruptArchive()`. `input` is never destroyed: on failure it is unpiped and left to the caller.
 * A zip is buffered whole, so `input` must already be bounded by the request limit.
 */
export async function readArchive(
  input: Readable,
  format: ArchiveFormat,
  budget: IngestBudget,
  onEntry: EntryHandler,
): Promise<void> {
  if (format === 'zip') return readZip(await readAll(input), budget, onEntry);
  return readTar(input, format === 'tar.gz', budget, onEntry);
}

function readTar(
  input: Readable,
  gzip: boolean,
  budget: IngestBudget,
  onEntry: EntryHandler,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tar = extract();
    const gunzip = gzip ? createGunzip() : null;
    const counter = gzip ? countExpanded(budget) : null;
    let failure: { error: unknown } | null = null;
    let finished = false;
    let settled = false;
    // The entry being handled. It never rejects: its failures go to `stop`.
    let current: Promise<void> = Promise.resolve();

    const settle = () => {
      void current.then(() => {
        if (settled) return;
        settled = true;
        input.off('error', stop);
        if (failure) reject(failure.error);
        else resolve();
      });
    };
    const stop = (error: unknown) => {
      if (failure) return;
      failure = { error };
      input.unpipe(gunzip ?? tar);
      gunzip?.destroy();
      counter?.destroy();
      tar.destroy(error instanceof Error ? error : corruptArchive());
      settle();
    };
    // What a body reports when its entry breaks: the reason the reader stopped, else damage.
    const entryFailure = (cause: unknown) =>
      failure?.error ?? (cause instanceof AppError ? cause : corruptArchive());

    tar.on('entry', (header, stream, next) => {
      // `stop` destroys the entry stream with its error, and a stream nobody reads (a directory,
      // or one refused right here) would throw it for want of a listener. Its failures reach the
      // reader through `stop` and the stream's iterator instead.
      stream.on('error', () => {});
      // tar-stream lets through a size it could not parse (null), and its entry stream then
      // never ends. Refuse it rather than wait.
      if (!Number.isSafeInteger(header.size) || header.size < 0) {
        stop(corruptArchive());
        return;
      }
      // tar-stream's entry streams yield Buffers.
      const data = stream as AsyncIterable<Buffer>;
      current = readTarEntry(header, data, onEntry, entryFailure).then(() => {
        if (!failure) next();
      }, stop);
    });
    tar.on('error', () => stop(corruptArchive()));
    tar.on('finish', () => {
      finished = true;
      settle();
    });
    tar.on('close', () => {
      if (!finished) stop(corruptArchive());
    });

    input.on('error', stop);
    if (gunzip && counter) {
      gunzip.on('error', () => stop(corruptArchive()));
      counter.on('error', stop);
      input.pipe(gunzip).pipe(counter).pipe(tar);
    } else {
      input.pipe(tar);
    }
  });
}

/**
 * Hands one tar member to `onEntry` and copies its data into the body meanwhile. Resolves once
 * `onEntry` has resolved and the member's data has been read to its end.
 */
async function readTarEntry(
  header: Header,
  stream: AsyncIterable<Buffer>,
  onEntry: EntryHandler,
  entryFailure: (cause: unknown) => unknown,
): Promise<void> {
  const type = tarEntryType(header.type);
  const size = type === 'file' ? header.size : 0;
  const body = new PassThrough();
  if (type !== 'file') body.end();

  // tar-stream sends no data to a directory's stream, whatever its header says, and that stream
  // may never end; any other member's data must be read through to reach the next header.
  const transfer =
    header.type === 'directory'
      ? Promise.resolve()
      : copyEntry(stream, type === 'file' ? body : null, size);
  const copied = transfer.catch((cause: unknown) => {
    const error = entryFailure(cause);
    body.destroy(error instanceof Error ? error : undefined);
    throw error;
  });
  copied.catch(() => {}); // awaited below once onEntry is done; until then, not unhandled
  try {
    await onEntry({ rawPath: header.name, type, size, body });
  } finally {
    body.destroy();
  }
  await copied;
}

/**
 * Reads a member's data to its end, writing it to `body` while `body` is open and discarding it
 * once `body` is closed or when there is none.
 */
async function copyEntry(
  stream: AsyncIterable<Buffer>,
  body: PassThrough | null,
  size: number,
): Promise<void> {
  let received = 0;
  for await (const chunk of stream) {
    received += chunk.length;
    if (body === null || body.destroyed) continue;
    if (!body.write(chunk)) await drainedOrClosed(body);
  }
  if (body === null) return;
  if (received !== size) throw corruptArchive();
  if (!body.destroyed) body.end();
}

function drainedOrClosed(stream: PassThrough): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });
}

/** tar-stream reports a type flag it does not know as `null`. */
function tarEntryType(type: Header['type'] | null): EntryType {
  switch (type) {
    case 'file':
    case 'contiguous-file':
      return 'file';
    case 'directory':
      return 'directory';
    case 'symlink':
      return 'symlink';
    case 'link':
      return 'hardlink';
    default:
      return 'other';
  }
}

/** Counts gunzip output against the expansion limit before tar parsing sees it. */
function countExpanded(budget: IngestBudget): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        budget.onExpandedBytes(chunk.length);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

async function readZip(zip: Buffer, budget: IngestBudget, onEntry: EntryHandler): Promise<void> {
  for (const entry of readZipDirectory(zip)) {
    const isFile = entry.type === 'file';
    const body = isFile
      ? Readable.from(zipEntryChunks(zip, entry, budget), { objectMode: false })
      : Readable.from([]);
    // A failing body is the root cause, whatever onEntry makes of it.
    const bodyFailure: { error?: unknown } = {};
    body.on('error', (error) => {
      if (!('error' in bodyFailure)) bodyFailure.error = error;
    });
    try {
      await onEntry({ rawPath: entry.name, type: entry.type, size: isFile ? entry.size : 0, body });
    } catch (error) {
      throw 'error' in bodyFailure ? bodyFailure.error : error;
    } finally {
      body.destroy();
    }
    if ('error' in bodyFailure) throw bodyFailure.error;
  }
}

async function readAll(input: Readable): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks);
}
