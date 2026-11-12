/**
 * The annotator bundled by esbuild into one IIFE script, the body of `__pinwall/annotator.js`:
 * minified unless `minify` is false.
 */
export function bundleAnnotator(options?: { minify?: boolean }): Promise<string>;

/**
 * The minified annotator with every file esbuild read to build it (absolute paths), for the
 * license check.
 */
export function bundleAnnotatorWithInputs(): Promise<{ code: string; inputs: string[] }>;
