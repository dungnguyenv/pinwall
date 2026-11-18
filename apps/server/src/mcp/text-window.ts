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

/** A UTF-16 unit that starts a surrogate pair: a cut must not leave it alone at the end. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

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
 * that says how many were left out.
 */
function displayLine(line: string): string {
  const clean = cleaned(line);
  if (clean.length <= LINE_MAX_CHARS) return clean;
  const cut = isHighSurrogate(clean.charCodeAt(LINE_MAX_CHARS - 1))
    ? LINE_MAX_CHARS - 1
    : LINE_MAX_CHARS;
  return clean.slice(0, cut) + t('mcp.read.cut', { count: clean.length - cut });
}

/** Line `n` (from 1) written as the tools show it: `     7| text`. */
function numbered(n: number, line: string): string {
  return `${n.toString().padStart(NUMBER_WIDTH)}| ${displayLine(line)}`;
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
  return cleaned(line).normalize('NFC').toLowerCase().includes(needle);
}

/**
 * The lines that contain `needle`, each with `context` lines around it, as `windowLines` writes
 * them. The comparison ignores case and the Unicode form (both sides in NFC), so text typed
 * composed finds text stored decomposed. Windows that overlap or touch are one group; groups are
 * separated by a line `--`. The lines are shown as `windowLines` shows them.
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
  const wanted = needle.replace(SEPARATORS, ' ').normalize('NFC').toLowerCase();
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
  for (const [g, [from, to]] of groups.entries()) {
    if (g > 0) entries.push({ text: '--', line: -1 });
    for (let i = from; i <= to; i++) {
      entries.push({ text: numbered(i + 1, lines[i] ?? ''), line: i });
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
