/**
 * Finding an anchor again, possibly on a later version of the page: by its quote (its context
 * weighed with whitespace and Unicode normalized), then by its DOM path, else at its stored
 * position.
 */
import type { Anchor, Quote } from '@pinwall/shared/protocol';
import { isCssPath } from './css-path.ts';
import { eachMatch, matches, normalize, querySelector } from './pristine.ts';
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

/** Occurrences of a quote weighed by their context, at most. */
const MAX_OCCURRENCES = 1000;
/** How much of an element's text is read to check that it still holds a quote. */
const ELEMENT_TEXT_LIMITS: Readonly<TextIndexLimits> = Object.freeze({
  maxChars: 100_000,
  maxNodes: 30_000,
  budgetMs: 25,
});

/** How many characters before `end` in `text` equal the last characters of `prefix`. */
function sharedBefore(text: string, end: number, prefix: string): number {
  let n = 0;
  while (n < prefix.length && n < end && text[end - 1 - n] === prefix[prefix.length - 1 - n]) n++;
  return n;
}

/** How many characters from `start` in `text` equal the first characters of `suffix`. */
function sharedAfter(text: string, start: number, suffix: string): number {
  let n = 0;
  while (n < suffix.length && start + n < text.length && text[start + n] === suffix[n]) n++;
  return n;
}

/** Where a quote occurs in a text, and whether its context there matched in full. */
interface Occurrence {
  at: number;
  perfect: boolean;
}

/**
 * The occurrence of `exact` in `text` whose surroundings best match `prefix` and `suffix`; the
 * first one on a tie. With `gaps` (folded text, whose quote and context were trimmed), one space
 * between the occurrence and each side of its context is skipped. Null when there is none.
 */
function bestOccurrence(
  text: string,
  exact: string,
  prefix: string,
  suffix: string,
  gaps = false,
): Occurrence | null {
  const perfect = prefix.length + suffix.length;
  let best: number | null = null;
  let bestScore = -1;
  let seen = 0;
  for (
    let at = text.indexOf(exact);
    at !== -1 && seen < MAX_OCCURRENCES;
    at = text.indexOf(exact, at + 1)
  ) {
    seen++;
    let before = at;
    let after = at + exact.length;
    if (gaps && text[before - 1] === ' ') before--;
    if (gaps && text[after] === ' ') after++;
    const score = sharedBefore(text, before, prefix) + sharedAfter(text, after, suffix);
    if (score > bestScore) {
      best = at;
      bestScore = score;
      if (score === perfect) break;
    }
  }
  return best === null ? null : { at: best, perfect: bestScore === perfect };
}

/**
 * Text with every whitespace run made one space and every letter with its marks in NFC, plus,
 * for each of its UTF-16 units, the offset in the source where its piece of source starts.
 * `origins` has one more entry, the source length.
 */
interface Folded {
  text: string;
  origins: Int32Array;
}

/** A letter (or a stray mark) with the combining marks and Hangul vowel/final jamo after it. */
const CLUSTER = /[^\p{M}\u1160-\u11FF][\p{M}\u1160-\u11FF]*|[\p{M}\u1160-\u11FF]+/gu;

function fold(source: string): Folded {
  let origins = new Int32Array(source.length + 1);
  let size = 0;
  const parts: string[] = [];
  const emit = (piece: string, origin: number, sameOrigin: boolean) => {
    if (size + piece.length + 1 > origins.length) {
      const grown = new Int32Array(Math.max(origins.length * 2, size + piece.length + 1));
      grown.set(origins);
      origins = grown;
    }
    for (let k = 0; k < piece.length; k++) origins[size++] = sameOrigin ? origin : origin + k;
    parts.push(piece);
  };
  eachMatch(/\s+|\S+/g, source, (match) => {
    const word = match[0];
    const at = match.index;
    if (matches(/^\s/, word)) emit(' ', at, true);
    else if (normalize(word, 'NFC') === word) emit(word, at, false);
    else {
      eachMatch(CLUSTER, word, (cluster) => {
        emit(normalize(cluster[0], 'NFC'), at + cluster.index, true);
      });
    }
  });
  origins[size] = source.length;
  return { text: parts.join(''), origins: origins.subarray(0, size + 1) };
}

/** The fold of the last page text searched: anchors are placed many at a time on one text. */
let lastFold: { source: string; folded: Folded } | null = null;

function foldPage(text: string): Folded {
  if (lastFold?.source !== text) lastFold = { source: text, folded: fold(text) };
  return lastFold.folded;
}

/**
 * Where `q` sits in `text`. An exact occurrence of `q.exact` whose context matches `q.prefix` and
 * `q.suffix` in full is taken at once. Otherwise every occurrence is weighed with whitespace runs
 * collapsed and letters in NFC on both sides, quote and context alike, so a repeated phrase whose
 * context a formatter reflowed (or gave a no-break space, or another Unicode form) still goes to
 * the right occurrence; the match is mapped back to offsets in `text`. Null when there is none.
 */
export function findQuote(text: string, q: Quote): { start: number; end: number } | null {
  if (q.exact === '') return null;
  const exact = bestOccurrence(text, q.exact, q.prefix, q.suffix);
  const raw = exact === null ? null : { start: exact.at, end: exact.at + q.exact.length };
  if (exact?.perfect) return raw;

  const needle = fold(q.exact).text.trim();
  if (needle === '') return raw;
  const page = foldPage(text);
  const prefix = fold(q.prefix).text.trimEnd();
  const suffix = fold(q.suffix).text.trimStart();
  const hit = bestOccurrence(page.text, needle, prefix, suffix, true);
  if (hit === null) return raw;
  const { at } = hit;
  const { origins } = page;
  const last = origins[at + needle.length - 1];
  let next = at + needle.length;
  while (next < origins.length - 1 && origins[next] === last) next++;
  return { start: origins[at] as number, end: origins[next] as number };
}

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
