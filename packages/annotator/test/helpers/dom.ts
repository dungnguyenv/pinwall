import type { Anchor } from '@pinwall/shared/protocol';

/** The `text` sample anchor of the protocol tests (Task 1). */
export const sampleAnchor: Anchor = {
  page: 'docs/',
  kind: 'text',
  quote: { exact: 'Bảng giá', prefix: 'Xem ', suffix: ' mới' },
  dom: { path: '#pricing > h2' },
  position: { x: 0.1, y: 0.2 },
  viewport: { width: 1280 },
};

/** The sample text anchor with the fields of `over` replaced. */
export function anchorOf(over: Partial<Anchor>): Anchor {
  return { ...sampleAnchor, ...over };
}

/** The `index`-th element matching `selector` under `root`; throws when there is none. */
export function el(selector: string, index = 0, root: ParentNode = document): Element {
  const found = root.querySelectorAll(selector)[index];
  if (!found) throw new Error(`no element ${index} for "${selector}"`);
  return found;
}

/** The `index`-th child node of `parent`; throws when there is none. */
export function childOf(parent: Node, index = 0): ChildNode {
  const child = parent.childNodes[index];
  if (!child) throw new Error(`no child ${index}`);
  return child;
}

/** An open shadow root on the element matching `selector`, holding `html`. */
export function shadowOf(selector: string, html: string): ShadowRoot {
  const shadow = el(selector).attachShadow({ mode: 'open' });
  shadow.innerHTML = html;
  return shadow;
}

/**
 * A range over the first occurrence of `text` in the text nodes under `root`, which may run
 * across several of them. Written apart from the text index, so tests do not grade it on itself.
 */
export function rangeOf(text: string, root: Node = document.body): Range {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let all = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(all.length);
    all += (node as Text).data;
  }
  const at = all.indexOf(text);
  if (at === -1 || text === '') throw new Error(`"${text}" is not in the document`);
  const locate = (offset: number, isEnd: boolean): [Text, number] => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] as Text;
      const start = starts[i] as number;
      const inside = isEnd
        ? offset > start && offset <= start + node.length
        : offset >= start && offset < start + node.length;
      if (inside) return [node, offset - start];
    }
    throw new Error(`offset ${offset} is outside the text`);
  };
  const range = document.createRange();
  range.setStart(...locate(at, false));
  range.setEnd(...locate(at + text.length, true));
  return range;
}
