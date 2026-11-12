import type { Config } from '../config/types.ts';
import { type AppError, payloadTooLarge } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { MAX_PATH_LENGTH, quotePath } from './paths.ts';

export type LimitName =
  | 'max_upload_bytes'
  | 'max_file_bytes'
  | 'max_version_bytes'
  | 'max_files'
  | 'max_expansion_ratio'
  | 'max_inline_bytes';

/**
 * The expansion ratio is measured against at least this many request bytes, so a tiny archive
 * holding a few well-compressed text files is not mistaken for a bomb.
 */
export const EXPANSION_FLOOR_BYTES = 65_536;

/**
 * An archive may hold this many members of any kind (directories, links, macOS junk) per file
 * `max_files` allows. Members that never become files cost time too.
 */
export const ENTRIES_PER_FILE = 4;

/** The 413 for one limit, naming its setting; `path` names the file that crossed it. */
export function limitExceeded(limit: LimitName, max: number, path?: string): AppError {
  const key = `publish.limit.${limit}`;
  if (path === undefined) return payloadTooLarge(t(key, { max }), { limit, max });
  return payloadTooLarge(t(key, { max, path: quotePath(path) }), {
    limit,
    max,
    path: quotePath(path, MAX_PATH_LENGTH),
  });
}

/**
 * Counts one publish against `config.limits` while it streams, and throws `limitExceeded` the
 * moment a count goes over. Request bytes are what arrived on the wire; expanded bytes are what
 * decompression produced; file bytes are what each file holds.
 */
export class IngestBudget {
  private requestBytes = 0;
  private expandedBytes = 0;
  private entries = 0;
  private files = 0;
  private versionBytes = 0;
  private file: { path: string; bytes: number } | null = null;

  constructor(private readonly limits: Config['limits']) {}

  /** Request bytes counted so far, including the chunk that crossed the limit, if one did. */
  get requestBytesRead(): number {
    return this.requestBytes;
  }

  onRequestBytes(n: number): void {
    this.requestBytes += n;
    const max = this.limits.maxUploadBytes;
    if (this.requestBytes > max) throw limitExceeded('max_upload_bytes', max);
  }

  onExpandedBytes(n: number): void {
    this.expandedBytes += n;
    const ratio = this.limits.maxExpansionRatio;
    if (this.expandedBytes > ratio * Math.max(this.requestBytes, EXPANSION_FLOOR_BYTES)) {
      throw limitExceeded('max_expansion_ratio', ratio);
    }
  }

  /** Counts one archive member of any kind, before anything else is done with it. */
  onArchiveEntry(): void {
    this.entries += 1;
    const max = this.limits.maxFiles;
    if (this.entries > ENTRIES_PER_FILE * max) throw limitExceeded('max_files', max);
  }

  /** Opens the next file; `declaredSize` is the size its header claims, when it has one. */
  startFile(path: string, declaredSize: number | null): void {
    this.files += 1;
    if (this.files > this.limits.maxFiles) throw limitExceeded('max_files', this.limits.maxFiles);
    const max = this.limits.maxFileBytes;
    if (declaredSize !== null && declaredSize > max) {
      throw limitExceeded('max_file_bytes', max, path);
    }
    this.file = { path, bytes: 0 };
  }

  /** Counts bytes of the file opened by the last `startFile`. */
  onFileBytes(n: number): void {
    if (this.file === null) throw new Error('IngestBudget.onFileBytes called before startFile');
    this.file.bytes += n;
    const maxFile = this.limits.maxFileBytes;
    if (this.file.bytes > maxFile) throw limitExceeded('max_file_bytes', maxFile, this.file.path);
    this.versionBytes += n;
    const maxVersion = this.limits.maxVersionBytes;
    if (this.versionBytes > maxVersion) throw limitExceeded('max_version_bytes', maxVersion);
  }
}
