import { expect, test } from 'vitest';

test('annotator package loads', async () => {
  expect(typeof (await import('../src/index.ts'))).toBe('object');
});
