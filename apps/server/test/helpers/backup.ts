import { randomBytes } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { type Kysely, sql } from 'kysely';
import { extract, pack } from 'tar-stream';
import { expect, vi } from 'vitest';
import { createGrant } from '../../src/content/grants.ts';
import type { Database } from '../../src/db/schema.ts';
import type { AppDeps } from '../../src/deps.ts';
import { recordView } from '../../src/domain/artifacts.ts';
import { BACKUP_LEASE } from '../../src/domain/blobs.ts';
import { addReply, type CommentActor, createThread } from '../../src/domain/comments.ts';
import { deleteArtifact } from '../../src/domain/deletion.ts';
import { createProject } from '../../src/domain/projects.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import { type BackupHooks, createBackup } from '../../src/ops/backup/backup.ts';
import {
  BACKUP_TABLES,
  type BackupTable,
  type Manifest,
  TABLE_KEYS,
} from '../../src/ops/backup/format.ts';
import {
  MAINTENANCE_LEASE_RENEW_MS,
  MAINTENANCE_LEASE_TTL_MS,
} from '../../src/ops/backup/lease.ts';
import { createUserToken, setupOwner } from './auth.ts';
import { sha, storeBlob } from './blobs.ts';
import { createTestContext, type TestContext } from './context.ts';
import { issueTestTokens } from './oauth.ts';
import { publishFiles } from './publish.ts';
import { sampleAnchor } from './review.ts';
import { SoftAuthenticator } from './soft-authenticator.ts';

/** What `seedInstallation` made that a test needs to reach again. */
export interface Seeded {
  ownerPassword: string;
  apiToken: string;
  artifactId: string;
  deletedArtifactId: string;
  shareToken: string;
  sharePassword: string;
  /** The files of version 2, the current one: path → bytes. */
  files: Record<string, Buffer>;
  /** The blob key of `notes/secret.txt`, a file only version 1 has. */
  secretSha: string;
}

/**
 * Fills a fresh installation so that every backed-up table has rows:
 * - the owner, with a password and a passkey, and an API token;
 * - an MCP client signed in through OAuth (client, grant, tokens);
 * - project "Ảnh" holding an artifact tagged "đồ án": version 1 with an HTML page, a 5 MB
 *   random image, a stylesheet and `notes/secret.txt`, then version 2 with the page changed,
 *   `notes/` dropped and the rest shared;
 * - a thread on version 1 with one reply, a password share link, a view, a content grant;
 * - a second artifact published and then deleted, which leaves a tombstone;
 * - one stored blob (row and object) that nothing references.
 */
export async function seedInstallation(ctx: TestContext): Promise<Seeded> {
  const { deps } = ctx;
  const ownerPassword = 'Mật khẩu của chủ nhà';
  const { me, cookie } = await setupOwner(ctx, {
    password: ownerPassword,
    passkey: new SoftAuthenticator({ origin: deps.config.publicOrigin }),
  });
  const owner = await deps.db.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', me.id)
    .executeTakeFirstOrThrow();
  const apiToken = await createUserToken(ctx, owner.id);
  await issueTestTokens(ctx, cookie);

  const project = await createProject(deps, owner, { name: 'Ảnh' });
  const photo = randomBytes(5_000_000);
  const first = await publishFiles(
    ctx,
    owner,
    {
      'index.html': '<h1>Dịch vụ chụp ảnh</h1>',
      'img/photo.bin': photo,
      'shared.css': 'body{}',
      'notes/secret.txt': 'sk-live-backup',
    },
    { kind: 'new_artifact', projectId: project.id, name: null, tags: ['đồ án'] },
  );
  const artifactId = first.artifact.id;
  const files = {
    'index.html': Buffer.from('<h1>Dịch vụ chụp ảnh cưới</h1>'),
    'img/photo.bin': photo,
    'shared.css': Buffer.from('body{}'),
  };
  const second = await publishFiles(ctx, owner, files, {
    kind: 'new_version',
    artifactId,
    expectedVersionId: first.version.id,
  });

  const member: CommentActor = { kind: 'member', user: owner };
  const thread = await createThread(deps, member, artifactId, {
    body: 'Ảnh bìa hơi tối',
    anchor: sampleAnchor(),
    versionId: first.version.id,
  });
  await addReply(deps, member, thread.id, 'Đã sửa ở bản sau');
  const sharePassword = 'mở cửa giúp tôi';
  const { token: shareToken } = await createShareLink(deps, owner, artifactId, {
    versionId: null,
    password: sharePassword,
    expiresAt: null,
    allowComments: true,
  });
  await recordView(deps, owner.id, artifactId);
  await createGrant(deps, { versionId: second.version.id, mode: 'review', user: owner });

  const deleted = await publishFiles(ctx, owner, { 'index.html': '<p>Bản nháp bỏ đi</p>' });
  await deleteArtifact(deps, { user: owner, via: 'session' }, deleted.artifact.id);
  await storeBlob(deps, 'bytes that no version uses');

  return {
    ownerPassword,
    apiToken,
    artifactId,
    deletedArtifactId: deleted.artifact.id,
    shareToken,
    sharePassword,
    files,
    secretSha: sha('sk-live-backup'),
  };
}

/** Runs `createBackup` into memory and returns the archive with its manifest. */
export async function backupToBuffer(
  deps: AppDeps,
  hooks?: BackupHooks,
): Promise<{ buf: Buffer; manifest: Manifest }> {
  const out = new PassThrough();
  const collected = buffer(out);
  // A failed backup destroys `out`, so this rejects too; createBackup's error is the one to keep.
  collected.catch(() => {});
  try {
    const { manifest } = await createBackup(deps, out, hooks);
    return { buf: await collected, manifest };
  } catch (error) {
    out.destroy();
    throw error;
  }
}

/** Every entry of a tar archive, in order. */
export async function readArchive(buf: Buffer): Promise<{ name: string; data: Buffer }[]> {
  const entries: { name: string; data: Buffer }[] = [];
  const reader = extract();
  reader.end(buf);
  for await (const entry of reader) {
    entries.push({ name: entry.header.name, data: await buffer(entry) });
  }
  return entries;
}

/**
 * The archive `buf` written again with each entry passed through `edit` (null drops it), then
 * `append` added at the end.
 */
export async function rewriteArchive(
  buf: Buffer,
  edit: (e: { name: string; data: Buffer }) => { name: string; data: Buffer } | null,
  append: { name: string; data: Buffer }[] = [],
): Promise<Buffer> {
  const kept = (await readArchive(buf)).map(edit).filter((e) => e !== null);
  const writer = pack();
  for (const e of [...kept, ...append]) writer.entry({ name: e.name, mode: 0o644 }, e.data);
  writer.finalize();
  return buffer(writer);
}

/** The blob keys that some version references, distinct and sorted. */
export async function referencedShas(deps: AppDeps): Promise<string[]> {
  const rows = await deps.db.db.selectFrom('version_files').select('sha256').distinct().execute();
  return rows.map((r) => r.sha256).sort();
}

/**
 * Every row of every backed-up table as the driver returns it, sorted by `TABLE_KEYS`, so two
 * installations compare whatever their dialect. Of `blobs`, only rows a version references.
 */
export async function dumpLogical(deps: AppDeps): Promise<Record<BackupTable, unknown[]>> {
  const referenced = new Set(await referencedShas(deps));
  const dump = {} as Record<BackupTable, unknown[]>;
  for (const table of BACKUP_TABLES) {
    const { rows } = await sql<Record<string, unknown>>`select * from ${sql.table(table)}`.execute(
      deps.db.db,
    );
    const kept = table === 'blobs' ? rows.filter((r) => referenced.has(String(r.sha256))) : rows;
    dump[table] = kept.sort(byKeys(TABLE_KEYS[table]));
  }
  return dump;
}

function byKeys(keys: readonly string[]) {
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    for (const key of keys) {
      const x = String(a[key]);
      const y = String(b[key]);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
}

/** A database and blob store pairing a backup is restored from or into. */
export type StorageCombo = 'sqlite+local' | 'postgres+s3';

const s3Env = {
  endpoint: process.env.PINWALL_TEST_S3_ENDPOINT,
  bucket: process.env.PINWALL_TEST_S3_BUCKET ?? 'pinwall-test',
  accessKeyId: process.env.PINWALL_TEST_S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.PINWALL_TEST_S3_SECRET_ACCESS_KEY ?? '',
};

/** The pairings the test stack offers: Postgres + S3 needs both test services configured. */
export const storageCombos: StorageCombo[] =
  process.env.PINWALL_TEST_POSTGRES_URL && s3Env.endpoint
    ? ['sqlite+local', 'postgres+s3']
    : ['sqlite+local'];

if (storageCombos.length === 1) {
  console.info(
    'PINWALL_TEST_POSTGRES_URL or PINWALL_TEST_S3_ENDPOINT is not set: postgres+s3 backup and restore tests skipped (pnpm test:integration).',
  );
}

/**
 * A fresh installation on `combo`: SQLite with local blobs, or a new Postgres database with blobs
 * under a bucket prefix of its own, which `close()` empties. `env` is added last, so it can set
 * `PINWALL_SECRET_KEY`.
 */
export async function storageContext(
  combo: StorageCombo,
  env: Record<string, string> = {},
  opts: { clock?: FixedClock } = {},
): Promise<TestContext> {
  if (combo === 'sqlite+local') return createTestContext({ env, ...opts });
  const ctx = await createTestContext({
    ...opts,
    dialect: 'postgres',
    env: {
      PINWALL_STORAGE: 's3',
      PINWALL_S3_BUCKET: s3Env.bucket,
      PINWALL_S3_ENDPOINT: s3Env.endpoint ?? '',
      PINWALL_S3_ACCESS_KEY_ID: s3Env.accessKeyId,
      PINWALL_S3_SECRET_ACCESS_KEY: s3Env.secretAccessKey,
      PINWALL_S3_FORCE_PATH_STYLE: 'true',
      PINWALL_S3_PREFIX: `restore-${randomBytes(6).toString('hex')}/`,
      ...env,
    },
  });
  let closing: Promise<void> | undefined;
  const close = async () => {
    try {
      for await (const key of ctx.deps.blobs.list()) await ctx.deps.blobs.delete(key);
    } finally {
      await ctx.close();
    }
  };
  return {
    ...ctx,
    close: () => {
      closing ??= close();
      return closing;
    },
  };
}

/** How many rows each backed-up table holds. */
export async function rowCounts(deps: AppDeps): Promise<Record<BackupTable, number>> {
  const counts = {} as Record<BackupTable, number>;
  for (const table of BACKUP_TABLES) {
    const { rows } = await sql<{ n: number | string }>`
      select count(*) as n from ${sql.table(table)}
    `.execute(deps.db.db);
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

/** Every byte of `s`, such as a blob from `BlobStore.get`. */
export async function readAll(s: Readable | Promise<Readable>): Promise<Buffer> {
  return buffer(await s);
}

/**
 * Plays out a maintenance job that runs past the lease's term, from inside the job: the clock and
 * the lease's renewal timer (faked with `vi.useFakeTimers`) move on one renewal at a time, eleven
 * minutes in all, and after each step the lease's expiry, as `readExpiry` sees it, must have moved
 * to a full term from now. A renewal that waits for the job's database connection never lands.
 */
export async function outlastMaintenanceLease(
  clock: FixedClock,
  readExpiry: () => Promise<number | undefined>,
): Promise<void> {
  for (let elapsed = 0; elapsed <= MAINTENANCE_LEASE_TTL_MS; ) {
    clock.advance(MAINTENANCE_LEASE_RENEW_MS);
    vi.advanceTimersByTime(MAINTENANCE_LEASE_RENEW_MS);
    elapsed += MAINTENANCE_LEASE_RENEW_MS;
    await vi.waitFor(async () =>
      expect(await readExpiry()).toBe(clock.now() + MAINTENANCE_LEASE_TTL_MS),
    );
  }
}

/** The maintenance lease's expiry, read through `db`. */
export async function maintenanceLeaseExpiry(db: Kysely<Database>): Promise<number | undefined> {
  const row = await db
    .selectFrom('leases')
    .select('expires_at')
    .where('name', '=', BACKUP_LEASE)
    .executeTakeFirst();
  return row?.expires_at;
}
