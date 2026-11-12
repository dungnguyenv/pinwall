import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Writes the ids of every module that went into the build's output chunks to `outFile`, as a JSON
 * array of repo-relative paths (virtual ids, which start with "\0", are kept as they are). The
 * license check (tools/src/licenses.ts) reads it to learn which packages ship in the SPA. Nothing
 * is written for a build that does not write (`write: false`), and the file is not under `dist/`,
 * which the server serves.
 */
export function bundledModules(options: { repoRoot: string; outFile: string }): Plugin {
  return {
    name: 'pinwall-bundled-modules',
    apply: 'build',
    async generateBundle(_options, bundle, isWrite) {
      if (!isWrite) return;
      const ids = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of output.moduleIds) {
          ids.add(isAbsolute(id) ? relative(options.repoRoot, id) : id);
        }
      }
      await mkdir(dirname(options.outFile), { recursive: true });
      await writeFile(options.outFile, `${JSON.stringify([...ids].sort(), null, 2)}\n`);
    },
  };
}
