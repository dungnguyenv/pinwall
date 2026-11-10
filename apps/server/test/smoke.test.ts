import { expect, test } from 'vitest';

test('server package loads', async () => {
  expect(typeof (await import('../src/index.ts'))).toBe('object');
});
