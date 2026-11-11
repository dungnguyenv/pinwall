/**
 * The page's text as one string, with a way back and forth between offsets in that string and
 * points in the DOM. Quotes are made and searched against it, so a quote may run across any
 * number of text nodes.
 */

export interface TextIndex {
  /** The data of every indexed text node, in document order, with nothing between them. */
  text: string;
  /**
   * The offset in `text` of a DOM boundary point. A point in an indexed text node maps into it;
   * any other point (an element boundary, a comment, a script) maps to the first indexed text at
   * or after it, or to `text.length` when there is none.
   */
  toOffset(node: Node, offset: number): number;
  /** A range over `text.slice(start, end)`, offsets clamped to the text. */
  toRange(start: number, end: number): Range;
}

/** How much of a page one index may take in. */
export interface TextIndexLimits {
  /** Characters of text kept; the node that crosses the limit is cut. */
  maxChars: number;
  /** Nodes (elements and text) visited. */
  maxNodes: number;
  /** Milliseconds of walking, checked every 1024 nodes. */
  budgetMs: number;
}

export const TEXT_INDEX_LIMITS: Readonly<TextIndexLimits> = Object.freeze({
  maxChars: 1_000_000,
  maxNodes: 300_000,
  budgetMs: 250,
});

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;
const FOLLOWING = 4;
const CONTAINED_BY = 16;
/** Elements whose text is code or inert, never shown as page text. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template']);

/** The node after `node` in document order under `root`, entering its children if `descend`. */
function nextNode(node: Node, root: Node, descend: boolean): Node | null {
  if (descend && node.firstChild) return node.firstChild;
  for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
    if (current.nextSibling) return current.nextSibling;
  }
  return null;
}

/** Whether the start of `text` is at or after the boundary point (`container`, `offset`). */
function isAtOrAfter(container: Node, offset: number, text: Node): boolean {
  const type = container.nodeType;
  if (type === ELEMENT_NODE || type === DOCUMENT_NODE || type === DOCUMENT_FRAGMENT_NODE) {
    const child = container.childNodes[offset];
    if (child) return child === text || (child.compareDocumentPosition(text) & FOLLOWING) !== 0;
    const position = container.compareDocumentPosition(text);
    return (position & FOLLOWING) !== 0 && (position & CONTAINED_BY) === 0;
  }
  return (container.compareDocumentPosition(text) & FOLLOWING) !== 0;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isNaN(value) ? min : Math.min(max, Math.max(min, value));
}

/**
 * Indexes the text nodes under `doc.body` in document order, skipping the contents of `script`,
 * `style`, `noscript` and `template`, and stopping at `limits`.
 */
export function buildTextIndex(
  doc: Document,
  limits: Readonly<TextIndexLimits> = TEXT_INDEX_LIMITS,
): TextIndex {
  const nodes: Text[] = [];
  const starts: number[] = [];
  const chunks: string[] = [];
  let length = 0;
  const body = doc.body;
  if (body) {
    const deadline = Date.now() + limits.budgetMs;
    let visits = 0;
    let node: Node | null = body.firstChild;
    while (node && length < limits.maxChars && visits < limits.maxNodes) {
      visits++;
      if ((visits & 1023) === 0 && Date.now() >= deadline) break;
      let descend = false;
      if (node.nodeType === TEXT_NODE) {
        const data = (node as Text).data;
        if (data.length > 0) {
          const piece =
            data.length > limits.maxChars - length ? data.slice(0, limits.maxChars - length) : data;
          nodes.push(node as Text);
          starts.push(length);
          chunks.push(piece);
          length += piece.length;
        }
      } else if (node.nodeType === ELEMENT_NODE) {
        descend = !SKIPPED.has((node as Element).localName);
      }
      node = nextNode(node, body, descend);
    }
  }
  const text = chunks.join('');
  const slots = new Map<Node, number>();
  nodes.forEach((node, i) => {
    slots.set(node, i);
  });
  const startOf = (i: number) => starts[i] ?? text.length;

  /** The last node starting at or before `offset` (or before it, when `strict`). */
  const nodeAt = (offset: number, strict: boolean): number => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (strict ? startOf(mid) < offset : startOf(mid) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  return {
    text,
    toOffset(node, offset) {
      const slot = slots.get(node);
      if (slot !== undefined) {
        return startOf(slot) + clamp(offset, 0, startOf(slot + 1) - startOf(slot));
      }
      let lo = 0;
      let hi = nodes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (isAtOrAfter(node, offset, nodes[mid] as Text)) hi = mid;
        else lo = mid + 1;
      }
      return startOf(lo);
    },
    toRange(start, end) {
      const range = doc.createRange();
      if (nodes.length === 0) return range;
      const from = clamp(start, 0, text.length);
      const to = clamp(end, from, text.length);
      const first = nodeAt(from, false);
      const startNode = from === startOf(first + 1) && first + 1 < nodes.length ? first + 1 : first;
      const endNode = to === from ? startNode : nodeAt(to, true);
      const at = (i: number, offset: number): [Text, number] => {
        const node = nodes[i] as Text;
        return [node, clamp(offset - startOf(i), 0, node.length)];
      };
      range.setStart(...at(startNode, from));
      range.setEnd(...at(endNode, to));
      return range;
    },
  };
}
