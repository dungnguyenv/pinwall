import type { Located, SourceLocation } from '../content/locate.ts';
import { t } from '../lib/i18n.ts';
import type { ThreadOut } from './types.ts';

// Tool texts and the rest of the server write sizes the same way.
export { formatBytes } from '../lib/format.ts';

/** The line breaks that end a line of text; other control characters are dropped, not split on. */
const LINE_BREAK = /\r\n|[\n\r\p{Zl}\p{Zp}]/u;

/** Every control character except the tab. */
const CONTROL_EXCEPT_TAB = /[^\P{Cc}\t]/gu;

/** `text` without its control characters (terminal escapes included), except the tab. */
export const dropControls = (text: string): string => text.replace(CONTROL_EXCEPT_TAB, '');

/** The indentation of a comment's second and later lines, deeper than its first. */
const CONTINUATION = '    ';

/** `text` on one line: line breaks and control characters become one space; spaces at the ends stay. */
export const flatten = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');

/**
 * A comment's text as quoted data: control characters (terminal escapes included) are dropped,
 * and every line after the first is indented under the author, so nothing a reviewer writes can
 * start a line that looks like a thread header or another author's comment.
 */
function quoteBody(body: string): string {
  return body.split(LINE_BREAK).map(dropControls).join(`\n${CONTINUATION}`);
}

/** Where on its page a thread points, as a short phrase. */
function describeAnchor({ kind, quote, selector, position }: ThreadOut['anchor']): string {
  if (kind === 'text' && quote !== null) {
    const text = t('mcp.comment.text', {
      exact: flatten(quote.exact),
      prefix: flatten(quote.prefix),
      suffix: flatten(quote.suffix),
    });
    // The element that holds the text helps when the quote is not unique on the page.
    return selector === null
      ? text
      : t('mcp.comment.inElement', { anchor: text, selector: flatten(selector) });
  }
  if (kind === 'element' && selector !== null) {
    return t('mcp.comment.element', { selector: flatten(selector) });
  }
  return t('mcp.comment.point', {
    x: Math.round(position.x * 100),
    y: Math.round(position.y * 100),
  });
}

/** Whether a thread is open, and which version fixed it once it is resolved. */
function describeStatus({ status, resolved_in_version: fixedIn }: ThreadOut): string {
  if (status === 'open') return t('mcp.comment.statusOpen');
  return fixedIn === null
    ? t('mcp.comment.statusResolved')
    : t('mcp.comment.statusResolvedIn', { number: fixedIn.number });
}

/**
 * Where a thread sits in the source of the current version `number`: its file and lines, marked
 * unverified when the page's scripts may have moved its element, then the first lines there, each
 * numbered; or that it was not found there. The path and the lines are the publisher's: the path
 * is flattened, and the lines come cleaned and cut from `locateThreads`, so none can start a line
 * of this text that passes for another.
 */
function describeSource(located: SourceLocation | 'not_found', number: number): string[] {
  if (located === 'not_found') return [t('mcp.comment.sourceNotFound', { number })];
  const { path, start, end, snippet, unverified } = located;
  const where = {
    path: flatten(path),
    lines: start === end ? `${start}` : `${start}-${end}`,
    number,
  };
  return [
    unverified ? t('mcp.comment.sourceUnverified', where) : t('mcp.comment.source', where),
    ...snippet.map((text, i) => t('mcp.comment.sourceLine', { line: start + i, text })),
  ];
}

/**
 * A thread for the model: a first line with its id, the version it was written on, its status
 * when `showStatus` (for a list that is not only of open threads) and where it points; then, with
 * `located` and the `current` version it was located in, where it sits in that version's source
 * (nothing for a thread not located); then its first comment and each reply, one author per line.
 * What reviewers wrote (comment texts, quoted page text, selectors) is data: it is flattened or
 * indented so it cannot pass for another line of this text.
 */
export function formatThread(
  th: ThreadOut,
  o: { showStatus?: boolean; located?: Located; current?: { number: number } } = {},
): string {
  const page = th.anchor.page === '' ? t('mcp.comment.entryPage') : flatten(th.anchor.page);
  const where = t('mcp.comment.where', { page, anchor: describeAnchor(th.anchor) });
  const comments = [th, ...th.replies].map((c) =>
    t('mcp.comment.line', { author: flatten(c.author), body: quoteBody(c.body) }),
  );
  const header = o.showStatus
    ? t('mcp.comment.threadStatus', {
        id: th.id,
        number: th.version.number,
        status: describeStatus(th),
        where,
      })
    : t('mcp.comment.thread', { id: th.id, number: th.version.number, where });
  const source =
    o.located === undefined || o.located === null || o.current === undefined
      ? []
      : describeSource(o.located, o.current.number);
  return [header, ...source, ...comments].join('\n');
}

/** Appends the line that says how to get the next page, when there is one. */
export function withMore(lines: string[], tool: string, nextCursor: string | null): string {
  return (
    nextCursor === null ? lines : [...lines, t('mcp.list.more', { tool, cursor: nextCursor })]
  ).join('\n');
}
