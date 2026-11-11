/**
 * CSS selector paths from `<body>` to an element, in the spirit of the W3C Web Annotation
 * CssSelector: `#id` where an id is unique and looks hand-written, else tag names with
 * `:nth-of-type()` where siblings share a name, joined by ` > `.
 */
import { DOM_PATH_MAX_CHARS } from '@pinwall/shared/protocol';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SEPARATOR = ' > ';

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * `ident` serialized as a CSS identifier, following the CSSOM "serialize an identifier"
 * algorithm (what `CSS.escape` does, which some environments and pages lack or replace).
 */
export function cssEscape(ident: string): string {
  let out = '';
  for (let i = 0; i < ident.length; i++) {
    const code = ident.charCodeAt(i);
    if (code === 0) out += '\uFFFD';
    else if (
      (code >= 0x01 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && isDigit(code)) ||
      (i === 1 && isDigit(code) && ident.charCodeAt(0) === 0x2d)
    ) {
      out += `\\${code.toString(16)} `;
    } else if (i === 0 && code === 0x2d && ident.length === 1) out += '\\-';
    else if (code >= 0x80 || code === 0x2d || code === 0x5f || isDigit(code) || isAsciiLetter(code))
      out += ident[i];
    else out += `\\${ident[i]}`;
  }
  return out;
}

/** An identifier as `cssEscape` writes it. */
const IDENT = String.raw`(?:[-\w\u0080-\uFFFF]|\\[0-9a-fA-F]{1,6} |\\[^0-9a-fA-F\n\r\f])+`;
/** Exactly the shape `cssPath` writes: `body` or `#id`, then tag names with an optional index. */
const PATH = new RegExp(
  String.raw`^(?:body|#${IDENT})(?: > ${IDENT}(?::nth-of-type\([1-9][0-9]{0,6}\))?)*$`,
);

/**
 * Whether `selector` has the shape of a path `cssPath` writes. Stored paths come from other
 * reviewers, so anything else (`:has()`, `*`, lists) is never handed to `querySelector`.
 */
export function isCssPath(selector: string): boolean {
  return selector.length <= DOM_PATH_MAX_CHARS && PATH.test(selector);
}

/** Ids that frameworks or build tools generate, which change from one build to the next. */
const GENERATED_ID =
  /\d{4,}|[:«»]|^(?:ember|ext-gen|yui_|gwt-uid|mui-|radix-|headlessui-|react-aria|rc-|downshift-)/i;
/** A hex run long enough to be a hash or a UUID part. */
const HEX_RUN = /[0-9a-f]{8,}/gi;

function looksGenerated(id: string): boolean {
  if (GENERATED_ID.test(id)) return true;
  for (const [run] of id.matchAll(HEX_RUN)) {
    if (/\d/.test(run) && /[a-f]/i.test(run)) return true;
  }
  return false;
}

/** `#id` for an element whose id is unique in its document and looks hand-written, else null. */
function idSelector(doc: Document, el: Element): string | null {
  const id = el.getAttribute('id');
  if (!id || looksGenerated(id)) return null;
  const selector = `#${cssEscape(id)}`;
  try {
    return doc.querySelectorAll(selector).length === 1 ? selector : null;
  } catch {
    return null;
  }
}

/** The tag name of `el`, with `:nth-of-type(k)` when its parent has other children of that name. */
function typeSelector(el: Element, parent: Element): string {
  let count = 0;
  let position = 0;
  for (let sibling = parent.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
    if (sibling.localName === el.localName && sibling.namespaceURI === el.namespaceURI) {
      count++;
      if (sibling === el) position = count;
      if (position > 0 && count > 1) break;
    }
  }
  const name = cssEscape(el.localName);
  return count > 1 ? `${name}:nth-of-type(${position})` : name;
}

/**
 * The element a path names for `el`: the outermost `<svg>` that holds it, else `el` itself.
 * Shapes inside an SVG change too freely to be worth their own path.
 */
export function pathTarget(el: Element): Element {
  let target = el;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.localName === 'svg' && node.namespaceURI === SVG_NS) target = node;
  }
  return target;
}

/**
 * A selector that finds `el` (or the `<svg>` holding it) again: it starts at the nearest unique,
 * hand-written id or at `body`. Null for `html`, `body` and anything outside body (head, shadow
 * roots, detached nodes), and for paths longer than `DOM_PATH_MAX_CHARS`.
 */
export function cssPath(el: Element): string | null {
  const doc = el.ownerDocument;
  const body = doc.body;
  const start = pathTarget(el);
  if (body?.localName !== 'body' || start === body || !body.contains(start)) return null;
  const parts: string[] = [];
  let length = 0;
  for (let node = start; ; ) {
    const id = idSelector(doc, node);
    const parent = node.parentElement;
    if (!parent) return null;
    const part = id ?? typeSelector(node, parent);
    parts.push(part);
    length += (parts.length > 1 ? SEPARATOR.length : 0) + part.length;
    // Deep pages: stop as soon as the path is sure to be too long.
    if (length > DOM_PATH_MAX_CHARS) return null;
    if (id !== null) break;
    if (parent === body) {
      parts.push('body');
      break;
    }
    node = parent;
  }
  const path = parts.reverse().join(SEPARATOR);
  if (path.length > DOM_PATH_MAX_CHARS) return null;
  try {
    return doc.querySelector(path) === start ? path : null;
  } catch {
    return null;
  }
}
