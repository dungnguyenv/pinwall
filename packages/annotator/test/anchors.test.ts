import { Anchor } from '@pinwall/shared/protocol';
import { expect, test } from 'vitest';
import { elementAnchor, pointAnchor, textAnchor } from '../src/anchors.ts';
import { childOf, el, rangeOf, shadowOf } from './helpers/dom.ts';
import { stubLayout } from './helpers/layout.ts';

const ctx = () => ({ doc: document, page: 'docs/' });

test('a text anchor keeps the exact quote with 32 characters of context', () => {
  document.body.innerHTML = `<p>${'x'.repeat(40)} Alpha beta gamma ${'y'.repeat(40)}</p>`;
  const a = textAnchor({ doc: document, page: 'docs/' }, rangeOf('beta gamma'));
  expect(a).toMatchObject({
    kind: 'text',
    page: 'docs/',
    dom: { path: 'body > p' },
    quote: {
      exact: 'beta gamma',
      prefix: `${'x'.repeat(25)} Alpha `,
      suffix: ` ${'y'.repeat(31)}`,
    },
  });
});

test('selections are trimmed, may span elements and are capped', () => {
  document.body.innerHTML = `<p>${'x'.repeat(40)} Alpha beta gamma ${'y'.repeat(40)}</p>`;
  const trimmed = textAnchor(ctx(), rangeOf(' beta '))?.quote;
  expect(trimmed?.exact).toBe('beta');
  expect(trimmed?.prefix.endsWith('Alpha ')).toBe(true);
  expect(trimmed?.suffix.startsWith(' gamma')).toBe(true);

  document.body.innerHTML = '<p>one <b>two</b> three</p>';
  const p = el('p');
  const across = document.createRange();
  across.setStart(childOf(p, 0), 1);
  across.setEnd(childOf(p, 2), 3);
  expect(textAnchor(ctx(), across)).toMatchObject({
    quote: { exact: 'ne two th', prefix: 'o', suffix: 'ree' },
    dom: { path: 'body > p' },
  });
  const contents = document.createRange();
  contents.selectNodeContents(el('b'));
  expect(textAnchor(ctx(), contents)).toMatchObject({
    quote: { exact: 'two', prefix: 'one ', suffix: ' three' },
    dom: { path: 'body > p > b' },
  });
  const boundaries = document.createRange();
  boundaries.setStart(document.body, 0);
  boundaries.setEnd(p, 2);
  expect(textAnchor(ctx(), boundaries)?.quote?.exact).toBe('one two');

  document.body.innerHTML = '<p>a</p><p>   \n  </p><p>b</p>';
  expect(textAnchor(ctx(), rangeOf('   \n  '))).toBeNull();

  document.body.innerHTML = `<p>${'abc'.repeat(1000)}</p>`;
  expect(textAnchor(ctx(), rangeOf('abc'.repeat(1000)))?.quote?.exact).toHaveLength(2000);
});

test('cuts never split a letter from its marks or a surrogate pair', () => {
  const nfd = 'e\u0323\u0302'; // ệ, decomposed
  document.body.innerHTML = `<p>${'a'.repeat(1999)}${nfd}${'b'.repeat(1000)}</p>`;
  const marks = textAnchor(ctx(), rangeOf(`${'a'.repeat(1999)}${nfd}b`));
  expect(marks?.quote?.exact).toBe('a'.repeat(1999));

  document.body.innerHTML = `<p>😀${'x'.repeat(31)}target${'y'.repeat(31)}😀</p>`;
  const quote = textAnchor(ctx(), rangeOf('target'))?.quote;
  expect(quote).toEqual({ exact: 'target', prefix: 'x'.repeat(31), suffix: 'y'.repeat(31) });

  document.body.innerHTML = `<p>${'a'.repeat(1999)}😀${'b'.repeat(10)}</p>`;
  expect(textAnchor(ctx(), rangeOf(`${'a'.repeat(1999)}😀b`))?.quote?.exact).toBe('a'.repeat(1999));
});

test('selections outside the page text make no text anchor', () => {
  document.body.innerHTML = '<div id="host"></div><p>visible</p>';
  const shadow = shadowOf('#host', '<p>inside a shadow root</p>');
  const inShadow = document.createRange();
  inShadow.selectNodeContents(el('p', 0, shadow));
  expect(textAnchor(ctx(), inShadow)).toBeNull();

  const detached = document.createElement('p');
  detached.textContent = 'detached';
  const offPage = document.createRange();
  offPage.selectNodeContents(detached);
  expect(textAnchor(ctx(), offPage)).toBeNull();
});

test('positions are fractions of the document and keep the viewport width', () => {
  document.body.innerHTML = '<h2>Prices</h2><p>Some text</p>';
  const h2 = el('h2');
  const text = rangeOf('Some');
  stubLayout({
    scrollWidth: 1000,
    scrollHeight: 4000,
    clientWidth: 800,
    scrollY: 1000,
    rects: [
      [h2, { left: 100, top: 200 }],
      [text, { left: 250, top: 0 }],
    ],
  });
  expect(elementAnchor(ctx(), h2)).toStrictEqual({
    page: 'docs/',
    kind: 'element',
    dom: { path: 'body > h2' },
    position: { x: 0.1, y: 0.3 },
    viewport: { width: 800 },
  });
  expect(pointAnchor(ctx(), 500, 0)).toStrictEqual({
    page: 'docs/',
    kind: 'point',
    position: { x: 0.5, y: 0.25 },
    viewport: { width: 800 },
  });
  expect(textAnchor(ctx(), text)?.position).toEqual({ x: 0.25, y: 0.25 });
  expect(pointAnchor(ctx(), -50, 1000 / 3).position).toEqual({ x: 0, y: 0.3333 });
  expect(pointAnchor(ctx(), 5000, Number.NaN).position).toEqual({ x: 1, y: 0 });
});

test('without layout, anchors sit at the top left and still pass the protocol schema', () => {
  document.body.innerHTML = '<p>Xem <b>Bảng giá</b> mới</p>';
  const anchors = [
    textAnchor(ctx(), rangeOf('Bảng giá')),
    elementAnchor(ctx(), el('b')),
    pointAnchor(ctx(), 0, 0),
  ];
  for (const anchor of anchors) {
    expect(anchor?.position).toEqual({ x: 0, y: 0 });
    expect(anchor?.viewport).toEqual({ width: 0 });
    expect(Anchor.safeParse(anchor).success).toBe(true);
  }
  expect(elementAnchor(ctx(), document.body)).toBeNull();
});
