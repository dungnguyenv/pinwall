import type { Config } from '../config/types.ts';
import { contentTypeFor, isTextType } from '../content/mime.ts';
import { AppError, badRequest, payloadTooLarge } from '../lib/errors.ts';
import { formatBytes } from '../lib/format.ts';
import { t } from '../lib/i18n.ts';
import { splitLines } from '../mcp/text-window.ts';
import { limitExceeded } from './limits.ts';
import { MAX_PATH_LENGTH, normalizeEntryPath, quotePath } from './paths.ts';

/** One operation of `edit_artifact`, on a path normalized as a publish normalizes it. */
export type EditOp =
  | { op: 'replace'; path: string; old_string: string; new_string: string; replace_all?: boolean }
  | { op: 'write'; path: string; content: string }
  | { op: 'delete'; path: string };

/**
 * What the operations did to one path: `count` replacements, which sit on `lines` (first and
 * last, from 1, in the new text) when the result is `replaced`; null lines otherwise.
 */
export interface FileEdit {
  path: string;
  result: 'replaced' | 'written' | 'deleted';
  count: number;
  lines: [number, number] | null;
}

/** An operation as `edit_artifact` takes it: one flat object, whatever its `op`. */
export interface EditInput {
  op: EditOp['op'];
  path: string;
  old_string?: string | undefined;
  new_string?: string | undefined;
  replace_all?: boolean | undefined;
  content?: string | undefined;
}

/** The limits `applyEdits` holds the new texts to, counted in UTF-16 units. */
export type EditLimits = Pick<Config['limits'], 'maxFileBytes' | 'maxVersionBytes'>;

const NO_LIMITS: EditLimits = {
  maxFileBytes: Number.POSITIVE_INFINITY,
  maxVersionBytes: Number.POSITIVE_INFINITY,
};

/** An edit reads at most this many bytes of stored files in all: the files it replaces in. */
export const EDIT_READ_MAX_BYTES = 20_000_000;

/** An error lists at most this many line numbers. */
const LINES_SHOWN = 10;

const LF = 0x0a;
const CR = 0x0d;

/**
 * The operations `edit_artifact` was given, checked before anything is read: the strings of all
 * of them (paths, old and new strings, contents) are at most `maxInlineBytes` of UTF-8 in all,
 * else `payload_too_large`; each path follows the rules of a publish (`normalizeEntryPath`, whose
 * refusal gains the operation's `index`), and comes back normalized; each operation has its
 * fields (`replace`: a non-empty `old_string` and a `new_string`; `write`: `content`); and a
 * `write` makes a text file. The last three refuse with `edit_failed` (problems
 * `missing_fields`, with `fields`; `bad_path`, for a folder or a file a publish skips; and
 * `not_text`).
 */
export function parseEdits(input: readonly EditInput[], maxInlineBytes: number): EditOp[] {
  let bytes = 0;
  for (const edit of input) {
    for (const text of [edit.path, edit.old_string, edit.new_string, edit.content]) {
      if (text !== undefined) bytes += Buffer.byteLength(text, 'utf8');
    }
  }
  if (bytes > maxInlineBytes) {
    throw payloadTooLarge(t('mcp.edit.tooLarge', { max: maxInlineBytes }), {
      limit: 'max_inline_bytes',
      max: maxInlineBytes,
    });
  }
  return input.map((edit, index) => parseEdit(edit, index));
}

/**
 * Refuses an edit that would read more than `max` bytes of stored files, by the `sizes` their
 * rows give, before any of them is read: 413 `payload_too_large` with `reason: 'edit_too_large'`.
 * An edit that large is made on disk instead.
 */
export function assertReadBudget(sizes: readonly number[], max = EDIT_READ_MAX_BYTES): void {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= max) return;
  throw payloadTooLarge(
    t('mcp.edit.readTooLarge', { size: formatBytes(total), max: formatBytes(max) }),
    { reason: 'edit_too_large', read_bytes: total, max },
  );
}

function parseEdit(edit: EditInput, index: number): EditOp {
  const path = normalizedPath(edit, index);
  const missing: string[] = [];
  if (edit.op === 'replace') {
    if (edit.old_string === undefined || edit.old_string === '') missing.push('old_string');
    if (edit.new_string === undefined) missing.push('new_string');
  } else if (edit.op === 'write' && edit.content === undefined) {
    missing.push('content');
  }
  if (missing.length > 0) {
    throw editFailed(index, edit.op, path, 'missing_fields', {
      message: t('mcp.edit.problem.missing_fields', { op: edit.op, fields: missing.join(' and ') }),
      details: { fields: missing },
    });
  }
  switch (edit.op) {
    case 'replace':
      return {
        op: 'replace',
        path,
        old_string: edit.old_string ?? '',
        new_string: edit.new_string ?? '',
        ...(edit.replace_all === true ? { replace_all: true } : {}),
      };
    case 'write':
      if (!isTextType(contentTypeFor(path))) throw editFailed(index, 'write', path, 'not_text');
      return { op: 'write', path, content: edit.content ?? '' };
    case 'delete':
      return { op: 'delete', path };
  }
}

/** `edit.path` as a publish stores it; a path a publish refuses or skips is refused here. */
function normalizedPath(edit: EditInput, index: number): string {
  let normalized: ReturnType<typeof normalizeEntryPath>;
  try {
    normalized = normalizeEntryPath(edit.path);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    throw new AppError(error.code, error.status, error.message, { ...error.details, index });
  }
  if ('skip' in normalized) throw editFailed(index, edit.op, edit.path, 'bad_path');
  return normalized.path;
}

/** A path's text while the operations apply, and what they did to it. */
interface Touched {
  /** Null: there is no file. */
  text: string | null;
  /** A `write` set its text, so the agent wrote all of it. */
  written: boolean;
  /** Replacements since the file was last written or deleted. */
  count: number;
  /** Where those replacements sit in `text`: from the first one's start to the last one's end. */
  span: [start: number, end: number] | null;
}

/**
 * Applies `ops` in order, each to the text the earlier ones left, starting from `read(path)`
 * (the current text, null when there is no file; asked once per path, and never for one a
 * `write` touches first). Returns the new text of every touched path (null: deleted), in the
 * order first touched, and one `FileEdit` per path.
 *
 * A `replace` finds `old_string` in the decoded text: once, or at least once with `replace_all`.
 * Only the matched ranges change, so line endings and a BOM stay byte for byte; in a CRLF file
 * a `\n` in `old_string` matches `\r\n`, and one in `new_string` is written `\r\n`
 * (`formsOf`). Its `lines` are
 * where its replacements, and those of the earlier ones on the same text, sit in the new text,
 * numbered as `splitLines` numbers them.
 *
 * A failure throws `edit_failed` (400) with the operation's `index`, its `path` and a `problem`:
 * `no_file` (a replace or delete with no file there), `entry_delete` (the entry page,
 * `entryPath`, cannot be deleted), `not_found` (with `whitespace_lines` and `unicode_lines`: the
 * lines where the text matches once runs of whitespace are collapsed, or once both sides are in
 * NFC, 10 at most each) or `ambiguous` (several matches without `replace_all`: their `count`,
 * and the first 10 of their `lines`). A text longer than `limits.maxFileBytes` UTF-16 units, or
 * texts longer than `limits.maxVersionBytes` in all, are refused with `max_file_bytes` or
 * `max_version_bytes` (413) before they are built: their UTF-8 could only be longer.
 */
export function applyEdits(
  ops: readonly EditOp[],
  read: (path: string) => string | null,
  entryPath: string,
  limits: EditLimits = NO_LIMITS,
): { texts: Map<string, string | null>; summary: FileEdit[] } {
  const touched = new Map<string, Touched>();
  /** UTF-16 units of every touched text. */
  let total = 0;

  const resize = (path: string, from: string | null, to: number): void => {
    if (to > limits.maxFileBytes) throw limitExceeded('max_file_bytes', limits.maxFileBytes, path);
    const next = total - (from?.length ?? 0) + to;
    if (next > limits.maxVersionBytes) {
      throw limitExceeded('max_version_bytes', limits.maxVersionBytes);
    }
    total = next;
  };
  const stateOf = (path: string): Touched => {
    let state = touched.get(path);
    if (state === undefined) {
      const text = read(path);
      state = { text, written: false, count: 0, span: null };
      touched.set(path, state);
      total += text?.length ?? 0;
    }
    return state;
  };

  for (const [index, op] of ops.entries()) {
    if (op.op === 'write') {
      const state = touched.get(op.path);
      resize(op.path, state?.text ?? null, op.content.length);
      touched.set(op.path, { text: op.content, written: true, count: 0, span: null });
      continue;
    }
    if (op.op === 'delete' && op.path === entryPath) {
      throw editFailed(index, op.op, op.path, 'entry_delete');
    }
    const state = stateOf(op.path);
    if (state.text === null) throw editFailed(index, op.op, op.path, 'no_file');
    if (op.op === 'delete') {
      resize(op.path, state.text, 0);
      Object.assign(state, { text: null, written: false, count: 0, span: null });
      continue;
    }
    const done = replaceIn(state.text, op, index, state.span);
    resize(op.path, state.text, done.length);
    state.text = done.build();
    state.count += done.count;
    state.span = done.span;
  }

  const texts = new Map<string, string | null>();
  const summary: FileEdit[] = [];
  for (const [path, state] of touched) {
    texts.set(path, state.text);
    summary.push(fileEdit(path, state));
  }
  return { texts, summary };
}

/** The `FileEdit` of a path's final state. */
function fileEdit(path: string, { text, written, count, span }: Touched): FileEdit {
  if (text === null) return { path, result: 'deleted', count: 0, lines: null };
  if (written || span === null) return { path, result: 'written', count, lines: null };
  const [start, end] = span;
  const cursor = new LineCursor(text);
  const first = cursor.lineAt(start);
  // The line of the last character replaced in, or of the start when nothing was.
  const last = end > start ? cursor.lineAt(end - 1) : first;
  // An edit that removed the end of the text can leave the span past its last line.
  const max = Math.max(1, splitLines(text).length);
  return { path, result: 'replaced', count, lines: [Math.min(first, max), Math.min(last, max)] };
}

/** The strings one `replace` tries: `old_string` to find, `new_string` to put in its place. */
interface ReplaceForm {
  needle: string;
  replacement: string;
}

/**
 * The forms of `op` to try on `text`, in order. `read_file` shows lines without their `\r`, so
 * an agent writes `\n` where a CRLF file has `\r\n`. In a text that has a `\r\n`:
 * - `new_string` is written with every `\n` made `\r\n`, unless it has a `\r` of its own,
 *   whichever form of `old_string` matches;
 * - when `old_string` has a `\n` but no `\r`, its form with every `\n` made `\r\n` is tried
 *   first, then `old_string` as written. In a file with both kinds of line break, the CRLF form
 *   wins wherever it matches at all; the one as written is tried only when it matches nowhere.
 *
 * A text without `\r\n` takes both strings as written.
 */
function formsOf(text: string, op: Extract<EditOp, { op: 'replace' }>): ReplaceForm[] {
  const { old_string: needle, new_string: written } = op;
  if (!text.includes('\r\n')) return [{ needle, replacement: written }];
  const crlf = (s: string) => s.replaceAll('\n', '\r\n');
  const replacement = written.includes('\r') ? written : crlf(written);
  const given = { needle, replacement };
  if (!needle.includes('\n') || needle.includes('\r')) return [given];
  return [{ needle: crlf(needle), replacement }, given];
}

/**
 * One `replace` on `text`, checked: its matches in the first of `formsOf` that has any (one, or
 * any number with `replace_all`), how long the text becomes, a function that builds it, and
 * `span` (the replacements so far, in the old text) moved to the new text and widened to cover
 * these ones too.
 */
function replaceIn(
  text: string,
  op: Extract<EditOp, { op: 'replace' }>,
  index: number,
  span: [number, number] | null,
): { count: number; length: number; span: [number, number]; build: () => string } {
  const forms = formsOf(text, op);
  let chosen: { form: ReplaceForm; found: Found } | null = null;
  for (const form of forms) {
    const found = findAll(text, form, span);
    if (found.count > 0) {
      chosen = { form, found };
      break;
    }
  }

  if (chosen === null) {
    // Collapsing whitespace makes every line break alike, so one form is enough there.
    const whitespace = whitespaceLines(text, op.old_string);
    const unicode =
      forms.map((form) => unicodeLines(text, form.needle)).find((lines) => lines.length > 0) ?? [];
    const message = [
      t('mcp.edit.problem.not_found'),
      ...(whitespace.length > 0
        ? [t('mcp.edit.problem.whitespace', { lines: whitespace.join(', ') })]
        : []),
      ...(unicode.length > 0 ? [t('mcp.edit.problem.unicode', { lines: unicode.join(', ') })] : []),
    ].join(' ');
    throw editFailed(index, op.op, op.path, 'not_found', {
      message,
      details: { whitespace_lines: whitespace, unicode_lines: unicode },
    });
  }
  const { needle, replacement } = chosen.form;
  const { count, first, last, lines, moved } = chosen.found;
  if (count > 1 && op.replace_all !== true) {
    throw editFailed(index, op.op, op.path, 'ambiguous', {
      message: t('mcp.edit.problem.ambiguous', { count, lines: lines.join(', ') }),
      details: { count, lines },
    });
  }

  const delta = replacement.length - needle.length;
  const ours: [number, number] = [first, last + (count - 1) * delta + replacement.length];
  return {
    count,
    length: text.length + count * delta,
    span: moved === null ? ours : [Math.min(moved[0], ours[0]), Math.max(moved[1], ours[1])],
    // Split and join, not `String.replace`: `$&` and the like in new_string stay as written.
    build: () =>
      count === 1
        ? text.slice(0, first) + replacement + text.slice(first + needle.length)
        : text.split(needle).join(replacement),
  };
}

/** The matches of one form in a text. */
interface Found {
  count: number;
  /** Where the first and the last match start, in the text before the replacement. */
  first: number;
  last: number;
  /** The first 10 distinct lines with a match. */
  lines: number[];
  /** The span of earlier replacements, moved to where it would be after this one. */
  moved: [number, number] | null;
}

/** Every match of `form.needle` in `text`, left to right and not overlapping, in one pass. */
function findAll(text: string, form: ReplaceForm, span: [number, number] | null): Found {
  const width = form.needle.length;
  const delta = form.replacement.length - width;
  const [start, end] = span ?? [0, 0];
  let count = 0;
  let first = -1;
  let last = -1;
  const lines: number[] = [];
  const cursor = new LineCursor(text);
  // Where `start` and `end` go: moved by the matches before them, or onto the start or the end
  // of a match they fall inside of.
  let movedStart = 0;
  let movedEnd = 0;
  let snapStart: number | null = null;
  let snapEnd: number | null = null;
  for (let at = text.indexOf(form.needle); at !== -1; at = text.indexOf(form.needle, at + width)) {
    const newAt = at + count * delta;
    if (at + width <= start) movedStart += delta;
    else if (at < start) snapStart = newAt;
    if (at + width <= end) movedEnd += delta;
    else if (at < end) snapEnd = newAt + form.replacement.length;
    if (first === -1) first = at;
    last = at;
    if (lines.length < LINES_SHOWN) addLine(lines, cursor.lineAt(at));
    count += 1;
  }
  const moved: [number, number] | null =
    span === null ? null : [snapStart ?? start + movedStart, snapEnd ?? end + movedEnd];
  return { count, first, last, lines, moved };
}

/**
 * The lines (at most 10) where `needle` occurs in `text` once every run of whitespace on both
 * sides is one space, line breaks included, and the needle's ends are trimmed.
 */
function whitespaceLines(text: string, needle: string): number[] {
  const wanted = needle.replace(/\s+/g, ' ').trim();
  if (wanted === '') return [];
  // The text collapsed, in stretches without whitespace joined by one space each; the i-th
  // stretch starts at `starts[i]` in it and at `origins[i]` in `text`.
  const parts: string[] = [];
  const starts: number[] = [];
  const origins: number[] = [];
  let length = 0;
  let from = 0;
  for (const run of text.matchAll(/\s+/g)) {
    const part = text.slice(from, run.index);
    starts.push(length);
    origins.push(from);
    parts.push(part, ' ');
    length += part.length + 1;
    from = run.index + run[0].length;
  }
  starts.push(length);
  origins.push(from);
  parts.push(text.slice(from));
  const collapsed = parts.join('');

  const lines: number[] = [];
  const cursor = new LineCursor(text);
  let stretch = 0;
  for (
    let at = collapsed.indexOf(wanted);
    at !== -1 && lines.length < LINES_SHOWN;
    at = collapsed.indexOf(wanted, at + 1)
  ) {
    // `wanted` starts with a character that is not a space, so `at` is inside a stretch.
    while ((starts[stretch + 1] ?? Number.POSITIVE_INFINITY) <= at) stretch += 1;
    addLine(lines, cursor.lineAt((origins[stretch] ?? 0) + at - (starts[stretch] ?? 0)));
  }
  return lines;
}

/**
 * The lines (at most 10) where `needle` occurs in `text` once both are in NFC. NFC never joins
 * anything across a line break, so a line of the normalized text is the same line of `text`.
 */
function unicodeLines(text: string, needle: string): number[] {
  const wanted = needle.normalize('NFC');
  const normalized = text.normalize('NFC');
  // The exact search found nothing; with nothing changed, neither would this one.
  if (wanted === needle && normalized === text) return [];
  const lines: number[] = [];
  const cursor = new LineCursor(normalized);
  for (
    let at = normalized.indexOf(wanted);
    at !== -1 && lines.length < LINES_SHOWN;
    at = normalized.indexOf(wanted, at + 1)
  ) {
    addLine(lines, cursor.lineAt(at));
  }
  return lines;
}

/** Adds `line` to `lines`, which grow in order, unless it is already the last one. */
function addLine(lines: number[], line: number): void {
  if (lines.at(-1) !== line) lines.push(line);
}

/**
 * The line numbers of positions in one text, asked in increasing order, in one pass over it: a
 * line ends at `\n`, at `\r\n` and at a `\r` alone, as `splitLines` splits, and the first is 1.
 */
class LineCursor {
  private at = 0;
  private line = 1;

  constructor(private readonly text: string) {}

  /** The line of the character at `offset`, which is not before the last one asked. */
  lineAt(offset: number): number {
    for (; this.at < offset; this.at += 1) {
      const unit = this.text.charCodeAt(this.at);
      if (unit === LF || (unit === CR && this.text.charCodeAt(this.at + 1) !== LF)) this.line += 1;
    }
    return this.line;
  }
}

/**
 * The 400 for operation `index` (`op` on `path`): `edit_failed` with `problem`, its message (the
 * problem's own `mcp.edit.problem.*` text unless `extra.message` says more) and `extra.details`.
 */
function editFailed(
  index: number,
  op: EditOp['op'],
  path: string,
  problem: string,
  extra: { message?: string; details?: Record<string, unknown> } = {},
): AppError {
  return badRequest(
    t('mcp.edit.failed', {
      index,
      op,
      path: quotePath(path),
      problem: extra.message ?? t(`mcp.edit.problem.${problem}`),
    }),
    {
      reason: 'edit_failed',
      index,
      path: quotePath(path, MAX_PATH_LENGTH),
      problem,
      ...extra.details,
    },
  );
}
