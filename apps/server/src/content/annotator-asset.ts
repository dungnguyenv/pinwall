import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ReservedAsset } from './hooks.ts';

/**
 * The annotator bundle as text: `build.mjs` defines it when it bundles the server, so the
 * shipped server never reads `packages/annotator`. Undefined when run from source.
 */
declare const __PINWALL_ANNOTATOR_JS__: string | undefined;

let script: Buffer | undefined;

/**
 * The body of `__pinwall/annotator.js`, made once: the bundle built into the server, else (run
 * from source: tests, `tsx`) `@pinwall/annotator`'s build output.
 */
export function annotatorScript(): Buffer {
  script ??=
    typeof __PINWALL_ANNOTATOR_JS__ === 'string'
      ? Buffer.from(__PINWALL_ANNOTATOR_JS__)
      : readBuiltAnnotator();
  return script;
}

function readBuiltAnnotator(): Buffer {
  try {
    return readFileSync(
      createRequire(import.meta.url).resolve('@pinwall/annotator/dist/annotator.js'),
    );
  } catch (cause) {
    throw new Error(
      'The annotator script is not built: run `pnpm --filter @pinwall/annotator build`',
      { cause },
    );
  }
}

/** `<grant base>/__pinwall/annotator.js`, served in every grant. */
export const annotatorAsset: ReservedAsset = {
  contentType: 'text/javascript; charset=utf-8',
  body: annotatorScript,
};
