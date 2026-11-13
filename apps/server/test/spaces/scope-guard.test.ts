import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * The only places that may act without a viewer (the roadmap's Global Constraints): each is bound
 * to something else that grants access, such as a share link, or serves the whole instance. A
 * path ending in `/` stands for every file under it. M12 adds its transfer, purge and admin files.
 */
const SYSTEM_SCOPE_ALLOWED = [
  'domain/spaces.ts',
  'domain/share-access.ts',
  'domain/comments.ts',
  'api/share-public.ts',
  'domain/search.ts',
  'domain/deletion.ts',
  'domain/blobs.ts',
  'ops/backup/',
  'domain/spaces-startup.ts',
  'publish/startup.ts',
];

const allowed = (path: string) =>
  SYSTEM_SCOPE_ALLOWED.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );

/** Every source file of the server, by its path under `src/` with `/` separators. */
async function sources(): Promise<{ path: string; text: string }[]> {
  const paths = (await readdir(SRC, { recursive: true }))
    .filter((path) => /\.tsx?$/.test(path))
    .sort();
  return Promise.all(
    paths.map(async (path) => ({
      path: path.split(sep).join('/'),
      text: await readFile(join(SRC, path), 'utf8'),
    })),
  );
}

test('only the allow-list imports SYSTEM_SCOPE', async () => {
  const users = (await sources())
    .filter((file) => /\bSYSTEM_SCOPE\b/.test(file.text))
    .map((file) => file.path);
  // The guard reads the right tree: the scope's own module names it.
  expect(users).toContain('domain/spaces.ts');
  expect(users.filter((path) => !allowed(path))).toEqual([]);
});

test('nobody but spaces.ts builds a scope by hand', async () => {
  const builders = (await sources())
    .filter((file) => /kind:\s*'(system|viewer)'/.test(file.text))
    .map((file) => file.path);
  expect(builders).toEqual(['domain/spaces.ts']);
});
