import type { Anchor } from '@pinwall/shared/protocol';
import { expect, test } from 'vitest';
import type { PickedAnchor } from '../frame/use-frame-bridge.ts';
import { composerFloats, composerPosition } from './composer-position.ts';

const VIEWPORT = { width: 1280, height: 800 };

test('the composer sits beside the point and stays on screen', () => {
  expect(composerPosition({ x: 100, y: 50 }, { left: 56, top: 52 }, 1, VIEWPORT)).toEqual({
    left: 168,
    top: 114,
  });
  expect(composerPosition({ x: 1100, y: 700 }, { left: 56, top: 52 }, 1, VIEWPORT)).toEqual({
    left: 824,
    top: 544,
  });
  expect(composerPosition({ x: 200, y: 100 }, { left: 0, top: 0 }, 0.5, VIEWPORT)).toEqual({
    left: 112,
    top: 62,
  });
});

test('a composer that fits neither side is kept 8 px inside the viewport', () => {
  // Flipped up, it would start above the top edge.
  expect(
    composerPosition({ x: 10, y: 150 }, { left: 0, top: 0 }, 1, { width: 360, height: 300 }),
  ).toEqual({ left: 22, top: 8 });
  // Narrower than the composer: pinned to the left gutter.
  expect(
    composerPosition({ x: 200, y: 10 }, { left: 0, top: 0 }, 1, { width: 300, height: 800 }),
  ).toEqual({ left: 8, top: 22 });
  // A point beyond the bottom right corner still yields a composer on screen.
  expect(
    composerPosition({ x: 5000, y: 5000 }, { left: 0, top: 0 }, 1, VIEWPORT, {
      width: 200,
      height: 100,
    }),
  ).toEqual({ left: 1072, top: 692 });
});

const anchor: Anchor = {
  page: '',
  kind: 'point',
  position: { x: 0.5, y: 0.5 },
  viewport: { width: 800 },
};

test('only a pick in the top frame with a point floats, and only in the docked layout', () => {
  const top: PickedAnchor = {
    anchor,
    frameId: 'f1',
    topFrame: true,
    client: { x: 1, y: 2 },
  };
  expect(composerFloats(top, 'dock')).toBe(true);
  expect(composerFloats(top, 'sheet')).toBe(false);
  expect(composerFloats({ ...top, topFrame: false, client: null }, 'dock')).toBe(false);
  expect(composerFloats({ ...top, client: null }, 'dock')).toBe(false);
});
