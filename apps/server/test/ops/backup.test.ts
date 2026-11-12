import { createHash, randomBytes } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { type KyselyPlugin, sql } from 'kysely';
import { extract, type Header } from 'tar-stream';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { migrations } from '../../src/db/migrations/index.ts';
import { BACKUP_LEASE, sweepBlobs } from '../../src/domain/blobs.ts';
import { deleteVersion } from '../../src/domain/deletion.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import {
  BACKUP_TABLES,
  isSkippedTable,
  keyFingerprint,
  ManifestSchema,
  TABLE_KEYS,
} from '../../src/ops/backup/format.ts';
import {
  holdMaintenanceLease,
  MAINTENANCE_LEASE_RENEW_MS,
  MAINTENANCE_LEASE_TTL_MS,
} from '../../src/ops/backup/lease.ts';
import type { BlobStore } from '../../src/storage/index.ts';
import { PINWALL_VERSION } from '../../src/version.ts';
import {
  backupToBuffer,
  readArchive,
  referencedShas,
  type Seeded,
  seedInstallation,
} from '../helpers/backup.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects, writeElsewhere } from '../helpers/db.ts';

const T = Date.UTC(2026, 10, 12);

/** Hex SHA-256 of `b`. */
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type Entry = { name: string; data: Buffer };

function finder(entries: Entry[]): (name: string) => Entry {
  return (name) => {
    const found = entries.find((e) => e.name === name);
    if (!found) throw new Error(`no entry ${name}`);
    return found;
  };
}

/** One JSON object per non-empty line. */
function jsonl(e: Entry): Record<string, unknown>[] {
  return e.data
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The tar headers of `buf`, in order. */
async function headers(buf: Buffer): Promise<Header[]> {
  const found: Header[] = [];
  const reader = extract();
  reader.end(buf);
  for await (const entry of reader) {
    found.push(entry.header);
    await buffer(entry);
  }
  return found;
}

/** Spool directories a backup left under `<data dir>/tmp`. */
async function spoolDirs(ctx: TestContext): Promise<string[]> {
  try {
    const names = await readdir(join(ctx.deps.config.dataDir, 'tmp'));
    return names.filter((n) => n.startsWith('backup-'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

describe.each(dialects)('backup on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
  });
  afterEach(() => ctx.close());

  test('the archive is the manifest, one JSONL per table and every referenced blob', async () => {
    await seedInstallation(ctx);
    const { buf, manifest } = await backupToBuffer(ctx.deps);
    const entries = await readArchive(buf);
    const entry = finder(entries);
    const refs = await referencedShas(ctx.deps);

    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      ...BACKUP_TABLES.map((table) => `tables/${table}.jsonl`),
      ...refs.map((s) => `blobs/${s}`),
    ]);
    const m = ManifestSchema.parse(JSON.parse(entries[0]?.data.toString('utf8') ?? ''));
    expect(m).toMatchObject({
      format: 'pinwall-backup',
      format_version: 1,
      pinwall_version: PINWALL_VERSION,
      created_at: T,
      source: { database: dialect, storage: 'local' },
      migrations: Object.keys(migrations),
      key_fingerprint: keyFingerprint(ctx.deps.config.secretKey ?? Buffer.alloc(0)),
    });
    for (const table of BACKUP_TABLES) {
      const e = entry(`tables/${table}.jsonl`);
      expect(m.tables[table]).toEqual({
        rows: e.data.toString().split('\n').filter(Boolean).length,
        bytes: e.data.length,
        sha256: sha(e.data),
      });
      // The seed fills every table, so each one's paging ran.
      expect(m.tables[table].rows, table).toBeGreaterThan(0);
    }
    expect(m.tables.blobs.rows).toBe(refs.length); // the orphan row is left out
    expect(m.blobs.count).toBe(refs.length);
    let blobBytes = 0;
    for (const s of refs) {
      expect(sha(entry(`blobs/${s}`).data)).toBe(s);
      blobBytes += entry(`blobs/${s}`).data.length;
    }
    expect(m.blobs.bytes).toBe(blobBytes);
    expect(manifest).toEqual(m);
    expect(m.key_fingerprint).not.toContain(ctx.deps.config.secretKey?.toString('hex'));

    for (const h of await headers(buf)) {
      expect(h).toMatchObject({ type: 'file', mode: 0o644, mtime: new Date(T) });
    }
  });

  test('rows are logical values', async () => {
    await seedInstallation(ctx);
    const entry = finder(await readArchive((await backupToBuffer(ctx.deps)).buf));

    const [owner] = jsonl(entry('tables/users.jsonl'));
    expect(typeof owner?.created_at).toBe('number');
    expect([0, 1]).toContain(owner?.email_verified);
    for (const version of jsonl(entry('tables/versions.jsonl'))) {
      expect(typeof version.meta).toBe('string');
      expect(typeof version.total_bytes).toBe('number');
    }
    const tables = await ctx.deps.db.db.introspection.getTables();
    for (const table of BACKUP_TABLES) {
      const columns = tables.find((x) => x.name === table)?.columns.map((c) => c.name) ?? [];
      for (const row of jsonl(entry(`tables/${table}.jsonl`))) {
        expect(columns, table).toEqual(expect.arrayContaining(Object.keys(row)));
      }
    }
  });

  test('the archive holds no credential in clear', async () => {
    const seeded = await seedInstallation(ctx);
    const { buf } = await backupToBuffer(ctx.deps);
    const text = buf.toString('latin1');
    const key = ctx.deps.config.secretKey ?? Buffer.alloc(0);

    for (const secret of [
      seeded.ownerPassword,
      seeded.sharePassword,
      seeded.apiToken,
      seeded.shareToken,
      key.toString('hex'),
      key.toString('base64'),
    ]) {
      expect(text.includes(Buffer.from(secret).toString('latin1')), secret).toBe(false);
    }
  });

  test('every table in the schema is backed up or deliberately skipped', async () => {
    const names = (await ctx.deps.db.db.introspection.getTables())
      .map((x) => x.name)
      .filter((n) => !isSkippedTable(n));
    expect(names.sort()).toEqual([...BACKUP_TABLES].sort());
  });

  test("each table's paging key is its primary key", async () => {
    for (const table of BACKUP_TABLES) {
      const { rows } =
        dialect === 'sqlite'
          ? await sql<{ name: string }>`
              select name from pragma_table_info(${table}) where pk > 0 order by pk
            `.execute(ctx.deps.db.db)
          : await sql<{ name: string }>`
              select a.attname as name
              from pg_constraint c
              cross join lateral unnest(c.conkey) with ordinality as k(attnum, position)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
              where c.contype = 'p' and c.conrelid = ${table}::regclass
              order by k.position
            `.execute(ctx.deps.db.db);
      expect(
        rows.map((r) => r.name),
        table,
      ).toEqual(TABLE_KEYS[table]);
    }
  });

  test('a table larger than one page is copied whole, each row once', async () => {
    const kinds = ['artifact', 'content_grant', 'share_link'] as const;
    const rows = Array.from({ length: 2_345 }, (_, i) => ({
      kind: kinds[i % kinds.length] ?? 'artifact',
      key: `key-${(i * 7919) % 2_345}`,
      deleted_at: T,
      expires_at: i % 2 === 0 ? null : T + i,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await ctx.deps.db.db
        .insertInto('tombstones')
        .values(rows.slice(i, i + 500))
        .execute();
    }

    const entry = finder(await readArchive((await backupToBuffer(ctx.deps)).buf));
    const copied = jsonl(entry('tables/tombstones.jsonl'));
    const id = (r: Record<string, unknown>) => `${r.kind}/${r.key}`;
    expect(copied).toHaveLength(rows.length);
    expect(new Set(copied.map(id)).size).toBe(rows.length);
    expect(new Set(copied.map(id))).toEqual(new Set(rows.map(id)));
  });

  test('the lease is held from before the snapshot until the archive ends', async () => {
    let heldAfterSnapshot: boolean | undefined;
    let holder: string | undefined;
    await backupToBuffer(ctx.deps, {
      afterSnapshot: async () => {
        heldAfterSnapshot = await ctx.deps.leases.isHeld(BACKUP_LEASE);
        const row = await ctx.deps.db.db
          .selectFrom('leases')
          .select('holder')
          .where('name', '=', BACKUP_LEASE)
          .executeTakeFirst();
        holder = row?.holder;
      },
    });
    expect(heldAfterSnapshot).toBe(true);
    expect(holder).toMatch(/^backup:.+:\d+:[0-9a-f]{8}$/);
    expect(await ctx.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
  });

  test('a version deleted during the backup is in the archive and its files stay until the sweep', async () => {
    const seeded = await seedInstallation(ctx);
    const owner = await ctx.deps.db.db
      .selectFrom('users')
      .selectAll()
      .where('kind', '=', 'owner')
      .executeTakeFirstOrThrow();

    const { buf } = await backupToBuffer(ctx.deps, {
      afterSnapshot: async () => {
        await deleteVersion(ctx.deps, { user: owner, via: 'session' }, seeded.artifactId, 1);
      },
    });
    const entry = finder(await readArchive(buf));
    expect(sha(entry(`blobs/${seeded.secretSha}`).data)).toBe(seeded.secretSha);
    const numbers = jsonl(entry('tables/versions.jsonl'))
      .filter((v) => v.artifact_id === seeded.artifactId)
      .map((v) => v.number);
    expect(numbers).toContain(1);

    expect(await ctx.deps.blobs.has(seeded.secretSha)).toBe(true);
    expect(await sweepBlobs(ctx.deps)).toBeGreaterThanOrEqual(1);
    expect(await ctx.deps.blobs.has(seeded.secretSha)).toBe(false);
  });

  test('a backup is refused while another holds the lease', async () => {
    expect(await ctx.deps.leases.acquire(BACKUP_LEASE, 'other', 60_000)).toBe(true);

    await expect(backupToBuffer(ctx.deps)).rejects.toMatchObject({
      status: 409,
      message: t('backup.busy'),
    });
    expect(await spoolDirs(ctx)).toEqual([]);
  });

  test.each([
    ['changed', (path: string) => writeFile(path, randomBytes(5_000_000))],
    ['missing', (path: string) => rm(path)],
  ])('a %s blob fails the backup and leaves nothing behind', async (_how, damage) => {
    const seeded = await seedInstallation(ctx);
    const photoSha = sha(seeded.files['img/photo.bin'] ?? Buffer.alloc(0));
    const storage = ctx.deps.config.storage;
    if (storage.kind !== 'local') throw new Error('expected local storage');
    await damage(join(storage.dir, photoSha.slice(0, 2), photoSha.slice(2, 4), photoSha));

    await expect(backupToBuffer(ctx.deps)).rejects.toThrow(t('backup.blobBad', { sha: photoSha }));
    expect(await ctx.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
    expect(await spoolDirs(ctx)).toEqual([]);
  });

  test('a snapshot that outlasts the lease aborts the backup', async () => {
    await seedInstallation(ctx);

    await expect(
      backupToBuffer(ctx.deps, {
        afterSnapshot: async () => {
          clock.advance(MAINTENANCE_LEASE_TTL_MS + 1);
        },
      }),
    ).rejects.toThrow(t('backup.leaseLost'));
    expect(await spoolDirs(ctx)).toEqual([]);
  });

  test('a lease lost while the blobs are copied aborts the backup', async () => {
    await seedInstallation(ctx);
    const store = ctx.deps.blobs;
    // Each read takes longer than the lease lasts, so it has run out before the next entry.
    const slow: BlobStore = Object.assign(Object.create(store) as BlobStore, {
      get: (sha256: string) => {
        clock.advance(MAINTENANCE_LEASE_TTL_MS + 1);
        return store.get(sha256);
      },
    });

    await expect(backupToBuffer({ ...ctx.deps, blobs: slow })).rejects.toThrow(
      t('backup.leaseLost'),
    );
    expect(await spoolDirs(ctx)).toEqual([]);
  });

  test.runIf(dialect === 'sqlite')(
    'the snapshot leaves the database free for writers in other processes',
    async () => {
      await seedInstallation(ctx);
      const { database } = ctx.deps.config;
      if (database.kind !== 'sqlite') throw new Error('expected SQLite');
      // Holds the backup inside its snapshot transaction, once the snapshot has read something.
      let reached = () => {};
      const inSnapshot = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let resume = () => {};
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let paused = false;
      const pause: KyselyPlugin = {
        transformQuery: ({ node }) => node,
        transformResult: async ({ result }) => {
          if (!paused) {
            paused = true;
            reached();
            await resumed;
          }
          return result;
        },
      };
      const db = { ...ctx.deps.db, db: ctx.deps.db.db.withPlugin(pause) };
      const backup = backupToBuffer({ ...ctx.deps, db });

      await inSnapshot;
      // The running server, in another process, writes now and must not have to wait.
      let write: 'committed' | 'busy';
      try {
        write = writeElsewhere(
          database.path,
          'insert into tombstones (kind, key, deleted_at, expires_at) values (?, ?, ?, ?)',
          'artifact',
          'written-during-backup',
          T,
          null,
        );
      } finally {
        resume();
      }

      const { buf } = await backup;
      expect(write).toBe('committed');
      // The archive is the database as it was when the snapshot began.
      const keys = jsonl(finder(await readArchive(buf))('tables/tombstones.jsonl')).map(
        (row) => row.key,
      );
      expect(keys).not.toContain('written-during-backup');
    },
  );

  describe('the maintenance lease', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const expiresAt = async () =>
      (
        await ctx.deps.db.db
          .selectFrom('leases')
          .select('expires_at')
          .where('name', '=', BACKUP_LEASE)
          .executeTakeFirst()
      )?.expires_at;

    test('is renewed while held and lost once a renewal fails', async () => {
      const lease = await holdMaintenanceLease(ctx.deps, 'restore');
      try {
        expect(await expiresAt()).toBe(T + MAINTENANCE_LEASE_TTL_MS);

        clock.advance(MAINTENANCE_LEASE_RENEW_MS);
        vi.advanceTimersByTime(MAINTENANCE_LEASE_RENEW_MS);
        await vi.waitFor(async () =>
          expect(await expiresAt()).toBe(T + MAINTENANCE_LEASE_RENEW_MS + MAINTENANCE_LEASE_TTL_MS),
        );
        lease.assertHeld();

        await ctx.deps.db.db
          .updateTable('leases')
          .set({ holder: 'someone else' })
          .where('name', '=', BACKUP_LEASE)
          .execute();
        vi.advanceTimersByTime(MAINTENANCE_LEASE_RENEW_MS);
        await vi.waitFor(() => expect(() => lease.assertHeld()).toThrow(t('backup.leaseLost')));
      } finally {
        await lease.release();
      }
    });

    test('release frees it and stops renewing', async () => {
      const lease = await holdMaintenanceLease(ctx.deps, 'backup');
      await lease.release();

      expect(await ctx.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

const s3Endpoint = process.env.PINWALL_TEST_S3_ENDPOINT;

describe.each(dialects)('backup of S3 storage on %s', (dialect) => {
  test.skipIf(!s3Endpoint)(
    'blobs stored on S3 are archived and verified the same way',
    async () => {
      const ctx = await createTestContext({
        dialect,
        env: {
          PINWALL_STORAGE: 's3',
          PINWALL_S3_BUCKET: process.env.PINWALL_TEST_S3_BUCKET ?? 'pinwall-test',
          PINWALL_S3_ENDPOINT: s3Endpoint ?? '',
          PINWALL_S3_ACCESS_KEY_ID: process.env.PINWALL_TEST_S3_ACCESS_KEY_ID ?? '',
          PINWALL_S3_SECRET_ACCESS_KEY: process.env.PINWALL_TEST_S3_SECRET_ACCESS_KEY ?? '',
          PINWALL_S3_FORCE_PATH_STYLE: 'true',
          PINWALL_S3_PREFIX: `backup-${randomBytes(6).toString('hex')}/`,
        },
      });
      onTestFinished(async () => {
        for await (const key of ctx.deps.blobs.list()) await ctx.deps.blobs.delete(key);
        await ctx.close();
      });
      const seeded: Seeded = await seedInstallation(ctx);

      const { buf, manifest } = await backupToBuffer(ctx.deps);
      const entries = await readArchive(buf);
      const refs = await referencedShas(ctx.deps);

      expect(manifest.source).toEqual({ database: dialect, storage: 's3' });
      expect(entries.filter((e) => e.name.startsWith('blobs/')).map((e) => e.name)).toEqual(
        refs.map((s) => `blobs/${s}`),
      );
      for (const e of entries.filter((x) => x.name.startsWith('blobs/'))) {
        expect(`blobs/${sha(e.data)}`).toBe(e.name);
      }
      expect(
        finder(entries)(`blobs/${sha(seeded.files['img/photo.bin'] ?? Buffer.alloc(0))}`).data,
      ).toEqual(seeded.files['img/photo.bin']);
    },
  );
});
