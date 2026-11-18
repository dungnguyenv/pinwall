/**
 * Finding an anchor again, possibly on a later version of the page: by its quote (its context
 * weighed with whitespace and Unicode normalized), then by its DOM path, else at its stored
 * position.
 */
import type { Anchor, Quote } from '@pinwall/shared/protocol';
import { isCssPath } from './css-path.ts';
import { querySelector } from './pristine.ts';
import { findQuote, fold } from './quote.ts';
import { buildTextIndex, type TextIndex, type TextIndexLimits } from './text-index.ts';

/**
 * Where an anchor landed. Text and element anchors that fell back to their position are not
 * found; a point anchor's position is the anchor itself, so it is always found. A text anchor
 * placed at its DOM path is found only while that element still holds its quote.
 */
export type Placement =
  | { found: true; via: 'quote'; range: Range }
  | { found: boolean; via: 'dom'; element: Element }
  | { found: boolean; via: 'position' };

/** How much of an element's text is read to check that it still holds a quote. */
const ELEMENT_TEXT_LIMITS: Readonly<TextIndexLimits> = Object.freeze({
  maxChars: 100_000,
  maxNodes: 30_000,
  budgetMs: 25,
});

/** The element `path` names inside body, or null for a path of another shape or no match. */
function elementAt(doc: Document, path: string): Element | null {
  if (!isCssPath(path)) return null;
  try {
    const element = querySelector(doc, path);
    const body = doc.body;
    return element && body && element !== body && body.contains(element) ? element : null;
  } catch {
    return null;
  }
}

/**
 * Whether `element`'s text, read as the page index reads text, still holds `q.exact`, as it is or
 * with whitespace and Unicode normalized. When `index` read the whole body, the quote search just
 * failed on text that includes the element's, so the answer is no without reading it again.
 */
function holdsQuote(doc: Document, element: Element, q: Quote, index: TextIndex): boolean {
  if (index.complete) return false;
  try {
    const { text } = buildTextIndex(doc, ELEMENT_TEXT_LIMITS, element);
    if (text.includes(q.exact)) return true;
    const needle = fold(q.exact).text.trim();
    return needle !== '' && fold(text).text.includes(needle);
  } catch {
    return false;
  }
}

/**
 * Places `a` on `doc`: a text anchor by its quote, then (text and element anchors) by its DOM
 * path, else by its position. An element anchor is found at its path; a text anchor's path names
 * the element that held its text, and it is found there only while that element still holds the
 * quote (else its text changed: the pin sits at the element, not found). Never throws, whatever
 * the stored anchor or the page holds.
 */
export function placeAnchor(doc: Document, index: TextIndex, a: Anchor): Placement {
  if (a.kind === 'text' && a.quote) {
    try {
      const hit = findQuote(index.text, a.quote);
      if (hit) return { found: true, via: 'quote', range: index.toRange(hit.start, hit.end) };
    } catch {
      // A page that broke the DOM APIs: try the next selector.
    }
  }
  if (a.kind !== 'point' && a.dom) {
    const element = elementAt(doc, a.dom.path);
    if (element) {
      const found =
        a.kind === 'element' || (a.quote !== undefined && holdsQuote(doc, element, a.quote, index));
      return { found, via: 'dom', element };
    }
  }
  return { found: a.kind === 'point', via: 'position' };
}
