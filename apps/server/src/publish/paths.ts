import type { ArtifactKind } from '../db/schema.ts';
import { type AppError, badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

/** Longest stored path, counted in Unicode code points after NFC normalization. */
export const MAX_PATH_LENGTH = 512;

/** First path segment Pinwall keeps for its own files in every version. */
export const RESERVED_DIR = '__pinwall';

export type PathRejection =
  | 'absolute'
  | 'dot_segment'
  | 'backslash'
  | 'control'
  | 'encoding'
  | 'empty_segment'
  | 'too_long'
  | 'duplicate'
  | 'reserved'
  | 'link'
  | 'special';

/** Messages quote at most this many code points of a path. */
const QUOTE_LENGTH = 100;

const DRIVE_LETTER = /^[A-Za-z]:/;

/** Half of a UTF-16 surrogate pair standing alone: a JSON name can carry one, a file name not. */
const LONE_SURROGATE = /\p{Cs}/u;
const LONE_SURROGATES = /\p{Cs}/gu;

/** C0 controls, DEL and C1 controls (Unicode's `Cc`): a latin1 zip name can hold any of them. */
const CONTROL = /\p{Cc}/u;

/** Checked in this order; the first one present wins. */
const ENTRY_NAMES = ['index.html', 'index.md', 'README.md'] as const;

/**
 * The first `max` code points of `path`, followed by `…` when anything was cut. Paths come from
 * untrusted archives, so a message or an error body never repeats more than this.
 */
export function quotePath(path: string, max = QUOTE_LENGTH): string {
  const cut = codePointCut(path, max);
  return cut === null ? path : `${path.slice(0, cut)}…`;
}

/** The 400 that refuses an upload because of one path. */
export function rejectPath(path: string, reason: PathRejection): AppError {
  return badRequest(t(`publish.path.${reason}`, { path: quotePath(path), max: MAX_PATH_LENGTH }), {
    reason,
    path: quotePath(path, MAX_PATH_LENGTH),
  });
}

/**
 * Turns an archive entry name into the path Pinwall stores: leading `./` removed, NFC, relative,
 * no `.`/`..`/empty segments, no backslash, control character or lone surrogate, not under
 * `__pinwall/`, at most `MAX_PATH_LENGTH` code points. Directories and macOS junk (`__MACOSX/`,
 * `._*`, `.DS_Store`) are skipped rather than refused. Throws `rejectPath` for anything else that
 * breaks a rule.
 */
export function normalizeEntryPath(raw: string): { path: string } | { skip: 'junk' | 'directory' } {
  let path = raw;
  while (path.startsWith('./')) path = path.slice(2);
  path = path.normalize('NFC');
  if (path === '' || path === '.' || path.endsWith('/')) return { skip: 'directory' };

  // No database stores a lone surrogate faithfully: two such names could become one.
  if (LONE_SURROGATE.test(path)) {
    throw rejectPath(path.replace(LONE_SURROGATES, '\uFFFD'), 'encoding');
  }
  if (CONTROL.test(path)) throw rejectPath(path, 'control');
  if (path.includes('\\')) throw rejectPath(path, 'backslash');
  if (path.startsWith('/') || DRIVE_LETTER.test(path)) throw rejectPath(path, 'absolute');

  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '') throw rejectPath(path, 'empty_segment');
    if (segment === '.' || segment === '..') throw rejectPath(path, 'dot_segment');
  }
  if (segments[0] === RESERVED_DIR) throw rejectPath(path, 'reserved');

  const basename = segments[segments.length - 1] ?? '';
  if (segments[0] === '__MACOSX' || basename.startsWith('._') || basename === '.DS_Store') {
    return { skip: 'junk' };
  }

  if (codePointCut(path, MAX_PATH_LENGTH) !== null) throw rejectPath(path, 'too_long');
  return { path };
}

/**
 * Removes one folder that wraps every path, as `tar -czf site.tgz site/` produces, so the entry
 * page sits at the root. Normalized paths in, normalized paths out. Stripping never moves a file
 * into the reserved folder: that is refused with `rejectPath(…, 'reserved')`.
 */
export function stripWrapperFolder(paths: readonly string[]): {
  prefix: string | null;
  paths: string[];
} {
  const first = paths[0];
  const slash = first?.indexOf('/') ?? -1;
  const prefix = first !== undefined && slash > 0 ? first.slice(0, slash + 1) : null;
  if (prefix === null || !paths.every((path) => path.startsWith(prefix))) {
    return { prefix: null, paths: [...paths] };
  }

  const stripped: string[] = [];
  for (const path of paths) {
    const inner = path.slice(prefix.length);
    if (inner.split('/', 1)[0] === RESERVED_DIR) throw rejectPath(path, 'reserved');
    stripped.push(inner);
  }
  return { prefix, paths: stripped };
}

/**
 * The page a version opens on: `index.html`, else `index.md`, else `README.md` at the root, else
 * the only file. Its kind is `markdown` when it ends in `.md`.
 */
export function chooseEntry(paths: readonly string[]): { entryPath: string; kind: ArtifactKind } {
  if (paths.length === 0) throw badRequest(t('publish.entry.empty'), { reason: 'empty' });
  const present = new Set(paths);
  const entryPath =
    ENTRY_NAMES.find((name) => present.has(name)) ?? (paths.length === 1 ? paths[0] : undefined);
  if (entryPath === undefined) throw badRequest(t('publish.entry.none'), { reason: 'no_entry' });
  return { entryPath, kind: entryKind(entryPath) };
}

/** The kind of a version that opens on `entryPath`: `markdown` when it ends in `.md`. */
export function entryKind(entryPath: string): ArtifactKind {
  return entryPath.toLowerCase().endsWith('.md') ? 'markdown' : 'html';
}

/**
 * Where `text` must be cut to keep its first `max` code points (an index in UTF-16 units), or
 * `null` when it has no more than `max`. Stops early, so a huge name costs no more than `max`.
 */
function codePointCut(text: string, max: number): number | null {
  let index = 0;
  for (let count = 0; index < text.length; count += 1) {
    if (count === max) return index;
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return null;
}
