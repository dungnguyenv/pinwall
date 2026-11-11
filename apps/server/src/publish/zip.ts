import { crc32 } from 'node:zlib';
import { Inflate } from 'fflate';
import { badRequest, unsupportedMediaType } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { corruptArchive, type EntryType } from './archive.ts';
import type { IngestBudget } from './limits.ts';
import { MAX_PATH_LENGTH, quotePath } from './paths.ts';

/**
 * ZIP reading driven by the central directory, after the PKWARE APPNOTE. fflate's unzip does not
 * expose the external attributes that mark symlinks and devices, so Pinwall parses the directory
 * itself and uses fflate only to inflate entry data. ZIP64 and multi-disk archives are refused.
 */

export interface ZipEntryInfo {
  name: string;
  type: EntryType;
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  localHeaderOffset: number;
  encrypted: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_LENGTH = 22;
const CENTRAL_LENGTH = 46;
const LOCAL_LENGTH = 30;
/** The end record sits in the last 22 bytes plus a comment of up to 65,535 bytes. */
const EOCD_SEARCH = EOCD_LENGTH + 0xffff;
const MAX16 = 0xffff;
const MAX32 = 0xffff_ffff;

const STORED = 0;
const DEFLATED = 8;
/** Traditional PKWARE encryption (bit 0) and strong encryption (bit 6). */
const ENCRYPTION_FLAGS = 0x0001 | 0x0040;
/** "Version made by" host system whose external attributes carry a Unix `st_mode`. */
const UNIX_HOST = 3;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Compressed bytes handed to the inflater at a time. */
const FEED_BYTES = 65_536;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Parses the end record and the central directory of `zip`, checking every offset against the
 * buffer and that no two entries share bytes. Throws `corruptArchive()` for anything that does
 * not add up and the ZIP64 415 for archives that need ZIP64 fields.
 */
export function readZipDirectory(zip: Buffer): ZipEntryInfo[] {
  const eocd = findEndRecord(zip);
  const disk = zip.readUInt16LE(eocd + 4);
  const centralDisk = zip.readUInt16LE(eocd + 6);
  const entriesOnDisk = zip.readUInt16LE(eocd + 8);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (
    [disk, centralDisk, entriesOnDisk, entryCount].includes(MAX16) ||
    centralSize === MAX32 ||
    centralOffset === MAX32
  ) {
    throw zip64Refused();
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw corruptArchive();
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > eocd) throw corruptArchive();

  const entries: ZipEntryInfo[] = [];
  let at = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (at + CENTRAL_LENGTH > centralEnd || zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw corruptArchive();
    }
    const madeBy = zip.readUInt16LE(at + 4);
    const flags = zip.readUInt16LE(at + 8);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const startDisk = zip.readUInt16LE(at + 34);
    const localHeaderOffset = zip.readUInt32LE(at + 42);
    if ([compressedSize, size, localHeaderOffset].includes(MAX32) || startDisk === MAX16) {
      throw zip64Refused();
    }
    const nameEnd = at + CENTRAL_LENGTH + nameLength;
    const next = nameEnd + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (startDisk !== 0 || next > centralEnd) throw corruptArchive();

    const name = decodeName(zip.subarray(at + CENTRAL_LENGTH, nameEnd));
    entries.push({
      name,
      type: entryType(name, madeBy, zip.readUInt32LE(at + 38)),
      method: zip.readUInt16LE(at + 10),
      compressedSize,
      size,
      crc32: zip.readUInt32LE(at + 16),
      localHeaderOffset,
      encrypted: (flags & ENCRYPTION_FLAGS) !== 0,
    });
    at = next;
  }

  checkLayout(zip, entries, centralOffset);
  return entries;
}

/**
 * The decoded bytes of a file entry, in chunks, each counted with `budget.onExpandedBytes`. Throws
 * when the entry is encrypted or uses a method other than store or deflate, and `corruptArchive()`
 * as soon as the data outgrows its declared size or, at the end, when its size or CRC-32 differs
 * from the central directory. Nothing runs until the first chunk is asked for.
 */
export function* zipEntryChunks(
  zip: Buffer,
  entry: ZipEntryInfo,
  budget: IngestBudget,
): Generator<Buffer, void, undefined> {
  const path = { path: quotePath(entry.name) };
  const details = { path: quotePath(entry.name, MAX_PATH_LENGTH) };
  if (entry.encrypted) {
    throw badRequest(t('publish.archive.encrypted', path), { reason: 'encrypted', ...details });
  }
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw badRequest(t('publish.archive.zipMethod', path), { reason: 'zip_method', ...details });
  }

  const { start, end } = dataSpan(zip, entry);
  const data = zip.subarray(start, end);
  let produced = 0;
  let checksum = 0;
  const account = (chunk: Buffer): Buffer => {
    produced += chunk.length;
    if (produced > entry.size) throw corruptArchive();
    budget.onExpandedBytes(chunk.length);
    checksum = crc32(chunk, checksum);
    return chunk;
  };

  if (entry.method === STORED) {
    if (entry.compressedSize !== entry.size) throw corruptArchive();
    for (let at = 0; at < data.length; at += FEED_BYTES) {
      yield account(data.subarray(at, at + FEED_BYTES));
    }
  } else {
    const output: Uint8Array[] = [];
    const inflater = new Inflate((chunk) => {
      if (chunk.length > 0) output.push(chunk);
    });
    for (let at = 0; ; at += FEED_BYTES) {
      const final = at + FEED_BYTES >= data.length;
      try {
        inflater.push(data.subarray(at, at + FEED_BYTES), final);
      } catch {
        throw corruptArchive();
      }
      for (const chunk of output.splice(0)) {
        yield account(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
      if (final) break;
    }
  }

  if (produced !== entry.size || checksum !== entry.crc32) throw corruptArchive();
}

function zip64Refused() {
  return unsupportedMediaType(t('publish.archive.zip64'), { reason: 'zip64' });
}

/** The offset of the end-of-central-directory record, searched from the end. */
function findEndRecord(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - EOCD_SEARCH);
  for (let at = zip.length - EOCD_LENGTH; at >= lowest; at -= 1) {
    if (zip.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    if (at + EOCD_LENGTH + zip.readUInt16LE(at + 20) <= zip.length) return at;
  }
  throw corruptArchive();
}

/** Names are UTF-8 in practice whatever the flags say; anything that is not decodes as latin1. */
function decodeName(bytes: Buffer): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

function entryType(name: string, madeBy: number, externalAttributes: number): EntryType {
  if (name.endsWith('/')) return 'directory';
  if (madeBy >>> 8 !== UNIX_HOST) return 'file';
  switch ((externalAttributes >>> 16) & S_IFMT) {
    case S_IFLNK:
      return 'symlink';
    case S_IFDIR:
      return 'directory';
    case S_IFREG:
    case 0:
      return 'file';
    default:
      return 'other';
  }
}

/** Where an entry's compressed bytes lie, after its local header. */
function dataSpan(zip: Buffer, entry: ZipEntryInfo): { start: number; end: number } {
  const at = entry.localHeaderOffset;
  if (at + LOCAL_LENGTH > zip.length || zip.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw corruptArchive();
  }
  const start = at + LOCAL_LENGTH + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw corruptArchive();
  return { start, end };
}

/**
 * Every entry's local header and data must lie before the central directory without touching
 * another entry's. Entries that share bytes are how a small zip expands into many large files.
 */
function checkLayout(zip: Buffer, entries: readonly ZipEntryInfo[], centralOffset: number): void {
  const spans = entries
    .map((entry) => ({ header: entry.localHeaderOffset, end: dataSpan(zip, entry).end }))
    .sort((a, b) => a.header - b.header);
  let previousEnd = 0;
  for (const span of spans) {
    if (span.header < previousEnd) throw corruptArchive();
    previousEnd = span.end;
  }
  if (previousEnd > centralOffset) throw corruptArchive();
}
