import { expect, test } from 'vitest';
import { formatBytes, formatDate, formatRelativeTime } from './format.ts';

test.each([
  [0, '0 bytes'],
  [1, '1 byte'],
  [999, '999 bytes'],
  [1_000, '1 kB'],
  [1_500_000, '1.5 MB'],
  [95_000_000, '95 MB'],
  [999_960, '1 MB'],
  [2_000_000_000, '2 GB'],
  [3_200_000_000_000, '3.2 TB'],
])('formatBytes(%j) = %j', (n, out) => expect(formatBytes(n)).toBe(out));

test('relative times read naturally', () => {
  const now = Date.UTC(2026, 10, 11, 12);
  expect(formatRelativeTime(now - 7_200_000, now)).toBe('2 hours ago');
  expect(formatRelativeTime(now - 20_000, now)).toBe('now');
  expect(formatRelativeTime(now + 5_000, now)).toBe('now');
  expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
  expect(formatRelativeTime(now - 26 * 3_600_000, now)).toBe('yesterday');
  expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3 days ago');
  expect(formatRelativeTime(now - 14 * 86_400_000, now)).toBe('2 weeks ago');
  expect(formatRelativeTime(now - 23.6 * 3_600_000, now)).toBe('yesterday');
  expect(formatRelativeTime(now - 90 * 86_400_000, now)).toBe('3 months ago');
  expect(formatRelativeTime(now - 800 * 86_400_000, now)).toBe('2 years ago');
});

test('dates use the medium English style', () => {
  expect(formatDate(Date.UTC(2026, 10, 10, 12))).toBe('Nov 10, 2026');
});
