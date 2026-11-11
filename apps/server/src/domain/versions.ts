import type { Transaction } from 'kysely';
import type { Db } from '../auth/passkeys.ts';
import { extractVersionText, type VersionMetadata } from '../content/metadata.ts';
import type { DbDialect } from '../db/connect.ts';
import type {
  ArtifactKind,
  ArtifactRow,
  Database,
  ProjectRow,
  UserRow,
  VersionRow,
  VersionSource,
} from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, conflict, gone, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { newId } from '../lib/ids.ts';
import { entryKind } from '../publish/paths.ts';
import type { StagedFile } from '../publish/stage.ts';
import { getArtifact, getTags, lockArtifact, normalizeTags } from './artifacts.ts';
import { DEFAULT_PROJECT_ID, ensureDefaultProject, getProject } from './projects.ts';
import { ARTIFACT_TOPIC, indexArtifact } from './search.ts';

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
 * before its body is read: the project exists and is not archived, the tags are valid, the
 * artifact exists and its current version is the expected one. The commit checks again.
 */
export async function checkTarget(deps: AppDeps, target: PublishTarget): Promise<void> {
  const { db } = deps.db;
  if (target.kind === 'new_artifact') {
    normalizeTags(target.tags);
    const projectId = target.projectId ?? DEFAULT_PROJECT_ID;
    // The commit creates the default project when it is missing, and it is never archived.
    if (projectId !== DEFAULT_PROJECT_ID) assertNotArchived(await getProject(db, projectId));
    return;
  }
  const artifact = await getArtifact(db, target.artifactId, deps.clock.now());
  await assertCurrent(db, artifact, target.expectedVersionId);
}

/**
 * Makes the staged files a new version, in one transaction: the artifact (when new) and its
 * tags, the version, its files, the artifact's new current version, and its search entry.
 * A new version must name the artifact's current version; writers of one artifact take turns, so
 * of several publishes on top of the same version exactly one wins and the others get
 * `versionConflict`. Numbers continue from `latest_number`, so a deleted version's number is
 * never given again. Once committed, `version.published` goes out on `ARTIFACT_TOPIC`.
 */
export async function commitVersion(
  deps: AppDeps,
  actor: UserRow,
  target: PublishTarget,
  input: VersionInput,
): Promise<CommitResult> {
  const { dialect } = deps.db;
  const plan: Plan =
    target.kind === 'new_artifact' ? await planNewArtifact(deps, target, input) : target;

  const result = await deps.db.db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { artifact, tags } =
      plan.kind === 'new_artifact'
        ? await insertArtifact(trx, dialect, plan, actor, input.kind, now)
        : await lockCurrent(trx, dialect, plan.artifactId, plan.expectedVersionId, now);

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
      total_bytes: input.files.reduce((sum, file) => sum + file.size, 0),
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

  announce(deps, result);
  return result;
}

/**
 * Makes version `n` current again by copying it into a new version (`source` `restore`), on top
 * of `expectedVersionId` as `commitVersion` requires. The copy shares the old version's blobs and
 * takes its entry, title, theme color, thumbnail and warnings.
 */
export async function restoreVersion(
  deps: AppDeps,
  actor: UserRow,
  artifactId: string,
  n: number,
  expectedVersionId: string,
): Promise<CommitResult> {
  const { db, dialect } = deps.db;
  // Settle what can fail cheaply before reading the old version's files for its search text;
  // that read cannot run inside the transaction (on SQLite it holds the only connection).
  const seen = await getArtifact(db, artifactId, deps.clock.now());
  await assertCurrent(db, seen, expectedVersionId);
  const text = await extractVersionText(deps, (await getVersionByNumber(db, seen, n)).id);

  const result = await db.transaction().execute(async (trx) => {
    const now = deps.clock.now();
    const { artifact, tags } = await lockCurrent(trx, dialect, artifactId, expectedVersionId, now);
    // Deleted since it was read: 410.
    const old = await getVersionByNumber(trx, artifact, n);
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

async function planNewArtifact(
  deps: AppDeps,
  target: Extract<PublishTarget, { kind: 'new_artifact' }>,
  input: VersionInput,
): Promise<Plan> {
  const tags = normalizeTags(target.tags);
  const projectId = target.projectId ?? DEFAULT_PROJECT_ID;
  // Outside the transaction: it writes through the outer handle.
  if (projectId === DEFAULT_PROJECT_ID) await ensureDefaultProject(deps);
  const name = artifactName(target.name, input.meta, input.entryPath);
  return { kind: 'new_artifact', projectId, name, tags };
}

/**
 * Inserts the artifact, without a version yet, and its tags. Its project must exist and not be
 * archived; on Postgres the project row stays share-locked until the commit, so archiving the
 * project waits for a publish that has already checked it.
 */
async function insertArtifact(
  trx: Transaction<Database>,
  dialect: DbDialect,
  plan: Extract<Plan, { kind: 'new_artifact' }>,
  actor: UserRow,
  kind: ArtifactKind,
  now: number,
): Promise<{ artifact: ArtifactRow; tags: string[] }> {
  const project = await trx
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', plan.projectId)
    .$if(dialect === 'postgres', (qb) => qb.forShare())
    .executeTakeFirst();
  if (project === undefined) throw notFound(t('project.notFound'));
  assertNotArchived(project);

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
 * Locks the artifact, checks that `expectedVersionId` is still its current version, and reads
 * its tags.
 */
async function lockCurrent(
  trx: Transaction<Database>,
  dialect: DbDialect,
  artifactId: string,
  expectedVersionId: string,
  now: number,
): Promise<{ artifact: ArtifactRow; tags: string[] }> {
  const artifact =
    (await lockArtifact(trx, dialect, artifactId)) ?? (await getArtifact(trx, artifactId, now));
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
