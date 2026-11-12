import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PINWALL_VERSION } from '../src/version.ts';

test('PINWALL_VERSION is the version of the root package.json', () => {
  const root = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  expect(PINWALL_VERSION).toBe(root.version);
});
