import { expect, test, vi } from 'vitest';
import {
  Anchor,
  MAX_ANCHORS,
  PAGE_MAX_CHARS,
  parsePageMessage,
  parseViewerMessage,
} from '../src/protocol.ts';

// The annotator bundle builds the protocol schemas with zod/mini (packages/annotator/bundle.mjs),
// so they must use only the API zod and zod/mini share, and validate the same way under both.
vi.mock('zod', async () => await vi.importActual('zod/mini'));

const text = {
  page: 'docs/',
  kind: 'text',
  quote: { exact: 'Bảng giá', prefix: 'Xem ', suffix: ' mới' },
  dom: { path: '#pricing > h2' },
  position: { x: 0.1, y: 0.2 },
  viewport: { width: 1280 },
};

test('the schemas are built with zod/mini here', () => {
  expect('optional' in Anchor).toBe(false);
  expect(typeof Anchor.check).toBe('function');
});

test('Anchor validates under zod/mini as under zod', () => {
  expect(Anchor.parse(text)).toEqual(text);
  expect(Anchor.safeParse({ ...text, quote: undefined }).error?.issues.map((i) => i.path)).toEqual([
    ['quote'],
  ]);
  expect(
    Anchor.safeParse({ ...text, kind: 'element', dom: undefined }).error?.issues.map((i) => i.path),
  ).toEqual([['dom']]);
  for (const bad of [
    { page: 'p'.repeat(PAGE_MAX_CHARS + 1) },
    { kind: 'area' },
    { position: { x: 1.5, y: 0 } },
    { position: { x: 0, y: Number.NaN } },
    { viewport: { width: 12.5 } },
    { viewport: { width: 100_001 } },
    { quote: { ...text.quote, exact: '' } },
    { quote: { ...text.quote, prefix: 'p'.repeat(33) } },
    { dom: { path: '' } },
  ]) {
    expect(Anchor.safeParse({ ...text, ...bad }).success).toBe(false);
  }
  expect(Anchor.safeParse({ ...text, page: 'p'.repeat(PAGE_MAX_CHARS) }).success).toBe(true);
});

test('messages validate under zod/mini as under zod', () => {
  const ok = [
    { pinwall: 1, type: 'set-mode', mode: 'comment' },
    {
      pinwall: 1,
      type: 'show-anchors',
      anchors: [{ id: 'c1', number: 1, resolved: true, anchor: text }],
    },
    { pinwall: 1, type: 'focus-anchor', id: 'c1' },
  ];
  for (const message of ok) expect(parseViewerMessage(message)).toEqual(message);
  const many = Array.from({ length: MAX_ANCHORS + 1 }, (_, i) => ({
    id: `c${i}`,
    number: i + 1,
    resolved: false,
    anchor: text,
  }));
  for (const bad of [
    { pinwall: 2, type: 'set-mode', mode: 'comment' },
    { pinwall: 1, type: 'set-mode', mode: 'draw' },
    { pinwall: 1, type: 'show-anchors', anchors: many },
    { pinwall: 1, type: 'show-anchors', anchors: [{ ...many[0], number: 0 }] },
    { pinwall: 1, type: 'focus-anchor', id: 'x'.repeat(65) },
    { pinwall: 1, type: 'ready', page: '', frameId: 'f1' },
  ]) {
    expect(parseViewerMessage(bad)).toBeNull();
  }
  expect(parsePageMessage({ pinwall: 1, type: 'ready', page: 'a.html', frameId: 'f1' })).toEqual({
    pinwall: 1,
    type: 'ready',
    page: 'a.html',
    frameId: 'f1',
  });
  expect(parsePageMessage({ pinwall: 1, type: 'pin-clicked', id: '' })).toBeNull();
  const placed = {
    pinwall: 1,
    type: 'anchors-placed',
    results: [
      { id: 'c1', found: true, via: 'quote' },
      { id: 'c2', found: false },
    ],
    frameId: 'f1',
  };
  expect(parsePageMessage(placed)).toEqual(placed);
  expect(
    parsePageMessage({ ...placed, results: [{ id: 'c1', found: true, via: 'path' }] }),
  ).toBeNull();
});
