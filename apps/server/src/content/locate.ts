import { findQuote } from '@pinwall/annotator/match';
import type { CommentThread } from '@pinwall/shared';
import type { VersionFileRow, VersionRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { filesAt, pageCandidates, pageFilePath, readText } from '../domain/version-files.ts';
import { AppError } from '../lib/errors.ts';
import { cleaned, splitLines } from '../mcp/text-window.ts';
import { elementAt, type HtmlElement, type HtmlPage, parseHtmlPage } from './html-tree.ts';
import { MARKDOWN_RENDER_MAX_BYTES, renderMarkdownPage } from './markdown.ts';
import { MARKDOWN_BUDGET_BYTES } from './metadata.ts';
import { isHtmlType, isMarkdownType } from './mime.ts';

/**
 * Where a comment thread sits in the source of a version: the file of its page, and the lines its
 * quote or its element spans there. The page is parsed as the browser builds it from the source
 * (`html-tree.ts`), a Markdown page as the page it is served as, and the anchor is placed on it
 * as the annotator places it on the page.
 */

/** A page file larger than this is not located. */
export const LOCATE_MAX_BYTES = 2_000_000;
/**
 * Bytes of page files one call reads in all (five files at `LOCATE_MAX_BYTES`, about half a second
 * of parsing); a file past it is not located. Markdown files also count toward
 * `MARKDOWN_BUDGET_BYTES`, as rendering hostile Markdown is slow.
 */
const LOCATE_BUDGET_BYTES = 5 * LOCATE_MAX_BYTES;

/** At most this many source lines are quoted, from the first line of a location. */
const SNIPPET_LINES = 3;
/** A quoted source line is cut to this many characters, marks included. */
const SNIPPET_LINE_CHARS = 160;
/** Marks where a quoted line was cut. */
const CUT = '…';

export interface SourceLocation {
  /** The version's file. */
  path: string;
  /** The first and last line (from 1, as `splitLines` counts them). */
  start: number;
  end: number;
  /** Up to `SNIPPET_LINES` lines from `start`, as data: see `snippetOf`. */
  snippet: string[];
  /** An element anchor on a page whose scripts may have moved what its path names. */
  unverified: boolean;
}

/** null: not attempted (a point anchor, a file too large or not text, not a page). */
export type Located = SourceLocation | 'not_found' | null;

type Anchor = CommentThread['anchor'];

/** Lines of a location, and the column (in the source line) where it starts. */
interface Span {
  start: number;
  end: number;
  column: number;
  unverified: boolean;
}

/** Whether an anchor has what it takes to be located: a quote, or a DOM path. */
function locatable(anchor: Anchor): boolean {
  if (anchor.kind === 'text') return anchor.quote !== undefined;
  return anchor.kind === 'element' && anchor.dom !== undefined;
}

/** Turns source offsets into lines and columns, counted as `splitLines` counts lines. */
class LineIndex {
  /** The offset where each line starts. */
  private readonly starts: number[] = [0];

  constructor(source: string) {
    for (let i = 0; i < source.length; i++) {
      const unit = source.charCodeAt(i);
      if (unit === 0x0d && source.charCodeAt(i + 1) === 0x0a) continue;
      if (unit === 0x0a || unit === 0x0d) this.starts.push(i + 1);
    }
  }

  /** The line (from 1) that holds the offset `at`. */
  lineOf(at: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((this.starts[mid] ?? 0) <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** The column of the offset `at` in its line. */
  columnOf(at: number): number {
    return at - (this.starts[this.lineOf(at) - 1] ?? 0);
  }
}

/** A parsed HTML page and its lines. */
interface HtmlSource {
  page: HtmlPage;
  lines: LineIndex;
}

function prepareHtml(html: string): HtmlSource | null {
  const page = parseHtmlPage(html);
  return page === null ? null : { page, lines: new LineIndex(html) };
}

/** Where `anchor` sits on a page: the units of its quote in the page's text, or its element. */
function placeOn(
  page: HtmlPage,
  anchor: Anchor,
): { start: number; last: number } | HtmlElement | null {
  if (anchor.kind === 'text' && anchor.quote !== undefined) {
    const hit = findQuote(page.text, anchor.quote);
    return hit === null ? null : { start: hit.start, last: Math.max(hit.start, hit.end - 1) };
  }
  return anchor.dom === undefined ? null : elementAt(page, anchor.dom.path);
}

function spanInHtml({ page, lines }: HtmlSource, anchor: Anchor): Span | 'not_found' {
  const placed = placeOn(page, anchor);
  if (placed === null) return 'not_found';
  // Only an element is placed by its path, which the page's scripts can lead elsewhere.
  const [from, to, unverified] =
    'last' in placed
      ? [page.origins[placed.start] ?? 0, page.origins[placed.last] ?? 0, false]
      : [placed.start, placed.end - 1, page.runsScripts];
  return {
    start: lines.lineOf(from),
    end: lines.lineOf(to),
    column: lines.columnOf(from),
    unverified,
  };
}

/**
 * The lines of `html` (a page's source) that `anchor` points at. A text anchor's quote is found
 * in the page's text as `findQuote` finds it in the browser; an element anchor's path is walked
 * as `elementAt` says, and its lines run from its start tag to its end. An element location is
 * `unverified` on a page that runs scripts. `'not_found'` when the quote is not there or the path
 * cannot be walked; null for a point anchor, or a page too deeply nested to parse.
 */
export function locateInHtml(
  html: string,
  anchor: Anchor,
): { start: number; end: number; unverified: boolean } | 'not_found' | null {
  if (!locatable(anchor)) return null;
  const source = prepareHtml(html);
  if (source === null) return null;
  const span = spanInHtml(source, anchor);
  return span === 'not_found'
    ? span
    : { start: span.start, end: span.end, unverified: span.unverified };
}

const BOM = '\uFEFF';
const LINES_ATTRIBUTE = /^([1-9][0-9]*)-([1-9][0-9]*)$/;

/** The source lines of the nearest of `el` and its ancestors that names them. */
function blockLines(el: HtmlElement): { start: number; end: number } | null {
  for (let node: HtmlElement | null = el; node !== null; node = node.parent) {
    const match = node.lines === null ? null : LINES_ATTRIBUTE.exec(node.lines);
    if (match !== null) return { start: Number(match[1]), end: Number(match[2]) };
  }
  return null;
}

/**
 * The page a Markdown source is served as (`renderMarkdownPage`), with source lines on its
 * blocks; null for a source served unrendered, over `MARKDOWN_RENDER_MAX_BYTES`. A leading BOM
 * is dropped, as the server drops it when it serves the page; it changes no line number.
 */
function prepareMarkdown(src: string, pagePath: string): HtmlPage | null {
  const body = src.startsWith(BOM) ? src.slice(1) : src;
  if (Buffer.byteLength(body) > MARKDOWN_RENDER_MAX_BYTES) return null;
  return parseHtmlPage(renderMarkdownPage(body, pagePath, { sourceLines: true }));
}

function spanInMarkdown(page: HtmlPage, anchor: Anchor): Span | 'not_found' {
  const placed = placeOn(page, anchor);
  if (placed === null) return 'not_found';
  const [first, last] =
    'last' in placed
      ? [blockLines(page.holderAt(placed.start)), blockLines(page.holderAt(placed.last))]
      : [blockLines(placed), blockLines(placed)];
  // The table of contents, and raw HTML blocks, have no source lines of their own.
  if (first === null || last === null) return 'not_found';
  return { start: first.start, end: Math.max(first.start, last.end), column: 0, unverified: false };
}

/**
 * The lines of the Markdown `src` that `anchor` points at, located on the page the source is
 * served as at `pagePath`: the lines of the nearest block (a paragraph, a list item, a table row)
 * that holds the quote's ends or the element. `'not_found'` when the quote or the path is not on
 * the page, or is outside the document's blocks (the table of contents, raw HTML); null for a
 * point anchor or a source served unrendered.
 */
export function locateInMarkdown(
  src: string,
  pagePath: string,
  anchor: Anchor,
): { start: number; end: number } | 'not_found' | null {
  if (!locatable(anchor)) return null;
  const page = prepareMarkdown(src, pagePath);
  if (page === null) return null;
  const span = spanInMarkdown(page, anchor);
  return span === 'not_found' ? span : { start: span.start, end: span.end };
}

/** A UTF-16 unit that ends a surrogate pair: a cut must not start on it. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;
/** A UTF-16 unit that starts a surrogate pair: a cut must not end on it. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
/** `text` cut to `SNIPPET_LINE_CHARS` characters, `CUT` included, never inside a surrogate pair. */
function cut(text: string): string {
  if (text.length <= SNIPPET_LINE_CHARS) return text;
  let end = SNIPPET_LINE_CHARS - CUT.length;
  if (isHighSurrogate(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end) + CUT;
}

/**
 * Up to `SNIPPET_LINES` lines of a location, from its first line to its last, each cut to
 * `SNIPPET_LINE_CHARS` characters. They are page source, so they are data: they are `cleaned` as
 * `read_file` shows lines (control characters other than the tab dropped, U+2028 and U+2029 as a
 * space). A first line too long to show whole is shown from `column`, where the location starts
 * (a minified page is one line).
 */
function snippetOf(lines: readonly string[], span: Span): string[] {
  const last = Math.min(span.end, span.start + SNIPPET_LINES - 1, lines.length);
  const snippet: string[] = [];
  for (let n = span.start; n <= last; n++) {
    const line = lines[n - 1] ?? '';
    if (n !== span.start || span.column === 0 || cleaned(line).length <= SNIPPET_LINE_CHARS) {
      snippet.push(cut(cleaned(line)));
      continue;
    }
    const column = isLowSurrogate(line.charCodeAt(span.column)) ? span.column - 1 : span.column;
    snippet.push(cut(CUT + cleaned(line.slice(column))));
  }
  return snippet;
}

/** What one call may still read, in bytes. */
interface Budget {
  pages: number;
  markdown: number;
}

/**
 * The text of a page file, or null when it is not located: not HTML or Markdown, too large (a
 * Markdown file over `MARKDOWN_RENDER_MAX_BYTES` is served unrendered), past `budget`, or not
 * text (binary, or not UTF-8).
 */
async function pageText(
  deps: AppDeps,
  file: VersionFileRow,
  budget: Budget,
): Promise<string | null> {
  const markdown = isMarkdownType(file.content_type);
  if (!markdown && !isHtmlType(file.content_type)) return null;
  if (file.size > (markdown ? MARKDOWN_RENDER_MAX_BYTES : LOCATE_MAX_BYTES)) return null;
  if (file.size > budget.pages || (markdown && file.size > budget.markdown)) return null;
  budget.pages -= file.size;
  if (markdown) budget.markdown -= file.size;
  try {
    return await readText(deps, file);
  } catch (error) {
    if (error instanceof AppError && error.details?.reason === 'not_text') return null;
    throw error;
  }
}

/**
 * Where each of `threads` sits in `version`, by thread id. A thread's page is the file
 * `pageFilePath` resolves it to (`'not_found'` when the version has none), and is located there
 * as `locateInHtml` or `locateInMarkdown` says, with a snippet of its first lines. Each file is
 * read and parsed at most once, and only while it is being located, so one call holds one parsed
 * page at a time. Point anchors and the files `pageText` refuses are not located (null).
 */
export async function locateThreads(
  deps: AppDeps,
  version: VersionRow,
  threads: readonly CommentThread[],
): Promise<Map<string, Located>> {
  const located = new Map<string, Located>();
  const wanted = threads.filter((th) => locatable(th.anchor));
  const pages = new Set(wanted.map((th) => th.anchor.page));
  const candidates = new Set([...pages].flatMap((p) => pageCandidates(p, version.entry_path)));
  const files = await filesAt(deps, version, [...candidates]);
  const paths = new Set(files.keys());

  /** The threads on each file, in the order of their first thread. */
  const byFile = new Map<string, CommentThread[]>();
  for (const th of threads) {
    if (!locatable(th.anchor)) {
      located.set(th.id, null);
      continue;
    }
    const path = pageFilePath(th.anchor.page, version.entry_path, paths);
    const onFile = path === null ? undefined : byFile.get(path);
    if (path === null) located.set(th.id, 'not_found');
    else if (onFile === undefined) byFile.set(path, [th]);
    else onFile.push(th);
  }

  const budget: Budget = { pages: LOCATE_BUDGET_BYTES, markdown: MARKDOWN_BUDGET_BYTES };
  for (const [path, onFile] of byFile) {
    const file = files.get(path);
    const locate = file === undefined ? null : await openPage(deps, file, budget);
    for (const th of onFile) located.set(th.id, locate === null ? null : locate(th.anchor));
  }
  return located;
}

/**
 * Reads and parses one page file, for locating anchors on it; null when it is not located
 * (`pageText`) or cannot be parsed (`parseHtmlPage`).
 */
async function openPage(
  deps: AppDeps,
  file: VersionFileRow,
  budget: Budget,
): Promise<((anchor: Anchor) => Located) | null> {
  const text = await pageText(deps, file, budget);
  if (text === null) return null;
  let find: ((anchor: Anchor) => Span | 'not_found') | null = null;
  if (isMarkdownType(file.content_type)) {
    const page = prepareMarkdown(text, file.path);
    if (page !== null) find = (anchor) => spanInMarkdown(page, anchor);
  } else {
    const source = prepareHtml(text);
    if (source !== null) find = (anchor) => spanInHtml(source, anchor);
  }
  if (find === null) return null;
  const lines = splitLines(text);
  return (anchor) => {
    const span = find(anchor);
    if (span === 'not_found') return span;
    const { start, end, unverified } = span;
    return { path: file.path, start, end, snippet: snippetOf(lines, span), unverified };
  };
}
