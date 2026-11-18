import type { Db } from '../auth/passkeys.ts';
import type { VersionRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { type AppError, conflict } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { flatten } from '../mcp/format.ts';
import type { Scope } from './spaces.ts';
import { filesAt } from './version-files.ts';
import { checkTarget, type PublishTarget } from './versions.ts';

/** A refusal names this many paths at most, then says how many more there are. */
const PATHS_NAMED_MAX = 20;

/**
 * The paths `edit_artifact` replaced in, wrote or deleted to make the version whose `meta` JSON
 * this is: `[]` when it has none, when the JSON is invalid or when `server_edits` is not a list
 * (anything in it that is not a string is left out).
 */
export function serverEditsOf(meta: string): string[] {
  try {
    const parsed: unknown = JSON.parse(meta);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const edits = (parsed as { server_edits?: unknown }).server_edits;
    return Array.isArray(edits)
      ? edits.filter((path): path is string => typeof path === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * What was done on the server since the last full publish, as seen from `version`: it follows
 * `parent_version_id` from `version` back while each version carries `server_edits`, and stops
 * at the first one that does not (a full publish, or a restore of one).
 * - `paths`: the union of every edited path, once each, sorted.
 * - `versionNumbers`: the versions that carry edits, `version` first.
 * - `baseNumber`: the number of the version that stops the chain, which is `version` itself when
 *   it has no edits; null when the chain breaks at a version that was deleted.
 */
export async function serverEditsSince(
  db: Db,
  version: VersionRow,
): Promise<{ paths: string[]; versionNumbers: number[]; baseNumber: number | null }> {
  const paths = new Set<string>();
  const versionNumbers: number[] = [];
  let at: VersionRow | undefined = version;
  while (at !== undefined) {
    const edits = serverEditsOf(at.meta);
    if (edits.length === 0) return { paths: sorted(paths), versionNumbers, baseNumber: at.number };
    for (const path of edits) paths.add(path);
    versionNumbers.push(at.number);
    at = await parentOf(db, at);
  }
  return { paths: sorted(paths), versionNumbers, baseNumber: null };
}

const sorted = (paths: Iterable<string>): string[] => [...paths].sort();

/** The version with this id; undefined when there is none (it was deleted). */
function versionById(db: Db, id: string): Promise<VersionRow | undefined> {
  return db.selectFrom('versions').selectAll().where('id', '=', id).executeTakeFirst();
}

/** The version `version` was made on top of; undefined when it has none or it was deleted. */
async function parentOf(db: Db, version: VersionRow): Promise<VersionRow | undefined> {
  const id = version.parent_version_id;
  return id === null ? undefined : versionById(db, id);
}

/**
 * Refuses a publish of full files on top of a version made with `edit_artifact`, which a stale
 * copy of the files would undo without a trace: 409 `conflict` with
 * `details.reason: 'edited_on_server'`, the first 20 paths edited since the last full publish
 * (`paths`, and `more` for the rest), the versions that edited them (`versions`, newest first)
 * and the version they stop at (`base_version_number`). It does nothing for a new artifact, for
 * `replace` (the publisher means to discard the edits), or when the version the publish
 * replaces carries none.
 *
 * `checkTarget` comes first, so the paths are told only to a caller who sees the artifact and may
 * publish to it, and a stale `expectedVersionId` is a `version_conflict`, whatever the edits.
 */
export async function assertNoServerEdits(
  deps: AppDeps,
  scope: Scope,
  target: PublishTarget,
  replace: boolean,
): Promise<void> {
  if (target.kind === 'new_artifact' || replace) return;
  await checkTarget(deps, scope, target);
  const { db } = deps.db;
  // Settled by `checkTarget`: the expected version is the artifact's current one, so it exists.
  const version = await versionById(db, target.expectedVersionId);
  if (version === undefined) return;
  const { paths, versionNumbers, baseNumber } = await serverEditsSince(db, version);
  if (paths.length === 0) return;
  throw editedOnServer(paths, versionNumbers, baseNumber);
}

/**
 * Refuses the `write` operations of an `edit_artifact` call on top of `version` that would
 * replace whole files edited on the server since the last full publish, as a publish of those
 * files would (R25): the 409 `assertNoServerEdits` gives, naming only those files, in `written`.
 * A write to a path `version` does not have makes a new file, and `replace` and `delete` work on
 * the current text, so neither is refused. The caller has run `checkTarget` (R12).
 */
export async function assertNoWritesOverServerEdits(
  deps: AppDeps,
  version: VersionRow,
  written: readonly string[],
): Promise<void> {
  if (written.length === 0) return;
  const { paths, versionNumbers, baseNumber } = await serverEditsSince(deps.db.db, version);
  const edited = new Set(paths);
  const candidates = [...new Set(written)].filter((path) => edited.has(path));
  if (candidates.length === 0) return;
  const existing = await filesAt(deps, version, candidates);
  const overwritten = sorted(candidates.filter((path) => existing.has(path)));
  if (overwritten.length === 0) return;
  throw editedOnServer(overwritten, versionNumbers, baseNumber);
}

/**
 * The 409 `conflict` with `details.reason: 'edited_on_server'`: the first 20 of `paths` (`paths`,
 * and `more` for the rest), the versions made with edits since the last full publish (`versions`,
 * newest first) and the version they stop at (`base_version_number`).
 */
function editedOnServer(
  paths: readonly string[],
  versionNumbers: readonly number[],
  baseNumber: number | null,
): AppError {
  const named = paths.slice(0, PATHS_NAMED_MAX);
  const more = paths.length - named.length;
  // Paths are the publisher's: one line each, whatever they hold.
  const list = named.map(flatten).join(', ');
  return conflict(
    t('publish.editedOnServer', {
      versions: versionNumbers.map((n) => `v${n}`).join(', '),
      paths: more === 0 ? list : `${list} ${t('publish.editedOnServerMore', { count: more })}`,
    }),
    {
      reason: 'edited_on_server',
      paths: named,
      more,
      versions: versionNumbers,
      base_version_number: baseNumber,
    },
  );
}
