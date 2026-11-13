import { createTwoFilesPatch, diffArrays } from 'diff';
import type { Db } from '../auth/passkeys.ts';
import {
  MARKDOWN_RENDER_MAX_BYTES,
  type MarkdownBlock,
  renderMarkdownBlocks,
} from '../content/markdown.ts';
import { isMarkdownType, isTextType } from '../content/mime.ts';
import type { VersionRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { getArtifact } from './artifacts.ts';
import type { Scope } from './spaces.ts';
import { getVersionByNumber } from './versions.ts';

/** A side of a text diff is at most this many bytes; a bigger file is not read. */
export const TEXT_DIFF_MAX_BYTES = 1_000_000;
/** A side of a text diff has at most this many lines. */
export const TEXT_DIFF_MAX_LINES = 50_000;
/**
 * Most lines one text diff may add and remove. Myers' algorithm needs time quadratic in this
 * (about 0.25 s at the limit, whatever the file size), so two big files with little in common
 * stop here instead of holding the server.
 */
export const TEXT_DIFF_MAX_EDITS = 2_000;
/** The same, as a clock: no diff runs longer than this, however the machine is loaded. */
const DIFF_TIMEOUT_MS = 1_000;
/** A file is binary when a NUL byte is among its first this many bytes. */
const BINARY_SNIFF_BYTES = 8_000;
/** A rendered Markdown diff may add and remove this many blocks before blocks are only paired. */
export const MARKDOWN_DIFF_MAX_EDITS = 1_000;

/** One side of a changed file. */
export interface FileSide {
  sha256: string;
  size: number;
  content_type: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  old: FileSide | null;
  new: FileSide | null;
}

type StoredFile = FileSide & { path: string };

/**
 * The files that differ between versions `from` and `to` of an artifact, compared by content
 * hash and sorted by path; files that are the same in both are left out. An artifact or a version
 * that is missing, or an artifact `scope` does not see, answers as `getArtifact` and
 * `getVersionByNumber` do.
 */
export async function diffVersionFiles(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  from: number,
  to: number,
): Promise<FileChange[]> {
  const { db } = deps.db;
  const { oldVersion, newVersion } = await versionPair(deps, scope, artifactId, from, to);
  const before = new Map((await filesOf(db, oldVersion.id)).map((file) => [file.path, file]));
  const after = new Map((await filesOf(db, newVersion.id)).map((file) => [file.path, file]));

  const changes: FileChange[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path);
    const now = after.get(path);
    if (old?.sha256 === now?.sha256) continue;
    changes.push({
      path,
      status: old === undefined ? 'added' : now === undefined ? 'removed' : 'modified',
      old: old === undefined ? null : sideOf(old),
      new: now === undefined ? null : sideOf(now),
    });
  }
  // By code unit, so the order does not depend on a database collation.
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface TextFileDiff {
  path: string;
  binary: boolean;
  too_large: boolean;
  patch: string | null;
  old: FileSide | null;
  new: FileSide | null;
}

/**
 * The unified diff of one file between two versions, three lines of context, `--- path\tv<from>`
 * and `+++ path\tv<to>`. A version without the file counts as an empty one. The file is not
 * compared (`patch` is null) when a side is binary, a type other than text or with a NUL among
 * its first 8000 bytes, or too large: over `TEXT_DIFF_MAX_BYTES` or `TEXT_DIFF_MAX_LINES`, or so
 * unlike the other side that comparing them would take more than `TEXT_DIFF_MAX_EDITS` edits.
 * Neither version having the file answers 404.
 */
export async function diffTextFile(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  from: number,
  to: number,
  path: string,
): Promise<TextFileDiff> {
  const versions = await versionPair(deps, scope, artifactId, from, to);
  const { oldFile, newFile, path: stored } = await filesAt(deps, versions, path);
  const sides = { old: oldFile ? sideOf(oldFile) : null, new: newFile ? sideOf(newFile) : null };
  const result = (rest: Pick<TextFileDiff, 'binary' | 'too_large' | 'patch'>): TextFileDiff => ({
    path: stored,
    ...rest,
    ...sides,
  });
  const present = [oldFile, newFile].filter((file) => file !== undefined);

  if (present.some((file) => !isTextType(file.content_type))) {
    return result({ binary: true, too_large: false, patch: null });
  }
  if (present.some((file) => file.size > TEXT_DIFF_MAX_BYTES)) {
    return result({ binary: false, too_large: true, patch: null });
  }
  const oldBytes = oldFile ? await readFile(deps, oldFile) : Buffer.alloc(0);
  const newBytes = newFile ? await readFile(deps, newFile) : Buffer.alloc(0);
  if (looksBinary(oldBytes) || looksBinary(newBytes)) {
    return result({ binary: true, too_large: false, patch: null });
  }
  if (lineCount(oldBytes) > TEXT_DIFF_MAX_LINES || lineCount(newBytes) > TEXT_DIFF_MAX_LINES) {
    return result({ binary: false, too_large: true, patch: null });
  }
  const patch = createTwoFilesPatch(
    stored,
    stored,
    utf8.decode(oldBytes),
    utf8.decode(newBytes),
    `v${from}`,
    `v${to}`,
    { context: 3, maxEditLength: TEXT_DIFF_MAX_EDITS, timeout: DIFF_TIMEOUT_MS },
  );
  // Undefined: the limits stopped the comparison.
  return result({ binary: false, too_large: patch === undefined, patch: patch ?? null });
}

export type BlockOp = 'unchanged' | 'added' | 'removed' | 'changed';

export interface MarkdownBlockChange {
  op: BlockOp;
  old_html: string | null;
  new_html: string | null;
}

/** A run of blocks the two documents share, or that only one of them has. */
interface Run {
  kind: 'common' | 'removed' | 'added';
  count: number;
}

/**
 * Compares two Markdown documents block by block (a paragraph, a heading, a whole list, table or
 * fence), each block with the html it renders to. Blocks are matched by their source; where a run
 * of blocks was removed and a run added at the same place, they pair off in order as `changed`
 * and the surplus is `removed` or `added`. A block whose source is the same on both sides but
 * renders differently, because a link definition elsewhere changed, is `changed` too. When the
 * documents differ in more than `MARKDOWN_DIFF_MAX_EDITS` blocks, what they share at the start
 * and the end is kept and the blocks between are paired in order. A side over
 * `MARKDOWN_RENDER_MAX_BYTES` is not parsed (see `renderMarkdownBlocks`). The html is the
 * artifact's own and untrusted: show it only in a sandboxed frame.
 */
export function diffMarkdownBlocks(oldSrc: string, newSrc: string): MarkdownBlockChange[] {
  const before = renderMarkdownBlocks(oldSrc);
  const after = renderMarkdownBlocks(newSrc);
  const runs = blockRuns(before, after);

  const changes: MarkdownBlockChange[] = [];
  let o = 0;
  let n = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run === undefined) break;
    if (run.kind === 'common') {
      for (let k = 0; k < run.count; k += 1) {
        const [old, now] = [before[o + k], after[n + k]];
        if (old === undefined || now === undefined) break;
        changes.push({
          op: old.html === now.html ? 'unchanged' : 'changed',
          old_html: old.html,
          new_html: now.html,
        });
      }
      o += run.count;
      n += run.count;
    } else if (run.kind === 'added') {
      for (let k = 0; k < run.count; k += 1) {
        changes.push({ op: 'added', old_html: null, new_html: after[n + k]?.html ?? '' });
      }
      n += run.count;
    } else {
      // A run removed, and straight after it a run added: they replace each other.
      const next = runs[i + 1];
      const added = next?.kind === 'added' ? next.count : 0;
      const paired = Math.min(run.count, added);
      for (let k = 0; k < run.count; k += 1) {
        const old = before[o + k]?.html ?? '';
        changes.push(
          k < paired
            ? { op: 'changed', old_html: old, new_html: after[n + k]?.html ?? '' }
            : { op: 'removed', old_html: old, new_html: null },
        );
      }
      for (let k = paired; k < added; k += 1) {
        changes.push({ op: 'added', old_html: null, new_html: after[n + k]?.html ?? '' });
      }
      o += run.count;
      n += added;
      if (added > 0) i += 1;
    }
  }
  return changes;
}

/** The runs that turn `before` into `after`, matching blocks by source. */
function blockRuns(before: readonly MarkdownBlock[], after: readonly MarkdownBlock[]): Run[] {
  const found = diffArrays(
    before.map((block) => block.source),
    after.map((block) => block.source),
    { maxEditLength: MARKDOWN_DIFF_MAX_EDITS, timeout: DIFF_TIMEOUT_MS },
  );
  if (found !== undefined) {
    return found.map((change) => ({
      kind: change.added ? 'added' : change.removed ? 'removed' : 'common',
      count: change.count,
    }));
  }
  // Too different to compare in bounded time: keep both ends, pair what lies between.
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && before[head]?.source === after[head]?.source) head += 1;
  let tail = 0;
  while (
    tail < shortest - head &&
    before[before.length - 1 - tail]?.source === after[after.length - 1 - tail]?.source
  ) {
    tail += 1;
  }
  return [
    { kind: 'common', count: head },
    { kind: 'removed', count: before.length - head - tail },
    { kind: 'added', count: after.length - head - tail },
    { kind: 'common', count: tail },
  ].filter((run): run is Run => run.count > 0);
}

export interface MarkdownFileDiff {
  path: string;
  too_large: boolean;
  blocks: MarkdownBlockChange[];
}

/**
 * The rendered diff of one Markdown file between two versions; a version without the file counts
 * as an empty one. `path` defaults to the entry of version `to`. A file that is not Markdown is a
 * 400, a path neither version has a 404. When a side is over `MARKDOWN_RENDER_MAX_BYTES`, the
 * most Pinwall renders, nothing is read and the answer is `too_large` with no blocks.
 */
export async function diffMarkdownFile(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  from: number,
  to: number,
  path?: string,
): Promise<MarkdownFileDiff> {
  const versions = await versionPair(deps, scope, artifactId, from, to);
  const {
    oldFile,
    newFile,
    path: stored,
  } = await filesAt(deps, versions, path ?? versions.newVersion.entry_path);
  const present = [oldFile, newFile].filter((file) => file !== undefined);
  if (!present.every((file) => isMarkdownType(file.content_type))) {
    throw badRequest(t('diff.notMarkdown'));
  }
  if (present.some((file) => file.size > MARKDOWN_RENDER_MAX_BYTES)) {
    return { path: stored, too_large: true, blocks: [] };
  }
  const oldBytes = oldFile ? await readFile(deps, oldFile) : Buffer.alloc(0);
  const newBytes = newFile ? await readFile(deps, newFile) : Buffer.alloc(0);
  return {
    path: stored,
    too_large: false,
    blocks: diffMarkdownBlocks(utf8.decode(oldBytes), utf8.decode(newBytes)),
  };
}

const utf8 = new TextDecoder('utf-8');

function sideOf(file: StoredFile): FileSide {
  return { sha256: file.sha256, size: file.size, content_type: file.content_type };
}

/** Versions `from` and `to` of the artifact, which `scope` must see; both must exist. */
async function versionPair(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  from: number,
  to: number,
): Promise<{ oldVersion: VersionRow; newVersion: VersionRow }> {
  const { db } = deps.db;
  const artifact = await getArtifact(db, scope, artifactId, deps.clock.now());
  const oldVersion = await getVersionByNumber(db, artifact, from);
  const newVersion = await getVersionByNumber(db, artifact, to);
  return { oldVersion, newVersion };
}

function filesOf(db: Db, versionId: string): Promise<StoredFile[]> {
  return db
    .selectFrom('version_files')
    .select(['path', 'sha256', 'size', 'content_type'])
    .where('version_id', '=', versionId)
    .execute();
}

/**
 * The file `path` (any Unicode normalization) in each of the two versions; either may lack it,
 * both lacking it is a 404. `path` in the result is the stored spelling.
 */
async function filesAt(
  deps: AppDeps,
  versions: { oldVersion: VersionRow; newVersion: VersionRow },
  path: string,
): Promise<{ oldFile: StoredFile | undefined; newFile: StoredFile | undefined; path: string }> {
  const { db } = deps.db;
  const stored = path.normalize('NFC');
  const find = (versionId: string) =>
    db
      .selectFrom('version_files')
      .select(['path', 'sha256', 'size', 'content_type'])
      .where('version_id', '=', versionId)
      .where('path', '=', stored)
      .executeTakeFirst();
  const oldFile = await find(versions.oldVersion.id);
  const newFile = await find(versions.newVersion.id);
  if (oldFile === undefined && newFile === undefined) throw notFound(t('diff.noFile'));
  return { oldFile, newFile, path: stored };
}

/**
 * A stored file's bytes, as many as its row says. A blob a version lists is never missing unless
 * storage lost it, so the store's `not_found` becomes a server error here, not a 404 that reads
 * as "no such file".
 */
async function readFile(deps: AppDeps, file: StoredFile): Promise<Buffer> {
  if (file.size === 0) return Buffer.alloc(0);
  try {
    const stream = await deps.blobs.get(file.sha256, { start: 0, end: file.size - 1 });
    return Buffer.concat(await stream.toArray());
  } catch (error) {
    if (error instanceof AppError) {
      throw new Error(`The stored file ${file.path} (${file.sha256}) cannot be read`, {
        cause: error,
      });
    }
    throw error;
  }
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** How many lines the text has: its line breaks, and one more for text after the last. */
function lineCount(bytes: Buffer): number {
  let count = 0;
  for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) count += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? count + 1 : count;
}
