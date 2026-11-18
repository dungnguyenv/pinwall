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

/** A file's patch as `patchText` leaves it: the `---`/`+++` lines, then each hunk whole. */
interface SplitPatch {
  headers: string;
  hunks: string[];
}

/**
 * Splits a patch into its header lines and its hunks. A hunk starts with a line that starts with
 * `@@ `; no other line of a patch can, as a line of the file is shown after a space, `+` or `-`.
 */
function splitPatch(patch: string): SplitPatch {
  const lines = patch.split('\n');
  const first = lines.findIndex((line) => line.startsWith('@@ '));
  if (first < 0) return { headers: patch, hunks: [] };
  const hunks: string[][] = [];
  for (const line of lines.slice(first)) {
    if (line.startsWith('@@ ')) hunks.push([line]);
    else hunks.at(-1)?.push(line);
  }
  return { headers: lines.slice(0, first).join('\n'), hunks: hunks.map((hunk) => hunk.join('\n')) };
}

/**
 * The most of a patch that fits, when the whole of it does not: its header lines, as many of its
 * hunks as fit from the first on (each whole, in order), and the line `mcp.merge.moreHunks` with
 * how many are left out. `fits` says whether a text of a given size can still be added. Null when
 * not even the headers, the first hunk and that line fit.
 */
function partialPatch(
  path: string,
  { headers, hunks }: SplitPatch,
  fits: (size: number) => boolean,
): string | null {
  let best = 0;
  let size = headers.length;
  for (let shown = 1; shown < hunks.length; shown += 1) {
    size += 1 + (hunks[shown - 1]?.length ?? 0);
    const more = t('mcp.merge.moreHunks', { path, count: hunks.length - shown });
    if (fits(size + 1 + more.length)) best = shown;
    // Hunks only add: when these alone do not fit, no more of them will.
    else if (!fits(size)) break;
  }
  if (best === 0) return null;
  const more = t('mcp.merge.moreHunks', { path, count: hunks.length - best });
  return [headers, ...hunks.slice(0, best), more].join('\n');
}

/**
 * What changed between two versions of an artifact, for an agent that has to merge its own
 * changes with them: the line `mcp.merge.heading`, which says it is page source and not
 * instructions, then one unified diff for each file that differs (all of them, or only those in
 * `only`), in path order, then one line `mcp.merge.none` if no file does.
 *
 * The whole text, heading and line breaks included, is at most `maxChars` (unless that is less
 * than the heading and the last line below). A file is shown in the most of these ways that fits:
 * - its whole patch;
 * - its header lines, as many of its hunks as fit (whole, in order) and `mcp.merge.moreHunks`
 *   with how many are left out;
 * - its name with `mcp.merge.notShown`, so `read_file` can show it: for a binary file, a file
 *   `diffTextFile` will not compare (too large), one it fails to compare (logged with
 *   `requestId`), and one for which the first two do not fit.
 *
 * The files after a short one are still shown if they fit. When not even the next name fits, the
 * text ends with one line, `mcp.merge.moreFiles`, with how many files are left; room for it is
 * kept all along. Those files are not compared, so a large rebuild does not read hundreds of
 * files for nothing. A version or artifact that is missing, or that `scope` does not see,
 * answers as `diffVersionFiles` does.
 */
export async function mergeDiff(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  from: number,
  to: number,
  only: readonly string[] | null,
  maxChars = MERGE_DIFF_MAX_CHARS,
  requestId?: string,
): Promise<string> {
  const wanted = only === null ? null : new Set(only);
  const changes = await diffVersionFiles(deps, scope, artifactId, from, to);
  const paths = changes.map((change) => change.path).filter((path) => wanted?.has(path) ?? true);
  const moreFiles = (count: number) => t('mcp.merge.moreFiles', { count });

  const heading = t('mcp.merge.heading');
  if (paths.length === 0) return [heading, t('mcp.merge.none')].join('\n');
  const lines = [heading];
  let length = heading.length;

  for (const [i, path] of paths.entries()) {
    const following = paths.length - i - 1;
    /** Whether a line of `size` characters fits, with room left to say how many files follow. */
    const fits = (size: number): boolean =>
      length + 1 + size + (following === 0 ? 0 : 1 + moreFiles(following).length) <= maxChars;

    // A path is the publisher's: one line, whatever it holds.
    const shownPath = flatten(path);
    const name = t('mcp.merge.notShown', { path: shownPath });
    if (!fits(name.length)) {
      // The name is what a file falls back to: without room for it, this file and the rest are
      // counted, not compared. Room for the count was kept when the line before was added.
      lines.push(moreFiles(paths.length - i));
      break;
    }
    const patch = await compare(deps, scope, artifactId, from, to, path, requestId);
    let line = name;
    if (patch !== null) {
      const text = patchText(patch);
      line = (fits(text.length) ? text : partialPatch(shownPath, splitPatch(text), fits)) ?? name;
    }
    lines.push(line);
    length += 1 + line.length;
  }
  return lines.join('\n');
}

/**
 * The patch of one file, or null when there is none to show: the file is binary or too large to
 * compare, or the comparison failed, which is logged and does not lose the rest of the diff.
 */
async function compare(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  from: number,
  to: number,
  path: string,
  requestId: string | undefined,
): Promise<string | null> {
  try {
    return (await diffTextFile(deps, scope, artifactId, from, to, path)).patch;
  } catch (err) {
    deps.logger.error(
      { err, request_id: requestId, path },
      'MCP merge diff could not compare a file',
    );
    return null;
  }
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
 * `requestId` is the request's, for the log when a file cannot be compared. Anything else, and a
 * refusal whose versions cannot be found (the expected version is not one of
 * this artifact's, or was deleted; the chain of edits broke at a deleted version), has none:
 * null. The diff is read as `scope`, so it shows only what the caller may already read.
 */
export function refusalAppendix(
  deps: AppDeps,
  scope: Scope,
  args: StaleBaseArgs,
  requestId?: string,
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
      return expected === null
        ? null
        : mergeDiff(deps, scope, artifactId, expected, current, null, undefined, requestId);
    }
    if (err.code === 'conflict' && details?.reason === 'edited_on_server') {
      const { base_version_number: base, paths } = details;
      if (typeof base !== 'number' || !Array.isArray(paths)) return null;
      const expected = await versionNumber(deps, artifactId, expectedId);
      if (expected === null) return null;
      const edited = paths.filter((path): path is string => typeof path === 'string');
      return mergeDiff(deps, scope, artifactId, base, expected, edited, undefined, requestId);
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
