import { t } from '../lib/i18n.ts';
import { dropControls } from './format.ts';

/** A line is shown cut to this many characters. */
const LINE_MAX_CHARS = 2000;

/** One call shows at most this many characters of lines. */
const WINDOW_MAX_CHARS = 60_000;

/** The line number is right-aligned in this many characters, so the text starts in one column. */
const NUMBER_WIDTH = 6;

/** The line breaks of a text file: CRLF, LF or a lone CR, as an editor counts them. */
const LINE_BREAK = /\r\n|[\n\r]/;

const BOM = '﻿';

/** U+2028 and U+2029, which `flatten` (format.ts) treats as line breaks, though an editor does not. */
const SEPARATORS = /[\p{Zl}\p{Zp}]/gu;

/** A matching line too long to show whole is shown from this many characters before its match. */
const FIND_LEAD_CHARS = 1000;

/** A UTF-16 unit that starts a surrogate pair: a cut must not leave it alone at the end. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
/** A UTF-16 unit that ends a surrogate pair: a cut must not leave it alone at the start. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * The lines of `text`, as an editor counts them: split on `\r\n`, `\n` or `\r`, with the breaks
 * dropped and a leading BOM dropped from the first line. A break at the very end ends the last
 * line rather than starting another, so `'a\nb\n'` has two lines and an empty text has none.
 */
export function splitLines(text: string): string[] {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (body === '') return [];
  const lines = body.split(LINE_BREAK);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * `line` without what could break or pass for the text around it: control characters other than
 * the tab (terminal escapes among them) are dropped, and U+2028 and U+2029, which `flatten`
 * treats as breaks, become a space.
 */
export const cleaned = (line: string): string => dropControls(line).replace(SEPARATORS, ' ');

/**
 * A line as it is shown. It is page source, so it is data: it goes through `cleaned`. A line over
 * `LINE_MAX_CHARS` characters is cut there (never inside a surrogate pair) and ends with a marker
 * that says how many were left out. When the line contains `wanted` (`find`'s needle, folded),
 * and the first match does not end within those characters (a minified page is one line), the
 * line is shown from `FIND_LEAD_CHARS` before the match instead, as `around` says.
 */
function displayLine(line: string, wanted?: string): string {
  const clean = cleaned(line);
  if (clean.length <= LINE_MAX_CHARS) return clean;
  if (wanted !== undefined) {
    const at = matchColumn(clean, wanted);
    if (at + wanted.length > LINE_MAX_CHARS) return around(clean, at);
  }
  const cut = isHighSurrogate(clean.charCodeAt(LINE_MAX_CHARS - 1))
    ? LINE_MAX_CHARS - 1
    : LINE_MAX_CHARS;
  return clean.slice(0, cut) + t('mcp.read.cut', { count: clean.length - cut });
}

/**
 * `LINE_MAX_CHARS` characters of the long line `clean` around column `at`: from
 * `FIND_LEAD_CHARS` before it, or fewer where the line ends first, so that as many are shown as
 * in a range. Each cut is marked with how many characters it leaves out, and none splits a
 * surrogate pair.
 */
function around(clean: string, at: number): string {
  let start = Math.max(0, Math.min(at - FIND_LEAD_CHARS, clean.length - LINE_MAX_CHARS));
  if (isLowSurrogate(clean.charCodeAt(start))) start += 1;
  let end = Math.min(clean.length, start + LINE_MAX_CHARS);
  if (end < clean.length && isHighSurrogate(clean.charCodeAt(end - 1))) end -= 1;
  return [
    start > 0 ? t('mcp.read.cutBefore', { count: start }) : '',
    clean.slice(start, end),
    end < clean.length ? t('mcp.read.cut', { count: clean.length - end }) : '',
  ].join('');
}

/** `text` as `find` compares it: in NFC and lower case. */
const folded = (text: string): string => text.normalize('NFC').toLowerCase();

/**
 * Where the first match of `wanted` (folded) starts in `clean`, a line as it is shown, which
 * `find` compares folded. Folding nearly always keeps a line's length, and then the match's
 * column is the same in both. When it does not (decomposed text), the column is found as the
 * length of the shortest start of the line that contains the match, less the needle's length.
 */
function matchColumn(clean: string, wanted: string): number {
  const whole = folded(clean);
  if (whole.length === clean.length) return Math.max(0, whole.indexOf(wanted));
  let lo = wanted.length;
  let hi = clean.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (folded(clean.slice(0, mid)).includes(wanted)) hi = mid;
    else lo = mid + 1;
  }
  return Math.max(0, lo - wanted.length);
}

/**
 * Line `n` (from 1) written as the tools show it: `     7| text`; around the first match of
 * `wanted` when it is a long line that `find` matched (`displayLine`).
 */
function numbered(n: number, line: string, wanted?: string): string {
  return `${n.toString().padStart(NUMBER_WIDTH)}| ${displayLine(line, wanted)}`;
}

/**
 * Up to `limit` lines from line `offset` (from 1), numbered, in one text of at most `maxChars`
 * characters: it stops early when the next line would not fit, but always shows one line. `next`
 * is the number of the first line not shown, or null when the last line is.
 */
export function windowLines(
  lines: string[],
  offset: number,
  limit: number,
  maxChars = WINDOW_MAX_CHARS,
): { body: string; next: number | null } {
  const rows: string[] = [];
  let chars = 0;
  const end = Math.min(lines.length, Math.max(offset, 1) - 1 + limit);
  let at = Math.max(offset, 1) - 1;
  for (; at < end; at++) {
    const row = numbered(at + 1, lines[at] ?? '');
    // The rows are joined by one line break each.
    const cost = rows.length === 0 ? row.length : row.length + 1;
    if (rows.length > 0 && chars + cost > maxChars) break;
    rows.push(row);
    chars += cost;
  }
  return { body: rows.join('\n'), next: at < lines.length ? at + 1 : null };
}

/** Whether `line`, as it is shown, contains `needle` (already in NFC and lower case). */
function contains(line: string, needle: string): boolean {
  return folded(cleaned(line)).includes(needle);
}

/**
 * The lines that contain `needle`, each with `context` lines around it, as `windowLines` writes
 * them. The comparison ignores case and the Unicode form (both sides in NFC), so text typed
 * composed finds text stored decomposed. Windows that overlap or touch are one group; groups are
 * separated by a line `--`. The lines are shown as `windowLines` shows them, except that a
 * matching line too long to show whole is shown around its first match (`displayLine`).
 *
 * `matches` is how many matching lines are shown, and `truncated` is true when more were left
 * out: after `maxMatches` matches, or once the text would pass `maxChars` characters.
 */
export function findLines(
  lines: string[],
  needle: string,
  context = 3,
  maxMatches = 30,
  maxChars = WINDOW_MAX_CHARS,
): { body: string; matches: number; truncated: boolean } {
  // The needle is compared with lines as they are shown, where a separator is a space.
  const wanted = folded(needle.replace(SEPARATORS, ' '));
  const hits: number[] = [];
  let more = false;
  for (let i = 0; i < lines.length; i++) {
    if (!contains(lines[i] ?? '', wanted)) continue;
    if (hits.length === maxMatches) {
      more = true;
      break;
    }
    hits.push(i);
  }

  const groups: [from: number, to: number][] = [];
  for (const hit of hits) {
    const from = Math.max(0, hit - context);
    const to = Math.min(lines.length - 1, hit + context);
    const last = groups.at(-1);
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else groups.push([from, to]);
  }

  /** `line` is the index of the line a row shows, or -1 for a separator. */
  const entries: { text: string; line: number }[] = [];
  const matched = new Set(hits);
  for (const [g, [from, to]] of groups.entries()) {
    if (g > 0) entries.push({ text: '--', line: -1 });
    for (let i = from; i <= to; i++) {
      const text = numbered(i + 1, lines[i] ?? '', matched.has(i) ? wanted : undefined);
      entries.push({ text, line: i });
    }
  }

  let kept = 0;
  let chars = 0;
  for (const { text } of entries) {
    const cost = kept === 0 ? text.length : text.length + 1;
    if (kept > 0 && chars + cost > maxChars) break;
    chars += cost;
    kept += 1;
  }
  const shown = entries.slice(0, kept);
  // A group is never left with its separator and nothing after it.
  while (shown.at(-1)?.line === -1) shown.pop();

  const shownLines = new Set(shown.map((entry) => entry.line));
  return {
    body: shown.map((entry) => entry.text).join('\n'),
    matches: hits.filter((hit) => shownLines.has(hit)).length,
    truncated: more || kept < entries.length,
  };
}
