import { join } from 'node:path';
import { build } from 'vite';
import { expect, test } from 'vitest';

/** What the tests read of a chunk Vite built. */
interface Chunk {
  type: string;
  fileName: string;
  isEntry: boolean;
  moduleIds: string[];
}

/** Builds the app the way `pnpm build` does, in memory. */
async function buildChunks(): Promise<Chunk[]> {
  const result = (await build({
    root: join(import.meta.dirname, '..'),
    configFile: join(import.meta.dirname, '..', 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  })) as unknown as { output: Chunk[] } | { output: Chunk[] }[];
  const { output } = Array.isArray(result) ? (result[0] as { output: Chunk[] }) : result;
  return output.filter((file) => file.type === 'chunk');
}

const inPackage = (name: string) => (chunk: Chunk) =>
  chunk.moduleIds.some((id) => id.includes(`/node_modules/${name}/`));

test('react, react-dom and react-router share one vendor chunk, apart from the entry', async () => {
  const chunks = await buildChunks();
  const entry = chunks.find((chunk) => chunk.isEntry);
  expect(entry).toBeDefined();

  const vendor = chunks.filter(inPackage('react-dom'));
  expect(vendor.map((chunk) => chunk.fileName)).toEqual([
    expect.stringMatching(/^assets\/vendor-/),
  ]);
  expect(vendor.every(inPackage('react'))).toBe(true);
  expect(vendor.every(inPackage('react-router'))).toBe(true);
  // Each of them is in that chunk only, so an app change leaves it cached.
  expect(chunks.filter(inPackage('react')).map((chunk) => chunk.fileName)).toEqual(
    vendor.map((chunk) => chunk.fileName),
  );
  expect(chunks.filter(inPackage('react-router')).map((chunk) => chunk.fileName)).toEqual(
    vendor.map((chunk) => chunk.fileName),
  );
  expect(entry && inPackage('react-dom')(entry)).toBe(false);
  // Nothing of the app itself is in it.
  expect(vendor[0]?.moduleIds.some((id) => id.includes('/apps/web/src/'))).toBe(false);
}, 60_000);

test('zod is configured in the chunk that holds zod, so it runs before any schema is built', async () => {
  const chunks = await buildChunks();
  const configured = chunks.filter((chunk) =>
    chunk.moduleIds.some((id) => id.endsWith('/src/zod-config.ts')),
  );
  expect(configured).toHaveLength(1);
  expect(inPackage('zod')(configured[0] as Chunk)).toBe(true);
  // The schemas live elsewhere and load after it.
  expect(configured[0]?.moduleIds.some((id) => id.includes('/packages/shared/'))).toBe(false);
}, 60_000);
