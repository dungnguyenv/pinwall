// Bundles the server into one file: src/main.ts -> dist/main.mjs.
//
// Everything is inlined (the workspace package @pinwall/shared, its en.json, the pages
// stylesheet, and the annotator script, bundled here from packages/annotator's sources) except
// the native database driver, which has to be installed beside the bundle, and pg's optional
// pg-native binding, which Pinwall never uses.
import { bundleAnnotator } from '@pinwall/annotator/bundle';
import { build } from 'esbuild';

const here = import.meta.dirname;

await build({
  absWorkingDir: here,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['better-sqlite3', 'pg-native'],
  // The body of `__pinwall/annotator.js` (see src/content/annotator-asset.ts).
  define: { __PINWALL_ANNOTATOR_JS__: JSON.stringify(await bundleAnnotator()) },
  // Bundled CommonJS packages call require() for Node built-ins, which an ES module lacks.
  banner: {
    js: "import { createRequire as __pinwallCreateRequire } from 'node:module';\nconst require = __pinwallCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
