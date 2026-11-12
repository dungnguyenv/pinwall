import { expect, test } from 'vitest';
import type { VersionSummary } from '../../api/dto.ts';
import { versionOf } from '../../test/review.ts';
import { defaultPair } from './defaults.ts';

/** Versions numbered `numbers`, newest first, `current` the current one (default the newest). */
function versions(numbers: number[], current = Math.max(...numbers)): VersionSummary[] {
  return [...numbers].sort((a, b) => b - a).map((n) => versionOf(n, { is_current: n === current }));
}

test('defaultPair', () => {
  const three = versions([3, 2, 1]);
  expect(defaultPair(three)).toEqual({ from: 2, to: 3 });
  expect(defaultPair(three, undefined, 1)).toEqual({ from: 2, to: 1 });
  expect(defaultPair(versions([5, 2]))).toEqual({ from: 2, to: 5 });
  expect(defaultPair(versions([4]))).toBeNull();
  expect(defaultPair([])).toBeNull();
  // from === to: from is derived again.
  expect(defaultPair(three, 3, 3)).toEqual({ from: 2, to: 3 });
});

test('numbers that exist are kept; others fall back', () => {
  const three = versions([3, 2, 1]);
  expect(defaultPair(three, 1, 3)).toEqual({ from: 1, to: 3 });
  expect(defaultPair(three, 3, 1)).toEqual({ from: 3, to: 1 });
  // A deleted or unknown number: to falls back to the current, from below it.
  expect(defaultPair(three, 9, 7)).toEqual({ from: 2, to: 3 });
  expect(defaultPair(three, 1, 7)).toEqual({ from: 1, to: 3 });
  // `to` defaults to the current version, even where it is not the newest.
  expect(defaultPair(versions([3, 2, 1], 2))).toEqual({ from: 1, to: 2 });
});
