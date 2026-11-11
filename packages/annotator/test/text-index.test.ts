import { expect, test } from 'vitest';
import { buildTextIndex, TEXT_INDEX_LIMITS } from '../src/text-index.ts';
import { childOf, el } from './helpers/dom.ts';

test('the text index holds the body text in document order, without code or templates', () => {
  document.head.innerHTML = '<title>head text</title>';
  document.body.innerHTML =
    '<p>a<script>b</script><style>c</style><noscript>d</noscript><template>e</template>f</p>' +
    '<svg><text>g</text><style>h</style></svg><!-- i --><p>j</p>';
  expect(buildTextIndex(document).text).toBe('afgj');
});

test('offsets and ranges map between the DOM and the text', () => {
  document.body.innerHTML = '<p>one <b>two</b></p><!-- c --><script>x</script><p>three</p>';
  const index = buildTextIndex(document);
  expect(index.text).toBe('one twothree');
  const [first, second] = [el('p', 0), el('p', 1)];
  const comment = childOf(document.body, 1);
  const scriptText = childOf(el('script'));
  expect(index.toOffset(childOf(first), 2)).toBe(2);
  expect(index.toOffset(childOf(first), 99)).toBe(4);
  expect(index.toOffset(first, 1)).toBe(4);
  expect(index.toOffset(first, 2)).toBe(7);
  expect(index.toOffset(document.body, 0)).toBe(0);
  expect(index.toOffset(document.body, document.body.childNodes.length)).toBe(12);
  expect(index.toOffset(document.documentElement, 0)).toBe(0);
  expect(index.toOffset(comment, 2)).toBe(7);
  expect(index.toOffset(scriptText, 0)).toBe(7);
  expect(index.toOffset(second, 1)).toBe(12);

  // Range.toString() reads the script's text too; the boundaries are what the index sets.
  const across = index.toRange(4, 12);
  expect([
    across.startContainer,
    across.startOffset,
    across.endContainer,
    across.endOffset,
  ]).toEqual([childOf(el('b')), 0, childOf(second), 5]);
  expect(index.toRange(2, 6).toString()).toBe('e tw');
  const atBoundary = index.toRange(7, 7);
  expect([atBoundary.collapsed, atBoundary.startContainer, atBoundary.startOffset]).toEqual([
    true,
    childOf(second),
    0,
  ]);
  const clamped = index.toRange(-5, 99);
  expect([
    clamped.startContainer,
    clamped.startOffset,
    clamped.endContainer,
    clamped.endOffset,
  ]).toEqual([childOf(first), 0, childOf(second), 5]);
});

test('an empty page has an empty index', () => {
  document.body.innerHTML = '<div><img alt=""></div>';
  const index = buildTextIndex(document);
  expect(index.text).toBe('');
  expect(index.toOffset(document.body, 1)).toBe(0);
  expect(index.toRange(0, 5).collapsed).toBe(true);
});

test('the index stops at its character, node and time limits', () => {
  document.body.innerHTML = '<p>0123456789</p><p>abcdefghij</p><p>klm</p>';
  const capped = buildTextIndex(document, { ...TEXT_INDEX_LIMITS, maxChars: 15 });
  expect(capped.text).toBe('0123456789abcde');
  expect(capped.toRange(12, 15).toString()).toBe('cde');
  const second = childOf(el('p', 1));
  expect(capped.toOffset(second, 8)).toBe(15);
  expect(capped.toOffset(el('p', 2), 0)).toBe(15);

  document.body.innerHTML = Array.from({ length: 5000 }, (_, i) => `<p>${i % 10}</p>`).join('');
  expect(buildTextIndex(document).text).toHaveLength(5000);
  expect(buildTextIndex(document, { ...TEXT_INDEX_LIMITS, maxNodes: 100 }).text).toHaveLength(50);
  // The clock is read every 1024 nodes: a spent budget stops the walk at the first reading.
  expect(buildTextIndex(document, { ...TEXT_INDEX_LIMITS, budgetMs: 0 }).text).toHaveLength(511);
});
