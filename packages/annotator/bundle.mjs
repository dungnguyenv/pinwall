// Bundles the annotator (src/index.ts) into the one classic script served as
// `<grant base>/__pinwall/annotator.js`.
import { build } from 'esbuild';

const here = import.meta.dirname;

/**
 * Resolves `zod` to `zod/mini` wherever the bundle imports it: `@pinwall/shared/protocol` is
 * written with the API both share, so the annotator validates with the same schemas at a fraction
 * of the size (the full zod alone is about as large as the bundle's whole budget).
 */
const zodMini = {
  name: 'pinwall-zod-mini',
  setup(builder) {
    builder.onResolve({ filter: /^zod$/ }, (args) =>
      builder.resolve('zod/mini', {
        importer: args.importer,
        resolveDir: args.resolveDir,
        kind: args.kind,
      }),
    );
  },
};

/** The annotator as one minified IIFE (unminified with `{ minify: false }`). */
export async function bundleAnnotator({ minify = true } = {}) {
  const result = await build({
    absWorkingDir: here,
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    legalComments: 'none',
    minify,
    write: false,
    inject: ['bundle-scope.mjs'],
    plugins: [zodMini],
    logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error('esbuild produced no annotator bundle');
  return output.text;
}
