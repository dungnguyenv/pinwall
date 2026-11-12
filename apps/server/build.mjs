// Bundles the server into one file: src/main.ts -> dist/main.mjs.
//
// Everything is inlined (the workspace package @pinwall/shared, its en.json, the pages
// stylesheet, and the annotator script, bundled here from packages/annotator's sources) except
// the native database driver, which has to be installed beside the bundle, and pg's optional
// pg-native binding, which Pinwall never uses.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { bundleAnnotatorWithInputs } from '@pinwall/annotator/bundle';
import { build } from 'esbuild';

const here = import.meta.dirname;
const repoRoot = join(here, '../..');
/** The release version is the root package.json's (see src/version.ts). */
const { version } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const annotator = await bundleAnnotatorWithInputs();

const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['better-sqlite3', 'pg-native'],
  define: {
    // The body of `__pinwall/annotator.js` (see src/content/annotator-asset.ts).
    __PINWALL_ANNOTATOR_JS__: JSON.stringify(annotator.code),
    __PINWALL_VERSION__: JSON.stringify(version),
  },
  // Bundled CommonJS packages call require() for Node built-ins, which an ES module lacks.
  banner: {
    js: "import { createRequire as __pinwallCreateRequire } from 'node:module';\nconst require = __pinwallCreateRequire(import.meta.url);",
  },
  metafile: true,
  logLevel: 'info',
});

// Which files went into the server bundle and the annotator script, as repo-relative paths: the
// license check (tools/src/licenses.ts) reads them to learn which packages ship. Not under dist/.
const repoRelative = (absolutePaths) =>
  [...new Set(absolutePaths.map((path) => relative(repoRoot, path)))].sort();
const inputs = {
  server: repoRelative(Object.keys(metafile.inputs).map((input) => resolve(here, input))),
  annotator: repoRelative(annotator.inputs),
};
await mkdir(join(here, '.build'), { recursive: true });
await writeFile(join(here, '.build/bundles.json'), `${JSON.stringify(inputs, null, 2)}\n`);
