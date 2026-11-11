import { expect, test, vi } from 'vitest';
import { annotatorScript } from '../../src/content/annotator-asset.ts';

// The build output is missing: reading it fails as it would with no `dist/annotator.js`.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: () => {
    throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
  },
}));

test('run from source without the annotator built, the script names the command that builds it', () => {
  expect(() => annotatorScript()).toThrow(
    'The annotator script is not built: run `pnpm --filter @pinwall/annotator build`',
  );
});
