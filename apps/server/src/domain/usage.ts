import type { AdminUsage } from '@pinwall/shared';
import type { Transaction } from 'kysely';
import { lockUser } from '../auth/account.ts';
import type { Db } from '../auth/passkeys.ts';
import { effectiveRole } from '../auth/roles.ts';
import type { Config } from '../config/types.ts';
import type { DbDialect } from '../db/connect.ts';
import type { Database, UserRow } from '../db/schema.ts';
import { AppError } from '../lib/errors.ts';
import { formatBytes } from '../lib/format.ts';
import { t } from '../lib/i18n.ts';

/**
 * What a person's space holds: the size of its versions and their files, each version counted in
 * full, and its artifacts.
 */
export interface Usage {
  bytes: number;
  artifacts: number;
  files: number;
}

/** null = no limit. */
export interface QuotaLimits {
  bytes: number | null;
  artifacts: number | null;
  files: number | null;
}

/** Whose space a publish fills, and what it adds. projectId null: the publisher's own default. */
export interface QuotaNeed {
  projectId: string | null;
  actor: UserRow;
  bytes: number;
  artifacts: number;
  files: number;
}

/**
 * What was left in the space a publish fills when `checkQuota` looked, for the publish to be held
 * to while its files arrive (`IngestBudget.holdTo`): the bytes and the files it may add, null for
 * no limit. The commit checks again, under the space's lock.
 */
export interface QuotaRoom {
  bytes: number | null;
  files: number | null;
  /** The 413 for an upload larger than `bytes`: `size` is its declared size or what has arrived. */
  uploadTooLarge(size: number): AppError;
  /** The 413 for a version with more files than `files`. */
  tooManyFiles(): AppError;
}

/**
 * What `userId`'s space holds. In personal mode, every version and artifact in the projects they
 * own, editors' publishes included, so the usage moves with the projects; in team mode, where
 * projects are shared, the versions and artifacts they published (`created_by`). The files are
 * the `version_files` rows of those versions, read as the sum of their `file_count`, which is
 * each version's number of rows.
 */
export async function usageOf(db: Db, config: Config, userId: string): Promise<Usage> {
  if (config.visibility === 'personal') {
    const versions = await db
      .selectFrom('versions')
      .innerJoin('artifacts', 'artifacts.id', 'versions.artifact_id')
      .innerJoin('projects', 'projects.id', 'artifacts.project_id')
      .where('projects.owner_id', '=', userId)
      .select((eb) => [
        eb.fn.sum<number | string | null>('versions.total_bytes').as('bytes'),
        eb.fn.sum<number | string | null>('versions.file_count').as('files'),
      ])
      .executeTakeFirstOrThrow();
    const artifacts = await db
      .selectFrom('artifacts')
      .innerJoin('projects', 'projects.id', 'artifacts.project_id')
      .where('projects.owner_id', '=', userId)
      .select((eb) => eb.fn.countAll<number | string>().as('n'))
      .executeTakeFirstOrThrow();
    return toUsage(versions, artifacts.n);
  }
  const versions = await db
    .selectFrom('versions')
    .where('created_by', '=', userId)
    .select((eb) => [
      eb.fn.sum<number | string | null>('total_bytes').as('bytes'),
      eb.fn.sum<number | string | null>('file_count').as('files'),
    ])
    .executeTakeFirstOrThrow();
  const artifacts = await db
    .selectFrom('artifacts')
    .where('created_by', '=', userId)
    .select((eb) => eb.fn.countAll<number | string>().as('n'))
    .executeTakeFirstOrThrow();
  return toUsage(versions, artifacts.n);
}

/**
 * What an admin sees of each of `userIds`, for the user list: five grouped queries, whatever the
 * number of people. Artifacts, versions and bytes are on `usageOf`'s basis (the projects they own
 * in personal mode, what they published in team mode); projects are the ones they own and share
 * links the ones they made that are still active at `now`, in either mode; the last publish is
 * the newest version they published. Everyone asked for is in the result, with zeros.
 */
export async function usageSummaries(
  db: Db,
  config: Config,
  userIds: readonly string[],
  now: number,
): Promise<Map<string, AdminUsage>> {
  const summaries = new Map<string, AdminUsage>(
    userIds.map((id) => [
      id,
      {
        projects: 0,
        artifacts: 0,
        versions: 0,
        bytes: 0,
        share_links: 0,
        last_published_at: null,
      },
    ]),
  );
  if (userIds.length === 0) return summaries;
  const ids = [...userIds];
  const set = <K extends keyof AdminUsage>(id: string | null, key: K, value: AdminUsage[K]) => {
    const summary = id === null ? undefined : summaries.get(id);
    if (summary !== undefined) summary[key] = value;
  };

  for (const row of await db
    .selectFrom('projects')
    .select(['owner_id', (eb) => eb.fn.countAll<number | string>().as('n')])
    .where('owner_id', 'in', ids)
    .groupBy('owner_id')
    .execute()) {
    set(row.owner_id, 'projects', Number(row.n));
  }

  const personal = config.visibility === 'personal';
  // Whose each artifact and version is: the owner of its project, or whoever published it.
  const artifacts = personal
    ? db
        .selectFrom('artifacts')
        .innerJoin('projects', 'projects.id', 'artifacts.project_id')
        .select('projects.owner_id as who')
        .where('projects.owner_id', 'in', ids)
        .groupBy('projects.owner_id')
    : db
        .selectFrom('artifacts')
        .select('artifacts.created_by as who')
        .where('artifacts.created_by', 'in', ids)
        .groupBy('artifacts.created_by');
  for (const row of await artifacts
    .select((eb) => eb.fn.countAll<number | string>().as('n'))
    .execute()) {
    set(row.who, 'artifacts', Number(row.n));
  }

  const versions = personal
    ? db
        .selectFrom('versions')
        .innerJoin('artifacts', 'artifacts.id', 'versions.artifact_id')
        .innerJoin('projects', 'projects.id', 'artifacts.project_id')
        .select('projects.owner_id as who')
        .where('projects.owner_id', 'in', ids)
        .groupBy('projects.owner_id')
    : db
        .selectFrom('versions')
        .select('versions.created_by as who')
        .where('versions.created_by', 'in', ids)
        .groupBy('versions.created_by');
  for (const row of await versions
    .select((eb) => [
      eb.fn.countAll<number | string>().as('n'),
      eb.fn.sum<number | string | null>('versions.total_bytes').as('bytes'),
    ])
    .execute()) {
    set(row.who, 'versions', Number(row.n));
    set(row.who, 'bytes', Number(row.bytes ?? 0));
  }

  for (const row of await db
    .selectFrom('share_links')
    .select(['created_by', (eb) => eb.fn.countAll<number | string>().as('n')])
    .where('created_by', 'in', ids)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .groupBy('created_by')
    .execute()) {
    set(row.created_by, 'share_links', Number(row.n));
  }

  for (const row of await db
    .selectFrom('versions')
    .select(['created_by', (eb) => eb.fn.max<number | string>('created_at').as('last')])
    .where('created_by', 'in', ids)
    .groupBy('created_by')
    .execute()) {
    set(row.created_by, 'last_published_at', Number(row.last));
  }
  return summaries;
}

/** A sum is a numeric (a string) on Postgres and null over no rows; a count is a bigint. */
function toUsage(
  versions: { bytes: number | string | null; files: number | string | null },
  artifacts: number | string,
): Usage {
  return {
    bytes: Number(versions.bytes ?? 0),
    artifacts: Number(artifacts),
    files: Number(versions.files ?? 0),
  };
}

/**
 * Admins: all null. Otherwise the user's override, else the instance value; 0 means null. The
 * files limit has no override: it is the instance's for everyone.
 */
export function limitsOf(config: Config, user: UserRow): QuotaLimits {
  if (effectiveRole(user) === 'admin') return { bytes: null, artifacts: null, files: null };
  return {
    bytes: noLimitAtZero(user.quota_bytes ?? config.quota.bytes),
    artifacts: noLimitAtZero(user.quota_artifacts ?? config.quota.artifacts),
    files: noLimitAtZero(config.quota.files),
  };
}

const noLimitAtZero = (limit: number): number | null => (limit === 0 ? null : limit);

/**
 * Whether `user` has a space worth showing, so `/me` and `whoami` send its usage and limits:
 * always in personal mode, where everyone has one; in team mode only when an instance quota is
 * set or the user has an override. With none of them the answer is the 1.0 one, which has no such
 * keys.
 */
export function quotaApplies(config: Config, user: UserRow): boolean {
  return (
    config.visibility === 'personal' ||
    config.quota.bytes > 0 ||
    config.quota.artifacts > 0 ||
    config.quota.files > 0 ||
    user.quota_bytes !== null ||
    user.quota_artifacts !== null
  );
}

/**
 * Without locks: for checkTarget and restore's early check. When the space is the publisher's
 * own, it goes by `need.actor` as the caller read it, so a publisher without limits costs no
 * query here; the commit reads the row again. Returns what is left in the space beyond what it
 * holds now, for a publish to be held to while its files arrive; undefined when no limit applies.
 */
export async function checkQuota(
  db: Db,
  config: Config,
  need: QuotaNeed,
): Promise<QuotaRoom | undefined> {
  const subject = (await projectOwnerOf(db, config, need)) ?? need.actor;
  const limits = applicableLimits(config, subject, need);
  if (limits === null) return undefined;
  const used = await usageOf(db, config, subject.id);
  assertFits(need, subject, limits, used);
  const space = spaceOf(subject, need.actor);
  const left = (limit: number | null, inUse: number) => (limit === null ? null : limit - inUse);
  return {
    bytes: left(limits.bytes, used.bytes),
    files: left(limits.files, used.files),
    uploadTooLarge: (size) => uploadTooLarge(space, limits.bytes ?? 0, used.bytes, size),
    tooManyFiles: () => tooManyFiles(space, limits.files ?? 0, used.files),
  };
}

/**
 * In the commit transaction, after the target is held and before the first insert. Reads the
 * subject's row; only when a limit applies does it take lockUser(subject), read the row again and
 * then read usage, so the default configuration takes no new lock. The lock makes the publishes
 * into one space take turns from there to their commit, so of two that would each fit alone but
 * not together, the second sees the first's version and is refused; it also waits for an admin's
 * change of the subject's limits, which the second read then sees. It is the last lock a commit
 * takes, after the artifact, the project and the role: a commit holding a user row never waits
 * for one of those.
 */
export async function assertQuota(
  trx: Transaction<Database>,
  dialect: DbDialect,
  config: Config,
  need: QuotaNeed,
): Promise<void> {
  const seen = (await projectOwnerOf(trx, config, need)) ?? (await currentRow(trx, need.actor));
  if (applicableLimits(config, seen, need) === null) return;
  await lockUser(trx, dialect, seen.id);
  // The limits as they are now: an admin may have changed them while the lock waited.
  const subject = await currentRow(trx, seen);
  const limits = applicableLimits(config, subject, need);
  if (limits === null) return;
  assertFits(need, subject, limits, await usageOf(trx, config, subject.id));
}

/**
 * Whose space `need` fills when it is not the publisher's: in personal mode, the owner of its
 * project, when that project has one. Null otherwise, and in team mode always: the publisher's.
 */
async function projectOwnerOf(db: Db, config: Config, need: QuotaNeed): Promise<UserRow | null> {
  if (config.visibility !== 'personal' || need.projectId === null) return null;
  const owner = await db
    .selectFrom('projects')
    .innerJoin('users', 'users.id', 'projects.owner_id')
    .selectAll('users')
    .where('projects.id', '=', need.projectId)
    .executeTakeFirst();
  return owner ?? null;
}

/** `user`'s row as it is now, for the overrides an admin may have just changed. */
async function currentRow(db: Db, user: UserRow): Promise<UserRow> {
  const row = await db.selectFrom('users').selectAll().where('id', '=', user.id).executeTakeFirst();
  return row ?? user;
}

/**
 * The subject's limits that `need` can go over, or null when none can: the bytes limit always
 * (a version of no bytes still may not go into a space that is already over), the artifacts
 * limit only for a new artifact, the files limit for anything that adds files (every version).
 */
function applicableLimits(config: Config, subject: UserRow, need: QuotaNeed): QuotaLimits | null {
  const limits = limitsOf(config, subject);
  const applicable = {
    bytes: limits.bytes,
    artifacts: need.artifacts > 0 ? limits.artifacts : null,
    files: need.files > 0 ? limits.files : null,
  };
  const none = applicable.bytes === null && applicable.artifacts === null;
  return none && applicable.files === null ? null : applicable;
}

/** Whose space a refusal is about, as its message and details name it. */
interface Space {
  whose: 'own' | 'other';
  owner: string;
  details: { id: string; name: string };
}

function spaceOf(subject: UserRow, actor: UserRow): Space {
  const owner = subject.name ?? subject.email ?? subject.id;
  return {
    whose: subject.id === actor.id ? 'own' : 'other',
    owner,
    details: { id: subject.id, name: owner },
  };
}

/**
 * 413 `quota_exceeded` when `need` does not fit: artifacts first, then bytes, then files, each
 * `used + need ≤ limit`.
 */
function assertFits(need: QuotaNeed, subject: UserRow, limits: QuotaLimits, used: Usage): void {
  const space = spaceOf(subject, need.actor);
  const { whose, owner } = space;
  if (limits.artifacts !== null && used.artifacts + need.artifacts > limits.artifacts) {
    throw new AppError(
      'quota_exceeded',
      413,
      t(`quota.artifacts.${whose}`, { used: used.artifacts, limit: limits.artifacts, owner }),
      {
        used_artifacts: used.artifacts,
        limit_artifacts: limits.artifacts,
        space_owner: space.details,
      },
    );
  }
  if (limits.bytes !== null && used.bytes + need.bytes > limits.bytes) {
    throw new AppError(
      'quota_exceeded',
      413,
      t(`quota.bytes.${whose}`, {
        needed: formatBytes(need.bytes),
        used: formatBytes(used.bytes),
        limit: formatBytes(limits.bytes),
        owner,
      }),
      {
        used_bytes: used.bytes,
        limit_bytes: limits.bytes,
        needed_bytes: need.bytes,
        space_owner: space.details,
      },
    );
  }
  if (limits.files !== null && used.files + need.files > limits.files) {
    throw tooManyFiles(space, limits.files, used.files);
  }
}

/**
 * The 413 for an upload larger than what is left of the bytes limit, while it streams: `size` is
 * its declared size or the bytes that have arrived, so it says only that the upload does not fit.
 */
function uploadTooLarge(space: Space, limit: number, used: number, size: number): AppError {
  return new AppError(
    'quota_exceeded',
    413,
    t(`quota.bytes.upload.${space.whose}`, {
      left: formatBytes(Math.max(0, limit - used)),
      used: formatBytes(used),
      limit: formatBytes(limit),
      owner: space.owner,
    }),
    { used_bytes: used, limit_bytes: limit, needed_bytes: size, space_owner: space.details },
  );
}

/** The 413 for a version whose files do not fit in what is left of the files limit. */
function tooManyFiles(space: Space, limit: number, used: number): AppError {
  return new AppError(
    'quota_exceeded',
    413,
    t(`quota.files.${space.whose}`, { used, limit, owner: space.owner }),
    { used_files: used, limit_files: limit, space_owner: space.details },
  );
}
