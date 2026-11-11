import { expect, test } from 'vitest';
import { createScrollSync } from './scroll-sync.ts';

test('only the leader is mirrored', () => {
  const s = createScrollSync();
  s.lead('from');
  expect(s.scrolled('from', { x: 0, y: 0.4 })).toEqual({ side: 'to', f: { x: 0, y: 0.4 } });
  expect(s.scrolled('to', { x: 0, y: 0.4 })).toBeNull();
  s.lead('to');
  expect(s.scrolled('to', { x: 0, y: 0.1 })?.side).toBe('from');
  s.setEnabled(false);
  expect(s.scrolled('to', { x: 0, y: 0.2 })).toBeNull();
  s.setEnabled(true);
  expect(s.scrolled('to', { x: 0.5, y: 0.2 })).toEqual({ side: 'from', f: { x: 0.5, y: 0.2 } });
});

test('nothing is mirrored before a side leads', () => {
  const s = createScrollSync();
  expect(s.scrolled('from', { x: 0, y: 1 })).toBeNull();
  expect(s.scrolled('to', { x: 0, y: 1 })).toBeNull();
});
