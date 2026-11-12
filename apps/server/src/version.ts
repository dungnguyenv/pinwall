import { readFileSync } from 'node:fs';

/**
 * The root `package.json` version: `build.mjs` defines it when it bundles the server, so the
 * shipped server never reads the repository. Undefined when run from source.
 */
declare const __PINWALL_VERSION__: string | undefined;

/** This Pinwall's version (SemVer), as the root `package.json` gives it. */
export const PINWALL_VERSION: string =
  typeof __PINWALL_VERSION__ === 'string' ? __PINWALL_VERSION__ : readRootVersion();

/** Run from source (tests, `tsx`): the repository's root `package.json`. */
function readRootVersion(): string {
  const root: unknown = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  const version = (root as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error('The root package.json has no version');
  return version;
}
