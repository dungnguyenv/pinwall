import { expect, test } from 'vitest';
import {
  ANNOTATOR_GLOBAL,
  ANNOTATOR_PATH,
  Anchor,
  ClientPoint,
  MAX_ANCHORS,
  PROTOCOL_VERSION,
  parsePageMessage,
  parseViewerMessage,
  ScrollFraction,
} from '../src/protocol.ts';

const text = {
  page: 'docs/',
  kind: 'text',
  quote: { exact: 'Bảng giá', prefix: 'Xem ', suffix: ' mới' },
  dom: { path: '#pricing > h2' },
  position: { x: 0.1, y: 0.2 },
  viewport: { width: 1280 },
};

test('the protocol names its version, script path and global', () => {
  expect(PROTOCOL_VERSION).toBe(1);
  expect(ANNOTATOR_PATH).toBe('__pinwall/annotator.js');
  expect(ANNOTATOR_GLOBAL).toBe('__pinwallAnnotator');
});

test('Anchor accepts each kind and enforces its selectors', () => {
  expect(Anchor.parse(text)).toEqual(text);
  expect(Anchor.safeParse({ ...text, quote: undefined }).success).toBe(false);
  expect(
    Anchor.safeParse({ ...text, kind: 'element', quote: undefined, dom: undefined }).success,
  ).toBe(false);
  expect(
    Anchor.parse({ page: '', kind: 'point', position: { x: 0, y: 1 }, viewport: { width: 0 } })
      .kind,
  ).toBe('point');
  for (const bad of [
    { position: { x: 1.5, y: 0 } },
    { quote: { ...text.quote, prefix: 'p'.repeat(33) } },
    { quote: { ...text.quote, exact: 'e'.repeat(2001) } },
    { dom: { path: '' } },
  ]) {
    expect(Anchor.safeParse({ ...text, ...bad }).success).toBe(false);
  }
});

test('a missing selector is reported on its own field', () => {
  const noQuote = Anchor.safeParse({ ...text, quote: undefined });
  expect(noQuote.error?.issues.map((issue) => issue.path)).toEqual([['quote']]);
  const noDom = Anchor.safeParse({ ...text, kind: 'element', dom: undefined });
  expect(noDom.error?.issues.map((issue) => issue.path)).toEqual([['dom']]);
  expect(Anchor.parse({ ...text, kind: 'element', quote: undefined }).dom).toEqual(text.dom);
});

test('Anchor keeps its numbers and strings within bounds', () => {
  for (const bad of [
    { page: 'p'.repeat(1025) },
    { kind: 'area' },
    { position: { x: -0.1, y: 0 } },
    { position: { x: 0, y: Number.NaN } },
    { viewport: { width: 100_001 } },
    { viewport: { width: 12.5 } },
    { quote: { ...text.quote, exact: '' } },
    { dom: { path: 'd'.repeat(2001) } },
  ]) {
    expect(Anchor.safeParse({ ...text, ...bad }).success).toBe(false);
  }
  expect(Anchor.safeParse({ ...text, page: 'p'.repeat(1024) }).success).toBe(true);
  expect(Anchor.safeParse({ ...text, viewport: { width: 100_000 } }).success).toBe(true);
});

test('messages need pinwall: 1 and a known type for their direction', () => {
  expect(parsePageMessage({ pinwall: 1, type: 'ready', page: '', frameId: 'f1' })).toEqual({
    pinwall: 1,
    type: 'ready',
    page: '',
    frameId: 'f1',
  });
  for (const bad of [
    { pinwall: 2, type: 'ready', page: '', frameId: 'f1' },
    { pinwall: 1, type: 'nope' },
    'ready',
    null,
    { pinwall: 1, type: 'set-mode', mode: 'comment' },
  ]) {
    expect(parsePageMessage(bad)).toBeNull();
  }
  expect(parseViewerMessage({ pinwall: 1, type: 'set-mode', mode: 'comment' })?.type).toBe(
    'set-mode',
  );
  const many = Array.from({ length: 1001 }, (_, i) => ({
    id: `c${i}`,
    number: i + 1,
    resolved: false,
    anchor: text,
  }));
  expect(parseViewerMessage({ pinwall: 1, type: 'show-anchors', anchors: many })).toBeNull();
  expect(
    parseViewerMessage({ pinwall: 1, type: 'show-anchors', anchors: many.slice(0, MAX_ANCHORS) }),
  ).not.toBeNull();
});

test('every page message parses, and ids stay short', () => {
  const ok = [
    { pinwall: 1, type: 'ready', page: 'a.html', frameId: 'f1' },
    { pinwall: 1, type: 'anchor-picked', anchor: text, frameId: 'f1' },
    { pinwall: 1, type: 'anchors-placed', results: [{ id: 'c1', found: true }], frameId: 'f1' },
    {
      pinwall: 1,
      type: 'anchors-placed',
      results: [
        { id: 'c1', found: true, via: 'quote' },
        { id: 'c2', found: false, via: 'dom' },
        { id: 'c3', found: false, via: 'position' },
      ],
      frameId: 'f1',
    },
    { pinwall: 1, type: 'pin-clicked', id: 'c1' },
    { pinwall: 1, type: 'navigated', page: 'docs/', frameId: 'f2' },
  ];
  for (const message of ok) expect(parsePageMessage(message)).toEqual(message);
  for (const bad of [
    { pinwall: 1, type: 'pin-clicked', id: '' },
    { pinwall: 1, type: 'pin-clicked', id: 'x'.repeat(65) },
    { pinwall: 1, type: 'ready', page: '', frameId: 'f'.repeat(65) },
    { pinwall: 1, type: 'anchor-picked', anchor: { ...text, kind: 'element', dom: undefined } },
    {
      pinwall: 1,
      type: 'anchors-placed',
      results: [{ id: 'c1', found: true, via: 'path' }],
      frameId: 'f1',
    },
    {
      pinwall: 1,
      type: 'anchors-placed',
      results: Array.from({ length: 1001 }, (_, i) => ({ id: `c${i}`, found: false })),
      frameId: 'f1',
    },
  ]) {
    expect(parsePageMessage(bad)).toBeNull();
  }
});

test('every viewer message parses, and pin numbers start at 1', () => {
  const ok = [
    { pinwall: 1, type: 'set-mode', mode: 'browse' },
    {
      pinwall: 1,
      type: 'show-anchors',
      anchors: [{ id: 'c1', number: 1, resolved: true, anchor: text }],
    },
    { pinwall: 1, type: 'focus-anchor', id: 'c1' },
  ];
  for (const message of ok) expect(parseViewerMessage(message)).toEqual(message);
  for (const bad of [
    { pinwall: 1, type: 'set-mode', mode: 'draw' },
    {
      pinwall: 1,
      type: 'show-anchors',
      anchors: [{ id: 'c1', number: 0, resolved: false, anchor: text }],
    },
    { pinwall: 1, type: 'ready', page: '', frameId: 'f1' },
    undefined,
  ]) {
    expect(parseViewerMessage(bad)).toBeNull();
  }
});

test('pick points and scroll messages validate', () => {
  const pointA = {
    page: '',
    kind: 'point',
    position: { x: 0.2, y: 0.3 },
    viewport: { width: 800 },
  };
  expect(
    parsePageMessage({
      pinwall: 1,
      type: 'anchor-picked',
      anchor: pointA,
      frameId: 'f1',
      client: { x: 120, y: 48.5 },
    })?.type,
  ).toBe('anchor-picked');
  expect(
    parsePageMessage({ pinwall: 1, type: 'anchor-picked', anchor: pointA, frameId: 'f1' }),
  ).not.toBeNull();
  expect(parsePageMessage({ pinwall: 1, type: 'scrolled', frameId: 'f1', x: 0, y: 0.5 })).toEqual({
    pinwall: 1,
    type: 'scrolled',
    frameId: 'f1',
    x: 0,
    y: 0.5,
  });
  for (const bad of [
    { type: 'scrolled', frameId: 'f1', x: 1.2, y: 0 },
    { type: 'scrolled', frameId: 'f1', x: 0, y: -0.1 },
    { type: 'scrolled', x: 0, y: 0 },
    {
      type: 'anchor-picked',
      anchor: pointA,
      frameId: 'f1',
      client: { x: Number.POSITIVE_INFINITY, y: 0 },
    },
    { type: 'anchor-picked', anchor: pointA, frameId: 'f1', client: { x: 0, y: Number.NaN } },
    { type: 'anchor-picked', anchor: pointA, frameId: 'f1', client: { x: 100_001, y: 0 } },
    { type: 'anchor-picked', anchor: pointA, frameId: 'f1', client: { x: 0, y: -100_001 } },
    { type: 'anchor-picked', anchor: pointA, frameId: 'f1', client: { x: 0 } },
  ]) {
    expect(parsePageMessage({ pinwall: 1, ...bad })).toBeNull();
  }
  expect(
    parsePageMessage({
      pinwall: 1,
      type: 'anchor-picked',
      anchor: pointA,
      frameId: 'f1',
      client: { x: -100_000, y: 100_000 },
    }),
  ).not.toBeNull();
  expect(parseViewerMessage({ pinwall: 1, type: 'scroll-to', x: 0.25, y: 1 })?.type).toBe(
    'scroll-to',
  );
  expect(parseViewerMessage({ pinwall: 1, type: 'scroll-to', x: 0.25, y: 1.5 })).toBeNull();
  expect(parsePageMessage({ pinwall: 1, type: 'scroll-to', x: 0, y: 0 })).toBeNull();
  expect(
    parseViewerMessage({ pinwall: 1, type: 'scrolled', frameId: 'f1', x: 0, y: 0 }),
  ).toBeNull();
});

test('ClientPoint and ScrollFraction name the new shapes', () => {
  expect(ClientPoint.parse({ x: -5, y: 12.25 })).toEqual({ x: -5, y: 12.25 });
  expect(ClientPoint.safeParse({ x: Number.NEGATIVE_INFINITY, y: 0 }).success).toBe(false);
  expect(ScrollFraction.parse({ x: 1, y: 0 })).toEqual({ x: 1, y: 0 });
  expect(ScrollFraction.safeParse({ x: 0, y: 1.0001 }).success).toBe(false);
});
