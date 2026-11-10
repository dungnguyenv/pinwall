// Bundles the server into one file: src/main.ts -> dist/main.mjs.
//
// Everything is inlined (the workspace package @pinwall/shared, its en.json, the pages
// stylesheet) except the native database driver, which has to be installed beside the bundle,
// and pg's optional pg-native binding, which Pinwall never uses.
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
  // Bundled CommonJS packages call require() for Node built-ins, which an ES module lacks.
  banner: {
    js: "import { createRequire as __pinwallCreateRequire } from 'node:module';\nconst require = __pinwallCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});
