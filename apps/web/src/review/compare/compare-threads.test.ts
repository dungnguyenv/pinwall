import { expect, test } from 'vitest';
import type { CommentThread } from '../../api/dto.ts';
import { fx } from '../../test/fixtures.ts';
import { compareThreads, resolvedBetween } from './compare-threads.ts';

const v = (n: number) => ({ id: `ver_${n}`, number: n });
function on(n: number, id: string, o: Partial<CommentThread> = {}): CommentThread {
  return fx.thread({ id, version: v(n), ...o });
}
const resolvedIn = (n: number): Partial<CommentThread> => ({
  status: 'resolved',
  resolved_in_version: v(n),
  resolved_by: { user_id: 'usr_1', name: 'Ada' },
  resolved_at: 1,
});

// In creation order: a thread on v3 was written before two on v2.
const a = on(1, 'a');
const c = on(3, 'c');
const b = on(2, 'b', resolvedIn(3));
const d = on(2, 'd');
const e = on(4, 'e');
const later = on(5, 'later');
const list = [a, c, b, d, e, later];

const ids = (threads: CommentThread[]) => threads.map((t) => t.id);

test('each thread is listed once, under the older version whose page shows it', () => {
  const groups = compareThreads(list, { from: 2, to: 4 });
  expect(groups.older.version).toBe(2);
  expect(ids(groups.older.threads)).toEqual(['a', 'b', 'd']);
  expect(groups.newer.version).toBe(4);
  expect(ids(groups.newer.threads)).toEqual(['c', 'e']);
  // Nothing written after the newer version.
  expect(ids([...groups.older.threads, ...groups.newer.threads])).not.toContain('later');
});

test('pin numbers are the ones each version’s review page gives', () => {
  const { older, newer } = compareThreads(list, { from: 2, to: 4 });
  // v2's page shows a, b, d.
  expect(older.threads.map((t) => older.numbers.get(t.id))).toEqual([1, 2, 3]);
  // v4's page shows a, c, b, d, e: c is its second pin, e its fifth.
  expect(newer.threads.map((t) => newer.numbers.get(t.id))).toEqual([2, 5]);
});

test('a swapped pair groups the same way', () => {
  const swapped = compareThreads(list, { from: 4, to: 2 });
  expect(swapped).toEqual(compareThreads(list, { from: 2, to: 4 }));
});

test('resolved between: in the newer version or one between, not at or before the older', () => {
  const range = { older: 2, newer: 4 };
  expect(resolvedBetween(on(2, 'x', resolvedIn(3)), range)).toBe(true);
  expect(resolvedBetween(on(2, 'x', resolvedIn(4)), range)).toBe(true);
  expect(resolvedBetween(on(1, 'x', resolvedIn(2)), range)).toBe(false);
  expect(resolvedBetween(on(2, 'x', resolvedIn(5)), range)).toBe(false);
  expect(resolvedBetween(on(2, 'x'), range)).toBe(false);
  // Resolved in a version deleted since: no version to place it by.
  expect(resolvedBetween(on(2, 'x', { ...resolvedIn(3), resolved_in_version: null }), range)).toBe(
    false,
  );
});
