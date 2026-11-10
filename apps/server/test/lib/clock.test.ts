import { expect, test } from 'vitest';
import { FixedClock, systemClock } from '../../src/lib/clock.ts';

test('FixedClock only moves when told to', () => {
  const clock = new FixedClock(1_000);
  expect(clock.now()).toBe(1_000);
  clock.advance(500);
  expect(clock.now()).toBe(1_500);
  clock.set(42);
  expect(clock.now()).toBe(42);
});

test('systemClock reports epoch milliseconds', () => {
  const before = Date.now();
  const now = systemClock.now();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
});
