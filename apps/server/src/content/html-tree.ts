import { isCssPath } from '@pinwall/annotator/match';
import { Parser } from 'htmlparser2';
import { HTML_MAX_ATTRIBUTES, HTML_MAX_DEPTH } from './metadata.ts';

/**
 * A page's HTML parsed into the elements and text a browser would build from it, each with where
 * it comes from in the source, so a comment's selector path or quote, which the annotator made on
 * the page in the browser, can be traced back to source lines (`locate.ts`).
 */

/** An element of a parsed page. The document itself is one too, named `#document`. */
export interface HtmlElement {
  /** Lower case, as the browser's `localName` of an HTML element. */
  name: string;
  /** The first `id` attribute, if any. */
  id: string | null;
  /** Its `data-pw-lines` attribute (the source lines of a rendered Markdown block), if any. */
  lines: string | null;
  parent: HtmlElement | null;
  children: HtmlElement[];
  /** The offset of the `<` of its start tag. */
  start: number;
  /** The offset just past it: past its end tag, or past the last of its content the source has. */
  end: number;
}

export interface HtmlPage {
  /** Where a path from `body` starts: the `<body>`, else the `<html>`, else the document. */
  body: HtmlElement;
  /** The first element with each id, in document order. */
  ids: Map<string, HtmlElement>;
  /**
   * The text of the body as the page shows it: the text of every element in it, in order, with
   * entities decoded, every run of HTML whitespace as one space, and nothing from `script`,
   * `style`, `template`, `noscript`, `textarea` or `title`.
   */
  text: string;
  /** For each UTF-16 unit of `text`, the offset in the source it comes from. */
  origins: Int32Array;
  /** The element whose own text holds the unit of `text` at `offset`. */
  holderAt(offset: number): HtmlElement;
  /**
   * Whether the page has a `<script>` that runs: one whose `type` is not `application/json`,
   * `application/ld+json` or `importmap`, outside `template` and `noscript`.
   */
  runsScripts: boolean;
}

/**
 * Elements whose content is not in the page: a template's is a separate fragment, and a
 * noscript's is text while scripts run. They have no children here, and their text is not shown.
 */
const INERT = new Set(['template', 'noscript']);
/** Elements whose text is never page text. htmlparser2 reads each of them as one run of text. */
const SILENT = new Set(['script', 'style', 'textarea', 'title']);
/** `<script>` types that hold data and run nothing. */
const DATA_SCRIPTS = new Set(['application/json', 'application/ld+json', 'importmap']);
/** What HTML counts as whitespace, and the browser collapses in text. */
const WHITESPACE_RUN = /[\t\n\f\r ]+|[^\t\n\f\r ]+/g;
const BLANK = /^[\t\n\f\r ]/;
/** The HTML whitespace that ends a run of text. */
const TRAILING_BLANK = /[\t\n\f\r ]*$/;

/**
 * A piece of text, the offset in the source where it starts, and the element holding it.
 * htmlparser2 gives text as runs of source and each entity on its own, decoded: a unit of `data`
 * is `start` plus its index on from the start, which, inside an entity, is still on its line.
 */
interface TextPiece {
  data: string;
  start: number;
  holder: HtmlElement;
}

/**
 * Parses `source` with htmlparser2 into elements with their source offsets, the page text with
 * its origins, and whether scripts run. Where the browser's parser differs in ways that move
 * elements, it is followed: elements after `</body>` go into the body, and a page without
 * `<body>` keeps its body content in `<html>` or the document. Null when the page nests more
 * than `HTML_MAX_DEPTH` elements deep or a tag has more than `HTML_MAX_ATTRIBUTES` attributes:
 * htmlparser2 takes quadratic time on deep nesting, so such a page is not parsed to its end.
 */
export function parseHtmlPage(source: string): HtmlPage | null {
  const document = element('#document', {}, null, 0, source.length);
  /** The open elements; null for one inside an inert element's content. */
  const stack: (HtmlElement | null)[] = [];
  let inert = 0;
  let body: HtmlElement | null = null;
  let html: HtmlElement | null = null;
  let bodyClosed = false;
  const ids = new Map<string, HtmlElement>();
  const pieces: TextPiece[] = [];
  let runsScripts = false;
  /** The end of the last element or text with something in it, for an end the source omits. */
  let lastEnd = 0;
  let attributes = 0;
  let stopped = false;

  /** Where new content goes: the open element, or the body for what follows its end. */
  const holder = (): HtmlElement => {
    const top = stack.at(-1) ?? document;
    return bodyClosed && body !== null && (top === html || top === document) ? body : top;
  };

  const parser = new Parser(
    {
      onopentagname() {
        attributes = 0;
      },
      onattribute() {
        if (++attributes > HTML_MAX_ATTRIBUTES) stop();
      },
      onopentag(name, attribs) {
        if (stack.length >= HTML_MAX_DEPTH) {
          stop();
          return;
        }
        if (inert > 0) {
          stack.push(null);
          if (INERT.has(name)) inert++;
          return;
        }
        const parent = holder();
        const el = element(name, attribs, parent, parser.startIndex, parser.endIndex + 1);
        parent.children.push(el);
        stack.push(el);
        lastEnd = el.end;
        if (el.id !== null && el.id !== '' && !ids.has(el.id)) ids.set(el.id, el);
        if (name === 'body') body ??= el;
        if (name === 'html') html ??= el;
        if (INERT.has(name)) inert++;
        if (name === 'script' && !DATA_SCRIPTS.has((attribs.type ?? '').trim().toLowerCase())) {
          runsScripts = true;
        }
      },
      onclosetag(name, isImplied) {
        const el = stack.pop();
        if (el === undefined) return;
        if (el === null) {
          if (INERT.has(name)) inert--;
          return;
        }
        if (INERT.has(el.name)) inert--;
        el.end = isImplied ? Math.max(el.end, lastEnd) : parser.endIndex + 1;
        lastEnd = el.end;
        if (el === body) bodyClosed = true;
      },
      ontext(data) {
        if (inert > 0) return;
        const at = holder();
        if (SILENT.has(at.name)) return;
        const start = parser.startIndex;
        pieces.push({ data, start, holder: at });
        const kept = data.replace(TRAILING_BLANK, '').length;
        if (kept > 0) lastEnd = start + kept;
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true },
  );
  const stop = () => {
    stopped = true;
    parser.pause();
  };

  parser.write(source);
  if (stopped) return null;
  parser.end();
  if (stopped) return null;

  const root = body ?? html ?? document;
  const shown = shownIn(root);
  const text = collapse(pieces.filter((piece) => shown(piece.holder)));
  return {
    body: root,
    // The browser looks an id up in the whole document, but places a path only inside the body.
    ids: new Map([...ids].filter(([, el]) => shown(el))),
    text: text.text,
    origins: text.origins,
    holderAt: text.holderAt,
    runsScripts,
  };
}

function element(
  name: string,
  attribs: Record<string, string>,
  parent: HtmlElement | null,
  start: number,
  end: number,
): HtmlElement {
  return {
    name,
    id: attribs.id ?? null,
    lines: attribs['data-pw-lines'] ?? null,
    parent,
    children: [],
    start,
    end,
  };
}

/**
 * Whether an element is `root` or inside it, and not inside a `<head>` (which a page without
 * `<body>` keeps in the `<html>` or the document that is its root).
 */
function shownIn(root: HtmlElement): (el: HtmlElement) => boolean {
  const known = new Map<HtmlElement, boolean>([[root, true]]);
  const shown = (el: HtmlElement): boolean => {
    const cached = known.get(el);
    if (cached !== undefined) return cached;
    const answer = el.name !== 'head' && el.parent !== null && shown(el.parent);
    known.set(el, answer);
    return answer;
  };
  return shown;
}

/** The text of `pieces` with whitespace runs collapsed, where each unit comes from, and its holder. */
function collapse(pieces: readonly TextPiece[]): {
  text: string;
  origins: Int32Array;
  holderAt(offset: number): HtmlElement;
} {
  const parts: string[] = [];
  const origins = new Int32Array(pieces.reduce((sum, piece) => sum + piece.data.length, 0));
  /** Where each piece's text starts in the result, and its holder. */
  const runs: { at: number; holder: HtmlElement }[] = [];
  let size = 0;
  let afterSpace = false;
  for (const { data, start, holder } of pieces) {
    const at = size;
    for (const match of data.matchAll(WHITESPACE_RUN)) {
      const origin = start + match.index;
      if (BLANK.test(match[0])) {
        if (afterSpace) continue;
        parts.push(' ');
        origins[size++] = origin;
        afterSpace = true;
      } else {
        parts.push(match[0]);
        for (let k = 0; k < match[0].length; k++) origins[size++] = origin + k;
        afterSpace = false;
      }
    }
    if (size > at) runs.push({ at, holder });
  }
  return {
    text: parts.join(''),
    origins: origins.subarray(0, size),
    holderAt(offset) {
      let lo = 0;
      let hi = runs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if ((runs[mid]?.at ?? 0) <= offset) lo = mid;
        else hi = mid - 1;
      }
      // There is a run for every unit of the text an offset can name.
      return (runs[lo] as { holder: HtmlElement }).holder;
    },
  };
}

/** A CSS escape as `cssEscape` (packages/annotator/src/css-path.ts) writes one. */
const ESCAPE = /\\(?:([0-9a-fA-F]{1,6}) |([^0-9a-fA-F\n\r\f]))/g;
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT = String.fromCodePoint(0xfffd);

/** `ident` with its escapes read, as CSS reads them. */
function unescapeIdent(ident: string): string {
  return ident.replace(ESCAPE, (_, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? '';
    const code = Number.parseInt(hex, 16);
    const surrogate = code >= 0xd800 && code <= 0xdfff;
    return code === 0 || surrogate || code > MAX_CODE_POINT
      ? REPLACEMENT
      : String.fromCodePoint(code);
  });
}

/** `:nth-of-type(k)` at the end of a step; an identifier escapes the `:` and `(` it holds. */
const NTH_OF_TYPE = /:nth-of-type\(([1-9][0-9]{0,6})\)$/;

/**
 * The element a selector path names, walked as the browser would place it, or null when the path
 * is not one the annotator writes (`isCssPath`) or cannot be walked: a missing id, a step without
 * an index whose name is not unique among the children, or an index past the last of them.
 *
 * The path starts at `page.body` or at the first element with its id, and goes down one child per
 * step, by tag name, `:nth-of-type(k)` counting children of that name. A `tbody` step under a
 * `table` with no `tbody` child stays on the table, whose rows the browser puts in a `tbody` of
 * its own. Like the annotator, it never names the body itself.
 */
export function elementAt(page: HtmlPage, path: string): HtmlElement | null {
  if (!isCssPath(path)) return null;
  // Every space and `>` inside an identifier is escaped, so ` > ` only separates steps.
  const [first = '', ...steps] = path.split(' > ');
  let node = first === 'body' ? page.body : page.ids.get(unescapeIdent(first.slice(1)));
  if (node === undefined) return null;
  for (const step of steps) {
    const nth = NTH_OF_TYPE.exec(step);
    const name = unescapeIdent(nth === null ? step : step.slice(0, nth.index)).toLowerCase();
    const index = nth === null ? null : Number(nth[1]);
    const current: HtmlElement = node;
    if (name === 'tbody' && current.name === 'table') {
      const hasBody = current.children.some((child) => child.name === 'tbody');
      if (!hasBody) {
        if (index !== null && index !== 1) return null;
        continue;
      }
    }
    const named = current.children.filter((child) => child.name === name);
    const next = index === null ? (named.length === 1 ? named[0] : undefined) : named[index - 1];
    if (next === undefined) return null;
    node = next;
  }
  return node === page.body ? null : node;
}
