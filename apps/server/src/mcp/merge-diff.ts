import type { AppDeps } from '../deps.ts';
import { diffTextFile, diffVersionFiles } from '../domain/diff.ts';
import type { Scope } from '../domain/spaces.ts';
import { getVersionsById } from '../domain/versions.ts';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { dropControls, flatten } from './format.ts';

/** A merge diff, heading and every other line of it included, is this many characters at most. */
export const MERGE_DIFF_MAX_CHARS = 4_000;

/** The line separators that are not control characters, which a terminal may still break at. */
const SEPARATORS = /[\p{Zl}\p{Zp}]/gu;

/**
 * The unified diff of one file as data for the model, from `createTwoFilesPatch`: every line has
 * its control characters other than the tab dropped and its Unicode line and paragraph
 * separators made spaces, so a line of the file cannot end its diff line and pass for another
 * line of the tool text. The `Index:` line and the rule under it are left out: the `---` line
 * names the file, and 85 characters per file are a large share of a 4,000-character cap.
 */
function patchText(patch: string): string {
  const lines = patch.split('\n').map((line) => dropControls(line).replace(SEPARATORS, ' '));
  if (lines[0]?.startsWith('Index: ') && /^=+$/.test(lines[1] ?? '')) lines.splice(0, 2);
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

/**
 * What changed between two versions of an artifact, for an agent that has to merge its own
 * changes with them: the line `mcp.merge.heading`, which says it is page source and not
 * instructions, then one unified diff for each file that differs (all of them, or only those in
 * `only`), in path order, then one line `mcp.merge.none` if no file does.
 *
 * The whole text, heading and line breaks included, is at most `maxChars` (unless that is less
 * than the heading and the last line below). A file whose patch would not fit, a binary file,
 * and a file `diffTextFile` will not compare (too large) is named with `mcp.merge.notShown`
 * instead, so `read_file` can show it; the files after it are still shown if their patches fit.
 * When not even the next name fits, the text ends with one line, `mcp.merge.moreFiles`, with how
 * many files are left; room for it is kept all along. A file whose patch cannot fit, however
 * short (it has at least its two header lines), is not compared, so a large rebuild does not
 * read hundreds of files for nothing. A version or artifact that is missing, or that `scope`
 * does not see, answers as `diffVersionFiles` does.
 */
export async function mergeDiff(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  from: number,
  to: number,
  only: readonly string[] | null,
  maxChars = MERGE_DIFF_MAX_CHARS,
): Promise<string> {
  const wanted = only === null ? null : new Set(only);
  const changes = await diffVersionFiles(deps, scope, artifactId, from, to);
  const paths = changes.map((change) => change.path).filter((path) => wanted?.has(path) ?? true);
  const moreFiles = (count: number) => t('mcp.merge.moreFiles', { count });

  const heading = t('mcp.merge.heading');
  if (paths.length === 0) return [heading, t('mcp.merge.none')].join('\n');
  const lines = [heading];
  let length = heading.length;
  /** Whether a line of `size` characters fits, with room left to say how many files `following` is. */
  const fits = (size: number, following: number): boolean =>
    length + 1 + size + (following === 0 ? 0 : 1 + moreFiles(following).length) <= maxChars;

  for (const [i, path] of paths.entries()) {
    const following = paths.length - i - 1;
    let line: string | null = null;
    // Every patch has these two lines at least.
    const headers = `--- ${path}\tv${from}\n+++ ${path}\tv${to}`.length;
    if (fits(headers, following)) {
      const { patch } = await diffTextFile(deps, scope, artifactId, from, to, path);
      const shown = patch === null ? null : patchText(patch);
      if (shown !== null && fits(shown.length, following)) line = shown;
    }
    // A path is the publisher's: one line, whatever it holds.
    line ??= t('mcp.merge.notShown', { path: flatten(path) });
    if (!fits(line.length, following)) {
      // Room for this was kept when the line before was added.
      lines.push(moreFiles(paths.length - i));
      break;
    }
    lines.push(line);
    length += 1 + line.length;
  }
  return lines.join('\n');
}

/** What a writing tool was told it builds on. */
export interface StaleBaseArgs {
  artifact_id?: string | undefined;
  expected_version_id?: string | undefined;
}

/**
 * The text a refusal of a stale base ends with, for `runTool`'s `appendix`, so the agent can
 * merge without another call:
 * - `version_conflict`: every file that changed between the version the caller expected and the
 *   current one;
 * - `conflict` with `details.reason` `edited_on_server` and a `base_version_number`: the files
 *   `details.paths` names, between that version (the last without server edits) and the one the
 *   caller expected, which `assertNoServerEdits` found to be current.
 *
 * Anything else, and a refusal whose versions cannot be found (the expected version is not one of
 * this artifact's, or was deleted; the chain of edits broke at a deleted version), has none:
 * null. The diff is read as `scope`, so it shows only what the caller may already read.
 */
export function refusalAppendix(
  deps: AppDeps,
  scope: Scope,
  args: StaleBaseArgs,
): (err: unknown) => Promise<string | null> {
  return async (err) => {
    const { artifact_id: artifactId, expected_version_id: expectedId } = args;
    if (!(err instanceof AppError) || artifactId === undefined || expectedId === undefined) {
      return null;
    }
    const { details } = err;
    if (err.code === 'version_conflict') {
      const current = details?.current_version_number;
      if (typeof current !== 'number') return null;
      const expected = await versionNumber(deps, artifactId, expectedId);
      return expected === null ? null : mergeDiff(deps, scope, artifactId, expected, current, null);
    }
    if (err.code === 'conflict' && details?.reason === 'edited_on_server') {
      const { base_version_number: base, paths } = details;
      if (typeof base !== 'number' || !Array.isArray(paths)) return null;
      const expected = await versionNumber(deps, artifactId, expectedId);
      if (expected === null) return null;
      const edited = paths.filter((path): path is string => typeof path === 'string');
      return mergeDiff(deps, scope, artifactId, base, expected, edited);
    }
    return null;
  };
}

/** The number of the version `versionId` of the artifact; null when it is not one of its. */
async function versionNumber(
  deps: AppDeps,
  artifactId: string,
  versionId: string,
): Promise<number | null> {
  const row = (await getVersionsById(deps.db.db, [versionId])).get(versionId);
  return row?.artifact_id === artifactId ? row.number : null;
}
