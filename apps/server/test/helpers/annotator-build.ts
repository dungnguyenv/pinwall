import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { bundleAnnotator } from '@pinwall/annotator/bundle';

/** The annotator's build output, which `annotatorScript()` reads when not run from the bundle. */
const BUILT = join(
  dirname(createRequire(import.meta.url).resolve('@pinwall/annotator/bundle')),
  'dist',
  'annotator.js',
);

/**
 * Bundles the annotator from its current sources into `packages/annotator/dist/annotator.js`, as
 * `pnpm --filter @pinwall/annotator build` does. The file is replaced in one rename, so a reader
 * running at the same time sees the old bundle or the new one, never part of one.
 */
export async function ensureAnnotatorBuilt(): Promise<void> {
  const code = await bundleAnnotator();
  await mkdir(dirname(BUILT), { recursive: true });
  const partial = `${BUILT}.${process.pid}.tmp`;
  await writeFile(partial, code);
  await rename(partial, BUILT);
}
