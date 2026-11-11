// Writes the annotator bundle to dist/annotator.js.
import { mkdir, writeFile } from 'node:fs/promises';
import { bundleAnnotator } from './bundle.mjs';

const dist = new URL('./dist/', import.meta.url);
await mkdir(dist, { recursive: true });
await writeFile(new URL('annotator.js', dist), await bundleAnnotator());
