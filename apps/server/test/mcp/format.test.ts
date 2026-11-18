import { expect, test } from 'vitest';
import { minutesText, urlMinutes } from '../../src/mcp/format.ts';

test('an upload or download URL lives a whole number of minutes, never more than it does, at least one', () => {
  const minutes = (uploadSessionMs: number) => urlMinutes({ ttl: { uploadSessionMs } });
  expect(minutes(10 * 60_000)).toBe(10);
  expect(minutes(150_000)).toBe(2);
  expect(minutes(30_000)).toBe(1);
});

test('a number of minutes is written in the singular for one', () => {
  expect(minutesText(1)).toBe('1 minute');
  expect(minutesText(10)).toBe('10 minutes');
});
