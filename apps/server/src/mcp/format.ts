import { t } from '../lib/i18n.ts';
import type { ThreadOut } from './schemas.ts';

// Tool texts and the rest of the server write sizes the same way.
export { formatBytes } from '../lib/format.ts';

/** `text` on one line: every run of whitespace, line breaks included, becomes one space. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The line breaks that end a line of text; other control characters are dropped, not split on. */
const LINE_BREAK = /\r\n|[\n\r\p{Zl}\p{Zp}]/u;

/** Every control character except the tab. */
const CONTROL_EXCEPT_TAB = /[^\P{Cc}\t]/gu;

/** The indentation of a comment's second and later lines, deeper than its first. */
const CONTINUATION = '    ';

/** `text` on one line: line breaks and control characters become one space; spaces at the ends stay. */
const flatten = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');

/**
 * A comment's text as quoted data: control characters (terminal escapes included) are dropped,
 * and every line after the first is indented under the author, so nothing a reviewer writes can
 * start a line that looks like a thread header or another author's comment.
 */
function quoteBody(body: string): string {
  return body
    .split(LINE_BREAK)
    .map((line) => line.replace(CONTROL_EXCEPT_TAB, ''))
    .join(`\n${CONTINUATION}`);
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

/**
 * A thread for the model: a first line with its id, the version it was written on and where it
 * points, then its first comment and each reply, one author per line. What reviewers wrote
 * (comment texts, quoted page text, selectors) is data: it is flattened or indented so it cannot
 * pass for another line of this text.
 */
export function formatThread(th: ThreadOut): string {
  const page = th.anchor.page === '' ? t('mcp.comment.entryPage') : flatten(th.anchor.page);
  const where = t('mcp.comment.where', { page, anchor: describeAnchor(th.anchor) });
  const comments = [th, ...th.replies].map((c) =>
    t('mcp.comment.line', { author: oneLine(c.author), body: quoteBody(c.body) }),
  );
  return [
    t('mcp.comment.thread', { id: th.id, number: th.version.number, where }),
    ...comments,
  ].join('\n');
}

/** Appends the line that says how to get the next page, when there is one. */
export function withMore(lines: string[], tool: string, nextCursor: string | null): string {
  return (
    nextCursor === null ? lines : [...lines, t('mcp.list.more', { tool, cursor: nextCursor })]
  ).join('\n');
}
