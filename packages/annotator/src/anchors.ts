/**
 * Turning what a reviewer picked (a text selection, an element, a point) into an `Anchor`. Every
 * anchor keeps a position as a fallback; text and element anchors also keep selectors that find
 * the spot again when the page changes (see `reattach.ts`).
 */
import { type Anchor, QUOTE_CONTEXT_CHARS, QUOTE_MAX_CHARS } from '@pinwall/shared/protocol';
import { cssPath, pathTarget } from './css-path.ts';
import { clientToDoc, type DocPoint, originOf, toFraction } from './geometry.ts';
import { buildTextIndex } from './text-index.ts';

export interface AnchorContext {
  doc: Document;
  /** The page the anchors belong to (see `pageOf`). */
  page: string;
}

/** The widest viewport the `Anchor` schema accepts. */
const MAX_VIEWPORT_WIDTH = 100_000;
const SPACE = /\s/;
/** A unit that belongs to the character before it: a combining mark or Hangul jamo. */
const CONTINUATION = /[\p{M}\u1160-\u11FF]/u;

function isLowSurrogate(unit: string | undefined): boolean {
  return unit !== undefined && unit >= '\uDC00' && unit <= '\uDFFF';
}

function isHighSurrogate(unit: string | undefined): boolean {
  return unit !== undefined && unit >= '\uD800' && unit <= '\uDBFF';
}

function viewportOf(doc: Document): { width: number } {
  const width = Math.round(doc.documentElement?.clientWidth ?? 0);
  return { width: Number.isFinite(width) ? Math.min(MAX_VIEWPORT_WIDTH, Math.max(0, width)) : 0 };
}

function positionOf(doc: Document, point: DocPoint | null): { x: number; y: number } {
  return point ? toFraction(doc, point) : { x: 0, y: 0 };
}

/**
 * A text anchor for the text `range` covers, without the whitespace at either end and cut to
 * `QUOTE_MAX_CHARS`, with `QUOTE_CONTEXT_CHARS` of text on each side. Null when no text is left,
 * or when the range is not in the document's own tree (a shadow root, a detached node).
 */
export function textAnchor(ctx: AnchorContext, range: Range): Anchor | null {
  const { doc } = ctx;
  if (!doc.contains(range.startContainer) || !doc.contains(range.endContainer)) return null;
  const index = buildTextIndex(doc);
  const { text } = index;
  let start = index.toOffset(range.startContainer, range.startOffset);
  let end = index.toOffset(range.endContainer, range.endOffset);
  while (start < end && SPACE.test(text[start] as string)) start++;
  if (end > start + QUOTE_MAX_CHARS) {
    end = start + QUOTE_MAX_CHARS;
    // Never leave a letter without its marks, or half a surrogate pair, in the quote.
    while (end > start && (isLowSurrogate(text[end]) || CONTINUATION.test(text[end] as string)))
      end--;
  }
  while (end > start && SPACE.test(text[end - 1] as string)) end--;
  if (start >= end) return null;

  let prefix = text.slice(Math.max(0, start - QUOTE_CONTEXT_CHARS), start);
  if (isLowSurrogate(prefix[0])) prefix = prefix.slice(1);
  let suffix = text.slice(end, end + QUOTE_CONTEXT_CHARS);
  if (isHighSurrogate(suffix[suffix.length - 1])) suffix = suffix.slice(0, -1);

  const ancestor = range.commonAncestorContainer;
  const holder = ancestor.nodeType === 1 ? (ancestor as Element) : ancestor.parentElement;
  const path = holder ? cssPath(holder) : null;
  return {
    page: ctx.page,
    kind: 'text',
    quote: { exact: text.slice(start, end), prefix, suffix },
    ...(path === null ? {} : { dom: { path } }),
    position: positionOf(doc, originOf(range)),
    viewport: viewportOf(doc),
  };
}

/**
 * An element anchor for `el` (for an element inside an SVG, the outermost `<svg>`). Null when the
 * element has no CSS path (html, body, anything outside body).
 */
export function elementAnchor(ctx: AnchorContext, el: Element): Anchor | null {
  const path = cssPath(el);
  if (path === null) return null;
  return {
    page: ctx.page,
    kind: 'element',
    dom: { path },
    position: positionOf(ctx.doc, originOf(pathTarget(el))),
    viewport: viewportOf(ctx.doc),
  };
}

/** A point anchor at client (viewport) coordinates `clientX`, `clientY`. */
export function pointAnchor(ctx: AnchorContext, clientX: number, clientY: number): Anchor {
  return {
    page: ctx.page,
    kind: 'point',
    position: toFraction(ctx.doc, clientToDoc(ctx.doc, clientX, clientY)),
    viewport: viewportOf(ctx.doc),
  };
}
