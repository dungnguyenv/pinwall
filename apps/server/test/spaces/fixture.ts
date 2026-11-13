import type { Visibility } from '../../src/config/types.ts';
import type { AppDeps } from '../../src/deps.ts';

/** Both visibility modes, for `describe.each`: the same suite runs in each. */
export const MODES: readonly Visibility[] = ['team', 'personal'];

/** The same deps, running in `visibility`: the database and everything else stay shared. */
export function withVisibility(deps: AppDeps, visibility: Visibility): AppDeps {
  return { ...deps, config: { ...deps.config, visibility } };
}
