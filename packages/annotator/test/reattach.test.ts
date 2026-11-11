import type { Anchor } from '@pinwall/shared/protocol';
import { expect, test } from 'vitest';
import { textAnchor } from '../src/anchors.ts';
import { findQuote, placeAnchor } from '../src/reattach.ts';
import { buildTextIndex } from '../src/text-index.ts';
import { anchorOf, rangeOf, sampleAnchor } from './helpers/dom.ts';

const place = (anchor: Anchor) => placeAnchor(document, buildTextIndex(document), anchor);
const anchorAt = (text: string): Anchor => {
  const anchor = textAnchor({ doc: document, page: '' }, rangeOf(text));
  if (!anchor) throw new Error(`no text anchor for "${text}"`);
  return anchor;
};
const placedText = (anchor: Anchor) => {
  const placement = place(anchor);
  return placement.via === 'quote' ? placement.range.toString() : null;
};

test('re-attaches by exact quote', () => {
  document.body.innerHTML = '<section id="pricing"><h2>Xem <b>Bảng</b> giá mới</h2></section>';
  const placement = place(sampleAnchor);
  expect(placement).toMatchObject({ found: true, via: 'quote' });
  expect(placement.via === 'quote' && placement.range.toString()).toBe('Bảng giá');
});

test('picks the occurrence whose context matches', () => {
  document.body.innerHTML = '<p>Price: 10 USD per month.</p><p>Total: 10 USD per year.</p>';
  const p = placeAnchor(
    document,
    buildTextIndex(document),
    anchorOf({ quote: { exact: '10 USD', prefix: 'Total: ', suffix: ' per year.' } }),
  );
  expect(
    p.via === 'quote' && p.range.startContainer.parentElement === document.querySelectorAll('p')[1],
  ).toBe(true);
});

test('a repeated phrase goes to the occurrence whose context matches once normalized', () => {
  // v1 read "Price list. Total: 10 USD per year."; v2 states "10 USD" earlier too, and a formatter
  // reflowed the occurrence the comment quotes.
  const v2 = 'Pricing\n  Fee: 10 USD per month.\n  Total:\n      10 USD\n      per year.\n';
  const quote = { exact: '10 USD', prefix: 'Price list. Total: ', suffix: ' per year.' };
  expect(findQuote(v2, quote)?.start).toBe(v2.lastIndexOf('10 USD'));

  // The quoted occurrence now has a no-break space; another one still has a plain space.
  const nbsp = 'Fee: 10 USD per month. Total: 10\u00a0USD per year.';
  const total = { exact: '10 USD', prefix: 'Total: ', suffix: ' per year.' };
  expect(findQuote(nbsp, total)).toEqual({
    start: nbsp.indexOf('10\u00a0USD'),
    end: nbsp.indexOf('10\u00a0USD') + 6,
  });

  // The quoted occurrence's context is now in NFD; an unaccented one comes first.
  document.body.innerHTML = `<p>Tong: 10 USD/nam.</p><p>${'Tổng: 10 USD/năm.'.normalize('NFD')}</p>`;
  const nfd = place(anchorOf({ quote: { exact: '10 USD', prefix: 'Tổng: ', suffix: '/năm' } }));
  expect(nfd.via === 'quote' && nfd.range.startContainer.parentElement).toBe(
    document.querySelectorAll('p')[1],
  );
});

test('falls back to whitespace-normalized matching', () => {
  document.body.innerHTML = '<p>Alpha beta\n      gamma delta</p>';
  const anchor = anchorOf({ quote: { exact: 'beta gamma', prefix: 'Alpha ', suffix: ' delta' } });
  expect(place(anchor)).toMatchObject({ found: true, via: 'quote' });
  expect(placedText(anchor)).toBe('beta\n      gamma');
  // The stored quote may hold the whitespace runs instead.
  document.body.innerHTML = '<p>Alpha beta gamma delta</p>';
  const reflowed = { exact: ' beta\n\t gamma ', prefix: 'Alpha\n', suffix: '\ndelta' };
  expect(placedText(anchorOf({ quote: reflowed }))).toBe('beta gamma');
});

test('matches Vietnamese text whatever its Unicode form, mark order or node split', () => {
  const nfc = 'Xem Bảng giá mới';
  document.body.innerHTML = `<p>${nfc.normalize('NFD')}</p>`;
  expect(placedText(sampleAnchor)).toBe('Bảng giá'.normalize('NFD'));

  document.body.innerHTML = `<p>${nfc}</p>`;
  const nfdQuote = {
    exact: 'Bảng giá'.normalize('NFD'),
    prefix: 'Xem ',
    suffix: ' mới'.normalize('NFD'),
  };
  expect(placedText(anchorOf({ quote: nfdQuote }))).toBe('Bảng giá');

  // ệ written as e + circumflex + dot below, the reverse of the canonical order.
  document.body.innerHTML = '<p>Hệ thống chạy tốt</p>'.replace('ệ', 'e\u0302\u0323');
  const order = { exact: 'Hệ thống', prefix: '', suffix: ' chạy' };
  expect(placedText(anchorOf({ quote: order }))).toBe('He\u0302\u0323 thống');

  // Split over many nodes, one boundary between a letter and its mark.
  document.body.innerHTML = '<p>Xem <b>Ba</b><i>\u0309ng</i> <span>gi</span>á <u>m</u>ới</p>';
  expect(placedText(sampleAnchor)).toBe('Ba\u0309ng giá');
});

test('falls back to the DOM path, then to the position', () => {
  document.body.innerHTML = '<section id="price"><h2>Prices</h2></section>';
  const anchor = anchorOf({ dom: { path: '#price > h2' } });
  const placement = place(anchor);
  expect(placement).toMatchObject({ found: true, via: 'dom' });
  expect(placement.via === 'dom' && placement.element).toBe(document.querySelector('h2'));
  document.body.innerHTML = '<section><h2>Prices</h2></section>';
  expect(place(anchor)).toEqual({ found: false, via: 'position' });
  expect(place(anchorOf({ dom: undefined }))).toEqual({ found: false, via: 'position' });
});

test('an invalid stored selector never throws', () => {
  document.head.innerHTML = '<title>t</title>';
  document.body.innerHTML = '<p>text <b>bold</b></p>';
  for (const path of ['p:::', 'body *', 'p:has(b)', 'p, b', 'html > head', 'head', 'body', '#']) {
    expect(place(anchorOf({ dom: { path } })), path).toEqual({ found: false, via: 'position' });
    expect(place(anchorOf({ kind: 'element', dom: { path } })), path).toEqual({
      found: false,
      via: 'position',
    });
  }
});

test('element anchors try the DOM path; point anchors are placed by position', () => {
  document.body.innerHTML = '<main><p>Xem Bảng giá mới</p><p>b</p></main>';
  const element = anchorOf({ kind: 'element', dom: { path: 'body > main > p:nth-of-type(2)' } });
  const placement = place(element);
  expect(placement).toMatchObject({ found: true, via: 'dom' });
  expect(placement.via === 'dom' && placement.element).toBe(document.querySelectorAll('p')[1]);
  document.body.innerHTML = '<main><p>Xem Bảng giá mới</p></main>';
  expect(place(element)).toEqual({ found: false, via: 'position' });
  expect(place(anchorOf({ kind: 'point', quote: undefined, dom: undefined }))).toEqual({
    found: true,
    via: 'position',
  });
  expect(place(anchorOf({ kind: 'point' }))).toEqual({ found: true, via: 'position' });
});

test('re-attaches across a new version where text moved, changed slightly or was deleted', () => {
  document.body.innerHTML =
    '<main><section><h2>Plans</h2><p id="note">Prices include VAT for every plan.</p></section>' +
    '<section><p>Other text</p></section></main>';
  const anchor = anchorAt('include VAT');
  expect(anchor.dom).toEqual({ path: '#note' });

  // Moved to another section.
  document.body.innerHTML =
    '<main><section><h2>Plans</h2></section><section><p>Other text</p>' +
    '<p id="note">Prices include VAT for every plan.</p></section></main>';
  const moved = place(anchor);
  expect(
    moved.via === 'quote' && moved.range.startContainer.parentElement?.closest('section'),
  ).toBe(document.querySelectorAll('section')[1]);

  // Reflowed by a formatter.
  document.body.innerHTML =
    '<main><section><p>Prices\n      include\n      VAT for every plan.</p></section></main>';
  expect(placedText(anchor)).toBe('include\n      VAT');

  // Reworded, but the element is still there.
  document.body.innerHTML = '<main><section><p id="note">Prices exclude VAT.</p></section></main>';
  expect(place(anchor)).toMatchObject({ found: true, via: 'dom' });

  // Deleted.
  document.body.innerHTML = '<main><section><h2>Plans</h2></section></main>';
  expect(place(anchor)).toEqual({ found: false, via: 'position' });
});

test('stays fast on a 10k-node page', () => {
  const items = (from: number, count: number, gap: string) =>
    Array.from({ length: count }, (_, i) => `<li>Item ${from + i}${gap}<b>note</b></li>`).join('');
  document.body.innerHTML = `<ul>${items(0, 2500, ' ')}</ul>`;
  expect(document.body.querySelectorAll('*').length + 2 * 2500).toBeGreaterThanOrEqual(10_000);
  const anchor = anchorAt('Item 2400 note');

  document.body.innerHTML = `<ul>${items(-100, 2600, '\n   ')}</ul>`;
  const started = performance.now();
  const index = buildTextIndex(document);
  const exact = placeAnchor(
    document,
    index,
    anchorOf({ quote: { exact: 'Item 2499', prefix: '', suffix: '' } }),
  );
  const normalized = placeAnchor(document, index, anchor);
  const missing = placeAnchor(document, index, anchorOf({ dom: undefined }));
  expect(performance.now() - started).toBeLessThan(1000);
  expect(exact.via).toBe('quote');
  expect(normalized.via === 'quote' && normalized.range.toString()).toBe('Item 2400\n   note');
  expect(missing).toEqual({ found: false, via: 'position' });
});

test('findQuote weighs the context of at most 1000 occurrences', () => {
  const text = Array.from({ length: 1200 }, (_, i) => `[${i}] item`).join(' ');
  const after = (marker: string) => text.indexOf(marker) + marker.length;
  expect(findQuote(text, { exact: 'item', prefix: '[999] ', suffix: '' })).toEqual({
    start: after('[999] '),
    end: after('[999] ') + 4,
  });
  // The 1101st occurrence is past the cap: the best of the first 1000 wins.
  expect(findQuote(text, { exact: 'item', prefix: '[1100] ', suffix: '' })?.start).toBe(
    after(' [100] '),
  );
  expect(findQuote(text, { exact: 'missing', prefix: '', suffix: '' })).toBeNull();
});

test('findQuote maps normalized matches back to the original text', () => {
  expect(findQuote('a  b\n\tc d', { exact: 'b c', prefix: 'a ', suffix: '' })).toEqual({
    start: 3,
    end: 7,
  });
  expect(findQuote('x Ba\u0309ng y', { exact: 'Bảng', prefix: '', suffix: '' })).toEqual({
    start: 2,
    end: 7,
  });
  expect(findQuote('a b', { exact: ' \n ', prefix: '', suffix: '' })).toBeNull();
});
