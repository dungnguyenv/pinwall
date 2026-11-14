import type { Transaction } from 'kysely';
import { z } from 'zod';
import type { Db } from '../auth/passkeys.ts';
import type { Config } from '../config/types.ts';
import { extractVersionText, type VersionMetadata } from '../content/metadata.ts';
import type { DbDialect } from '../db/connect.ts';
import type {
  ArtifactKind,
  ArtifactRow,
  Database,
  ProjectRow,
  UserRow,
  VersionFileRow,
  VersionRow,
  VersionSource,
} from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { AppError, badRequest, conflict, gone, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { newId } from '../lib/ids.ts';
import { inIngestSlot } from '../publish/ingest-slots.ts';
import { entryKind } from '../publish/paths.ts';
import type { StagedFile } from '../publish/stage.ts';
import { getArtifact, getTags, lockArtifact, normalizeTags } from './artifacts.ts';
import { getProject } from './projects.ts';
import { ARTIFACT_TOPIC, indexArtifact } from './search.ts';
import {
  assertCan,
  defaultProjectFor,
  holdRoleIn,
  roleIn,
  type Scope,
  scopeForUser,
  whereVisible,
} from './spaces.ts';
import { assertQuota, checkQuota, type QuotaRoom } from './usage.ts';

/** Where a publish goes: a new artifact, or a new version on top of the one the publisher saw. */
export type PublishTarget =
  | { kind: 'new_artifact'; projectId: string | null; name: string | null; tags: string[] }
  | { kind: 'new_version'; artifactId: string; expectedVersionId: string };

export interface VersionInput {
  entryPath: string;
  kind: ArtifactKind;
  /** Staged and still pinned by the caller; paths unique and normalized. */
  files: readonly StagedFile[];
  meta: VersionMetadata;
  message: string | null;
  source: VersionSource;
}

export interface CommitResult {
  artifact: ArtifactRow;
  version: VersionRow;
}

/** Where the next page of versions starts: just below number `n`. */
const VersionCursor = z.object({ n: z.number().int() });
/** Where the next page of files starts: just after `p` in path order. */
const FileCursor = z.object({ p: z.string() });

/** Artifact names are cut to this many characters (code points). */
const NAME_MAX_CHARS = 200;
/** `version_files` rows per insert statement: 2,500 parameters, well under either database's limit. */
const FILE_CHUNK = 500;

/** The 409 for a publish whose expected version is no longer the artifact's current one. */
export function versionConflict(current: { id: string; number: number }): AppError {
  return new AppError(
    'version_conflict',
    409,
    t('publish.versionConflict', { number: current.number }),
    { current_version_id: current.id, current_version_number: current.number },
  );
}

/**
 * Runs the checks of `commitVersion` without writing anything, so an upload can be refused
 * before its body is read: the tags are valid; the project or artifact exists and `scope` sees
 * it (else 404, as for a missing one); `scope` may publish to it (else 403 `reason: 'role'`, in
 * personal mode); the project is not archived, or the artifact's current version is the expected
 * one; and, for a viewer, the space it fills has room for one more version (and artifact) of at
 * least one file and of `bytes` (0 when the size is not known yet), else 413 `quota_exceeded`.
 * Returns what is left in that space, for the publish to be held to while its files arrive
 * (undefined: no limit applies). The commit checks again, against the memberships and usage of
 * its own moment.
 */
export async function checkTarget(
  deps: AppDeps,
  scope: Scope,
  target: PublishTarget,
  bytes = 0,
): Promise<QuotaRoom | undefined> {
  const { db } = deps.db;
  if (target.kind === 'new_artifact') {
    normalizeTags(target.tags);
    // Without a project, the commit finds or makes the publisher's default, never archived.
    if (target.projectId !== null) {
      const project = await getProject(db, scope, target.projectId);
      assertCan(scope, await roleIn(db, scope, project.id), 'publish');
      assertNotArchived(project);
    }
    if (scope.kind !== 'viewer') return undefined;
    return checkQuota(db, deps.config, {
      projectId: target.projectId,
      actor: scope.user,
      bytes,
      artifacts: 1,
      files: 1,
    });
  }
  const artifact = await publishableArtifact(deps, scope, target.artifactId);
  await assertCurrent(db, artifact, target.expectedVersionId);
  if (scope.kind !== 'viewer') return undefined;
  return checkQuota(db, deps.config, {
    projectId: artifact.project_id,
    actor: scope.user,
    bytes,
    artifacts: 0,
    files: 1,
  });
}

/** The artifact `id`, which `scope` must see (as `getArtifact`) and may publish to. */
async function publishableArtifact(deps: AppDeps, scope: Scope, id: string): Promise<ArtifactRow> {
  const { db } = deps.db;
  const artifact = await getArtifact(db, scope, id, deps.clock.now());
  assertCan(scope, await roleIn(db, scope, artifact.project_id), 'publish');
  return artifact;
}

/**
 * Makes the staged files a new version, in one transaction: the artifact (when new) and its
 * tags, the version, its files, the artifact's new current version, and its search entry.
 * A new version must name the artifact's current version; writers of one artifact take turns, so
 * of several publishes on top of the same version exactly one wins and the others get
 * `versionConflict`. Numbers continue from `latest_number`, so a deleted version's number is
 * never given again. Inside the transaction the actor must still see the project or artifact
 * (else 404) and may still publish to it (else 403), whatever `checkTarget` found earlier: an
 * upload URL whose publisher left the project meanwhile writes nothing. The version, its bytes
 * and files counted in full, must fit in the space it fills (`assertQuota`, else 413
 * `quota_exceeded`), checked last,
 * once the artifact or project is held. Once committed, `version.published` goes out on
 * `ARTIFACT_TOPIC`.
 */
export async function commitVersion(
  deps: AppDeps,
  actor: UserRow,
  target: PublishTarget,
  input: VersionInput,
): Promise<CommitResult> {
  const { dialect } = deps.db;
  const scope = scopeForUser(deps, actor);
  const plan: Plan =
    target.kind === 'new_artifact' ? await planNewArtifact(deps, scope, target, input) : target;
  const totalBytes = input.files.reduce((sum, file) => sum + file.size, 0);

  const result = await deps.db.db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { artifact, tags } =
      plan.kind === 'new_artifact'
        ? await insertArtifact(trx, dialect, scope, plan, actor, input.kind, now, {
            config: deps.config,
            bytes: totalBytes,
            files: input.files.length,
          })
        : await lockCurrent(trx, dialect, scope, plan.artifactId, plan.expectedVersionId, now);
    if (plan.kind === 'new_version') {
      await assertQuota(trx, dialect, deps.config, {
        projectId: artifact.project_id,
        actor,
        bytes: totalBytes,
        artifacts: 0,
        files: input.files.length,
      });
    }

    const version: VersionRow = {
      id: newId('ver'),
      artifact_id: artifact.id,
      number: artifact.latest_number + 1,
      parent_version_id: artifact.current_version_id,
      entry_path: input.entryPath,
      title: input.meta.title,
      theme_color: input.meta.themeColor,
      thumbnail_path: input.meta.thumbnailPath,
      file_count: input.files.length,
      total_bytes: totalBytes,
      message: input.message,
      source: input.source,
      restored_from_version_id: null,
      meta: JSON.stringify({ warnings: input.meta.warnings }),
      created_by: actor.id,
      created_at: now,
    };
    await trx.insertInto('versions').values(version).execute();
    for (let start = 0; start < input.files.length; start += FILE_CHUNK) {
      const rows = input.files.slice(start, start + FILE_CHUNK).map((file) => ({
        version_id: version.id,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        content_type: file.contentType,
      }));
      await trx.insertInto('version_files').values(rows).execute();
    }
    return makeCurrent(trx, dialect, artifact, version, input.kind, tags, input.meta.text, now);
  });

  deps.metrics.publishes.inc({ source: input.source });
  announce(deps, result);
  return result;
}

/**
 * Makes version `n` current again by copying it into a new version (`source` `restore`), on top
 * of `expectedVersionId` as `commitVersion` requires, and with its checks of the actor and of the
 * quota, before and again inside the transaction. The copy shares the old version's blobs but
 * counts in full toward the quota, as every version does; it takes the old version's entry,
 * title, theme color, thumbnail and warnings. It is a publish, so it runs in a place the actor
 * is given, for at most the deadline of a publish (`inIngestSlot`: 429 without a place, 408 past
 * the deadline, with nothing copied).
 */
export function restoreVersion(
  deps: AppDeps,
  actor: UserRow,
  artifactId: string,
  n: number,
  expectedVersionId: string,
): Promise<CommitResult> {
  return inIngestSlot(deps, actor, null, (deadline) =>
    copyVersion(deps, actor, artifactId, n, expectedVersionId, deadline),
  );
}

async function copyVersion(
  deps: AppDeps,
  actor: UserRow,
  artifactId: string,
  n: number,
  expectedVersionId: string,
  deadline: AbortSignal,
): Promise<CommitResult> {
  const { db, dialect } = deps.db;
  const scope = scopeForUser(deps, actor);
  // Settle what can fail cheaply before reading the old version's files for its search text;
  // that read cannot run inside the transaction (on SQLite it holds the only connection).
  const seen = await publishableArtifact(deps, scope, artifactId);
  await assertCurrent(db, seen, expectedVersionId);
  const seenOld = await getVersionByNumber(db, seen, n);
  await checkQuota(db, deps.config, {
    projectId: seen.project_id,
    actor,
    bytes: seenOld.total_bytes,
    artifacts: 0,
    files: seenOld.file_count,
  });
  const text = await extractVersionText(deps, seenOld.id);
  deadline.throwIfAborted();

  const result = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { artifact, tags } = await lockCurrent(
      trx,
      dialect,
      scope,
      artifactId,
      expectedVersionId,
      now,
    );
    // Deleted since it was read: 410.
    const old = await getVersionByNumber(trx, artifact, n);
    await assertQuota(trx, dialect, deps.config, {
      projectId: artifact.project_id,
      actor,
      bytes: old.total_bytes,
      artifacts: 0,
      files: old.file_count,
    });
    const version: VersionRow = {
      id: newId('ver'),
      artifact_id: artifact.id,
      number: artifact.latest_number + 1,
      parent_version_id: artifact.current_version_id,
      entry_path: old.entry_path,
      title: old.title,
      theme_color: old.theme_color,
      thumbnail_path: old.thumbnail_path,
      file_count: old.file_count,
      total_bytes: old.total_bytes,
      message: t('version.restoredFrom', { number: old.number }),
      source: 'restore',
      restored_from_version_id: old.id,
      meta: old.meta,
      created_by: actor.id,
      created_at: now,
    };
    await trx.insertInto('versions').values(version).execute();
    await trx
      .insertInto('version_files')
      .columns(['version_id', 'path', 'sha256', 'size', 'content_type'])
      .expression((eb) =>
        eb
          .selectFrom('version_files')
          .select([
            eb.cast<string>(eb.val(version.id), 'text').as('version_id'),
            'path',
            'sha256',
            'size',
            'content_type',
          ])
          .where('version_id', '=', old.id),
      )
      .execute();
    const kind = entryKind(old.entry_path);
    return makeCurrent(trx, dialect, artifact, version, kind, tags, text, now);
  });

  deps.metrics.publishes.inc({ source: 'restore' });
  announce(deps, result);
  return result;
}

/**
 * Version `n` of `artifact`. A missing one answers 410 when its number was given out (it was
 * deleted), else 404. Pass the transaction when one is open.
 */
export async function getVersionByNumber(
  db: Db,
  artifact: ArtifactRow,
  n: number,
): Promise<VersionRow> {
  const issued = Number.isSafeInteger(n) && n >= 1 && n <= artifact.latest_number;
  const version = issued
    ? await db
        .selectFrom('versions')
        .selectAll()
        .where('artifact_id', '=', artifact.id)
        .where('number', '=', n)
        .executeTakeFirst()
    : undefined;
  if (version !== undefined) return version;
  throw issued ? gone(t('version.gone')) : notFound(t('version.notFound'));
}

/**
 * The current version of `artifact`. Every artifact has one; a read that raced the artifact's
 * deletion finds none and answers 410, as the artifact would a moment later.
 */
export async function getCurrentVersion(db: Db, artifact: ArtifactRow): Promise<VersionRow> {
  const id = artifact.current_version_id;
  const version =
    id === null
      ? undefined
      : await db.selectFrom('versions').selectAll().where('id', '=', id).executeTakeFirst();
  if (version === undefined) throw gone(t('artifact.gone'));
  return version;
}

/** Version `versionId` of `artifact`; 400 when the artifact has no such version. */
export async function versionOf(
  db: Db,
  artifact: ArtifactRow,
  versionId: string,
): Promise<VersionRow> {
  const version = await db
    .selectFrom('versions')
    .selectAll()
    .where('id', '=', versionId)
    .where('artifact_id', '=', artifact.id)
    .executeTakeFirst();
  if (version === undefined) throw badRequest(t('version.notInArtifact'), { field: 'version_id' });
  return version;
}

/** The new artifact's name: the given one, else the title, else the entry's file name. */
function artifactName(given: string | null, meta: VersionMetadata, entryPath: string): string {
  const basename = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const name =
    [given, meta.title, stem].map((c) => c?.trim() ?? '').find((c) => c !== '') ??
    t('artifact.untitled');
  return firstCodePoints(name, NAME_MAX_CHARS);
}

function firstCodePoints(text: string, max: number): string {
  let count = 0;
  let end = 0;
  for (const char of text) {
    if (count === max) return text.slice(0, end);
    count += 1;
    end += char.length;
  }
  return text;
}

/** What a commit writes into: a new artifact, its settings settled up front, or an existing one. */
type Plan =
  | { kind: 'new_artifact'; projectId: string; name: string; tags: string[] }
  | Extract<PublishTarget, { kind: 'new_version' }>;

/**
 * A new artifact's settings. Without a project it goes to the publisher's default project
 * (`defaultProjectFor`: their own in personal mode, the shared one in team mode), made when
 * missing.
 */
async function planNewArtifact(
  deps: AppDeps,
  scope: Scope,
  target: Extract<PublishTarget, { kind: 'new_artifact' }>,
  input: VersionInput,
): Promise<Plan> {
  const tags = normalizeTags(target.tags);
  // Outside the transaction: it writes through the outer handle.
  const projectId = target.projectId ?? (await defaultProjectFor(deps, scope)).id;
  const name = artifactName(target.name, input.meta, input.entryPath);
  return { kind: 'new_artifact', projectId, name, tags };
}

/**
 * Inserts the artifact, without a version yet, and its tags. Its project must exist, `scope`
 * must see it (else 404, as for a missing one) and may publish to it (else 403), it must not
 * be archived, and the space it fills must have room for it and for its first version of
 * `quota.bytes` and `quota.files` (else 413); on Postgres the project row stays share-locked until the commit, so
 * archiving the project waits for a publish that has already checked it.
 */
async function insertArtifact(
  trx: Transaction<Database>,
  dialect: DbDialect,
  scope: Scope,
  plan: Extract<Plan, { kind: 'new_artifact' }>,
  actor: UserRow,
  kind: ArtifactKind,
  now: number,
  quota: { config: Config; bytes: number; files: number },
): Promise<{ artifact: ArtifactRow; tags: string[] }> {
  const project = await whereVisible(
    trx.selectFrom('projects').selectAll().where('id', '=', plan.projectId),
    scope,
    'projects.id',
  )
    .$if(dialect === 'postgres', (qb) => qb.forShare())
    .executeTakeFirst();
  if (project === undefined) throw notFound(t('project.notFound'));
  // The role in a statement after the hold: the one above saw the memberships of before any wait.
  assertCan(scope, await holdRoleIn(trx, dialect, scope, project.id), 'publish');
  assertNotArchived(project);
  await assertQuota(trx, dialect, quota.config, {
    projectId: project.id,
    actor,
    bytes: quota.bytes,
    artifacts: 1,
    files: quota.files,
  });

  const artifact: ArtifactRow = {
    id: newId('art'),
    project_id: project.id,
    name: plan.name,
    kind,
    current_version_id: null,
    latest_number: 0,
    created_by: actor.id,
    created_at: now,
    updated_at: now,
  };
  await trx.insertInto('artifacts').values(artifact).execute();
  if (plan.tags.length > 0) {
    await trx
      .insertInto('artifact_tags')
      .values(plan.tags.map((tag) => ({ artifact_id: artifact.id, tag })))
      .execute();
  }
  return { artifact, tags: plan.tags };
}

function assertNotArchived(project: ProjectRow): void {
  if (project.archived_at !== null) throw conflict(t('project.archived'));
}

/**
 * Locks the artifact, which `scope` must see and may publish to, checks that `expectedVersionId`
 * is still its current version, and reads its tags.
 */
async function lockCurrent(
  trx: Transaction<Database>,
  dialect: DbDialect,
  scope: Scope,
  artifactId: string,
  expectedVersionId: string,
  now: number,
): Promise<{ artifact: ArtifactRow; tags: string[] }> {
  const artifact =
    (await lockArtifact(trx, dialect, scope, artifactId)) ??
    (await getArtifact(trx, scope, artifactId, now));
  assertCan(scope, await holdRoleIn(trx, dialect, scope, artifact.project_id), 'publish');
  await assertCurrent(trx, artifact, expectedVersionId);
  return { artifact, tags: await getTags(trx, artifact.id) };
}

async function assertCurrent(
  db: Db,
  artifact: ArtifactRow,
  expectedVersionId: string,
): Promise<void> {
  if (artifact.current_version_id === expectedVersionId) return;
  const currentId = artifact.current_version_id;
  const current =
    currentId === null
      ? undefined
      : await db
          .selectFrom('versions')
          .select(['id', 'number'])
          .where('id', '=', currentId)
          .executeTakeFirst();
  // Versions and their artifact change together, so this means the data was edited by hand.
  if (current === undefined) {
    throw new Error(`artifact ${artifact.id} has no current version row (${currentId})`);
  }
  throw versionConflict(current);
}

/** The last steps of every commit: the artifact points at `version`, and search follows. */
async function makeCurrent(
  trx: Transaction<Database>,
  dialect: DbDialect,
  artifact: ArtifactRow,
  version: VersionRow,
  kind: ArtifactKind,
  tags: readonly string[],
  text: string,
  now: number,
): Promise<CommitResult> {
  const change = {
    current_version_id: version.id,
    latest_number: version.number,
    kind,
    updated_at: now,
  };
  await trx.updateTable('artifacts').set(change).where('id', '=', artifact.id).execute();
  const updated: ArtifactRow = { ...artifact, ...change };
  await indexArtifact({ db: trx, dialect }, updated, tags, text);
  return { artifact: updated, version };
}

function announce(deps: AppDeps, { artifact, version }: CommitResult): void {
  deps.events.publish(ARTIFACT_TOPIC(artifact.id), {
    type: 'version.published',
    artifact_id: artifact.id,
    version_id: version.id,
    number: version.number,
  });
}

/**
 * One page of the artifact's versions, the newest first, and which of them is current. A missing
 * artifact, or one `scope` does not see, answers as `getArtifact` does (404, or 410 when deleted).
 */
export async function listVersions(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
  p: { limit: number; cursor: string | null },
): Promise<{ items: VersionRow[]; nextCursor: string | null; currentVersionId: string | null }> {
  const { db } = deps.db;
  const artifact = await getArtifact(db, scope, artifactId, deps.clock.now());
  let query = db.selectFrom('versions').selectAll().where('artifact_id', '=', artifact.id);
  if (p.cursor !== null)
    query = query.where('number', '<', decodeCursor(p.cursor, VersionCursor).n);
  const rows = await query
    .orderBy('number', 'desc')
    .limit(p.limit + 1)
    .execute();
  const items = rows.slice(0, p.limit);
  const last = items.at(-1);
  const nextCursor = rows.length > p.limit && last ? encodeCursor({ n: last.number }) : null;
  return { items, nextCursor, currentVersionId: artifact.current_version_id };
}

/** One page of a version's files, in path order. */
export async function listVersionFiles(
  deps: AppDeps,
  versionId: string,
  p: { limit: number; cursor: string | null },
): Promise<{ items: VersionFileRow[]; nextCursor: string | null }> {
  let query = deps.db.db
    .selectFrom('version_files')
    .selectAll()
    .where('version_id', '=', versionId);
  if (p.cursor !== null) query = query.where('path', '>', decodeCursor(p.cursor, FileCursor).p);
  const rows = await query
    .orderBy('path', 'asc')
    .limit(p.limit + 1)
    .execute();
  const items = rows.slice(0, p.limit);
  const last = items.at(-1);
  const nextCursor = rows.length > p.limit && last ? encodeCursor({ p: last.path }) : null;
  return { items, nextCursor };
}

/** The versions with the given ids, by id, in one query. */
export async function getVersionsById(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, VersionRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db.selectFrom('versions').selectAll().where('id', 'in', ids).execute();
  return new Map(rows.map((row) => [row.id, row]));
}
