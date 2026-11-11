import { ensureAnnotatorBuilt } from './helpers/annotator-build.ts';

/** Content tests serve `__pinwall/annotator.js` from the annotator's build output: refresh it once. */
export default async function setup(): Promise<void> {
  await ensureAnnotatorBuilt();
}
