/**
 * Points in document pixels, and the fractions of the document's scroll size anchors store, so a
 * spot keeps its place when the page is wider, narrower or longer than when it was made.
 */

/** A point in document pixels: client coordinates plus the window's scroll offset. */
export interface DocPoint {
  x: number;
  y: number;
}

/** `value` when it is a finite number, else 0. */
export function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A fraction clamped to 0..1 and rounded to 4 decimals; 0 for anything not a number. */
export function fraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
}

/** The scroll size of the document element, each side at least 1 pixel. */
export function docSize(doc: Document): { width: number; height: number } {
  const root = doc.documentElement;
  return {
    width: Math.max(1, finite(root?.scrollWidth)),
    height: Math.max(1, finite(root?.scrollHeight)),
  };
}

/** `p` as fractions of the document's size. */
export function toFraction(doc: Document, p: DocPoint): { x: number; y: number } {
  const size = docSize(doc);
  return { x: fraction(p.x / size.width), y: fraction(p.y / size.height) };
}

/** The document point at fractions `f` of the document's size. */
export function fromFraction(doc: Document, f: { x: number; y: number }): DocPoint {
  const size = docSize(doc);
  return { x: f.x * size.width, y: f.y * size.height };
}

/** The window scroll offset of `doc`, zero when it has no window. */
function scrollOf(doc: Document | null): DocPoint {
  const win = doc?.defaultView;
  return { x: finite(win?.scrollX), y: finite(win?.scrollY) };
}

/** The document point under client (viewport) coordinates `clientX`, `clientY`. */
export function clientToDoc(doc: Document, clientX: number, clientY: number): DocPoint {
  const scroll = scrollOf(doc);
  return { x: clientX + scroll.x, y: clientY + scroll.y };
}

/**
 * The top-left corner of the first client rect of `target`, in document pixels. Null when there
 * are no layout APIs (as in jsdom), no rect (a hidden element) or the page broke them.
 */
export function originOf(target: Range | Element): DocPoint | null {
  try {
    if (typeof target.getClientRects !== 'function') return null;
    const rect = target.getClientRects()[0];
    if (!rect) return null;
    const node = 'startContainer' in target ? target.startContainer : target;
    const doc = node.nodeType === 9 ? (node as Document) : node.ownerDocument;
    const scroll = scrollOf(doc);
    const x = rect.left + scroll.x;
    const y = rect.top + scroll.y;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  } catch {
    return null;
  }
}

/**
 * The size of `doc`'s viewport in CSS pixels, without scrollbars where the browser reports it
 * (`clientWidth`/`clientHeight` of the root), else the window's inner size; zeros without a window.
 */
export function viewportSize(doc: Document): { width: number; height: number } {
  const root = doc.documentElement;
  const win = doc.defaultView;
  return {
    width: finite(root?.clientWidth) || finite(win?.innerWidth),
    height: finite(root?.clientHeight) || finite(win?.innerHeight),
  };
}
