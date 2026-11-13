import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { sql } from 'kysely';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';
import { idpAccessDeadline } from '../../src/auth/oidc/gate.ts';
import { IDP_REFRESH_TOKEN_PURPOSE, openRefreshToken } from '../../src/auth/oidc/users.ts';
import { searchQuery } from '../../src/db/dialect.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { BACKUP_LEASE } from '../../src/domain/blobs.ts';
import { ensureDefaultProject } from '../../src/domain/projects.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { deriveKey, encryptString } from '../../src/lib/crypto.ts';
import { t } from '../../src/lib/i18n.ts';
import { BACKUP_TABLES, type BackupTable, type Manifest } from '../../src/ops/backup/format.ts';
import { MAINTENANCE_LEASE_TTL_MS } from '../../src/ops/backup/lease.ts';
import { RestoreError, restoreBackup } from '../../src/ops/backup/restore.ts';
import type { BlobStore } from '../../src/storage/index.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import {
  backupToBuffer,
  dumpLogical,
  maintenanceLeaseExpiry,
  outlastMaintenanceLease,
  readAll,
  readArchive,
  referencedShas,
  rewriteArchive,
  rowCounts,
  type Seeded,
  seedInstallation,
  storageCombos,
  storageContext,
} from '../helpers/backup.ts';
import { sha } from '../helpers/blobs.ts';
import type { TestContext } from '../helpers/context.ts';
import { publishFiles } from '../helpers/publish.ts';

/** Restores move ~5 MB through two installations, which takes a while under parallel load. */
const RESTORE_TIMEOUT_MS = 60_000;

type Entry = { name: string; data: Buffer };
type Edit = (e: Entry) => Entry | null;

/** Applies `change` to the first entry whose name starts with `prefix`; the rest pass as they are. */
function onFirst(prefix: string, change: (e: Entry) => Entry | null): Edit {
  let done = false;
  return (e) => {
    if (done || !e.name.startsWith(prefix)) return e;
    done = true;
    return change(e);
  };
}

const keep: Edit = (e) => e;

/** Inverts the byte at `at` (wrapping around a shorter entry) of the first entry under `prefix`. */
const flipByte = (prefix: string, at: number): Edit =>
  onFirst(prefix, (e) => {
    const data = Buffer.from(e.data);
    const i = at % data.length;
    data[i] = (data[i] ?? 0) ^ 0xff;
    return { name: e.name, data };
  });

/** Gives every user in `tables/users.jsonl` the name `name`. */
const renameUser =
  (name: string): Edit =>
  (e) => {
    if (e.name !== 'tables/users.jsonl') return e;
    const lines = e.data
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => `${JSON.stringify({ ...JSON.parse(line), name })}\n`);
    return { name: e.name, data: Buffer.from(lines.join(''), 'utf8') };
  };

const dropFirst = (prefix: string): Edit => onFirst(prefix, () => null);

const renameFirst = (prefix: string, to: string): Edit =>
  onFirst(prefix, (e) => ({ name: to, data: e.data }));

/** Rewrites `manifest.json`: fields merged in, or the whole manifest mapped. */
const editManifest = (change: Partial<Manifest> | ((m: Manifest) => unknown)): Edit =>
  onFirst('manifest.json', (e) => {
    const manifest = JSON.parse(e.data.toString('utf8')) as Manifest;
    const edited = typeof change === 'function' ? change(manifest) : { ...manifest, ...change };
    return { name: e.name, data: Buffer.from(JSON.stringify(edited), 'utf8') };
  });

/** Hex SHA-256 of `b`. */
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * The archive with `table`'s rows rewritten as JSONL lines by `change`, and the manifest made to
 * agree with them, so only the rows themselves are wrong.
 */
async function withTable(
  good: Buffer,
  table: BackupTable,
  change: (rows: Record<string, unknown>[]) => string[],
): Promise<Buffer> {
  const name = `tables/${table}.jsonl`;
  const entry = (await readArchive(good)).find((e) => e.name === name);
  const rows = (entry?.data.toString('utf8') ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const lines = change(rows);
  const data = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
  const stats = { rows: lines.length, bytes: data.length, sha256: digest(data) };
  return rewriteArchive(good, (e) => {
    if (e.name === name) return { name, data };
    if (e.name !== 'manifest.json') return e;
    const m = JSON.parse(e.data.toString('utf8')) as Manifest;
    const edited = { ...m, tables: { ...m.tables, [table]: stats } };
    return { name: e.name, data: Buffer.from(JSON.stringify(edited), 'utf8') };
  });
}

/** The archive without its first blob, and a manifest that does not expect it either. */
async function withoutFirstBlob(good: Buffer): Promise<Buffer> {
  const blob = (await readArchive(good)).find((e) => e.name.startsWith('blobs/'));
  if (blob === undefined) throw new Error('the archive has no blob');
  return rewriteArchive(good, (e) => {
    if (e.name === blob.name) return null;
    if (e.name !== 'manifest.json') return e;
    const m = JSON.parse(e.data.toString('utf8')) as Manifest;
    const blobs = { count: m.blobs.count - 1, bytes: m.blobs.bytes - blob.data.length };
    return { name: e.name, data: Buffer.from(JSON.stringify({ ...m, blobs }), 'utf8') };
  });
}

const DAMAGE: [string, (good: Buffer) => Promise<Buffer>, RegExp][] = [
  ['cut in half', async (b) => b.subarray(0, Math.floor(b.length / 2)), /damaged or incomplete/],
  [
    'a blob byte flipped',
    (b) => rewriteArchive(b, flipByte('blobs/', 100)),
    /does not match its SHA-256/,
  ],
  [
    'a table row edited',
    (b) => rewriteArchive(b, renameUser('Mallory')),
    /tables\/users\.jsonl does not match its checksum/,
  ],
  [
    'a blob dropped',
    (b) => rewriteArchive(b, dropFirst('blobs/')),
    /expected \d+ blobs, found \d+/,
  ],
  [
    'the manifest dropped',
    (b) => rewriteArchive(b, dropFirst('manifest.json')),
    /manifest\.json must come first/,
  ],
  [
    'a path escaping the archive',
    (b) => rewriteArchive(b, keep, [{ name: '../../etc/passwd', data: Buffer.from('x') }]),
    /unexpected entry/,
  ],
  [
    'a blob name that is not a SHA-256',
    (b) => rewriteArchive(b, renameFirst('blobs/', 'blobs/xyz')),
    /unexpected entry/,
  ],
  ['not a tar at all', async () => Buffer.from('hello'), /damaged or incomplete/],
  [
    'a newer format',
    (b) => rewriteArchive(b, editManifest({ format_version: 2 })),
    /newer Pinwall/,
  ],
  [
    'an unknown migration',
    (b) =>
      rewriteArchive(
        b,
        editManifest((m) => ({ ...m, migrations: [...m.migrations, '0099_future'] })),
      ),
    /0099_future/,
  ],
  [
    'a manifest of something else',
    (b) =>
      rewriteArchive(
        b,
        editManifest((m) => ({ ...m, format: 'other-backup' })),
      ),
    /not a Pinwall backup archive/,
  ],
  [
    'a manifest that miscounts rows',
    (b) =>
      rewriteArchive(
        b,
        editManifest((m) => ({
          ...m,
          tables: { ...m.tables, users: { ...m.tables.users, rows: m.tables.users.rows + 1 } },
        })),
      ),
    /tables\/users\.jsonl does not match its checksum/,
  ],
  [
    'a row with a column the target lacks',
    (b) =>
      withTable(b, 'users', (rows) => rows.map((r) => JSON.stringify({ ...r, shoe_size: 42 }))),
    /tables\/users\.jsonl line 1 has unknown column shoe_size/,
  ],
  [
    'a line that is not a row',
    (b) => withTable(b, 'projects', (rows) => [...rows.map((r) => JSON.stringify(r)), '[1, 2]']),
    /tables\/projects\.jsonl line \d+ is not a row/,
  ],
  [
    'a version file whose blob is not in the archive',
    withoutFirstBlob,
    /blobs\/[0-9a-f]{64} is missing/,
  ],
];

/** Spool directories a restore left under `<data dir>/tmp`. */
async function spoolDirs(ctx: TestContext): Promise<string[]> {
  try {
    const names = await readdir(join(ctx.deps.config.dataDir, 'tmp'));
    return names.filter((n) => n.startsWith('restore-'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Every key in the blob store of `ctx`. */
async function storedKeys(ctx: TestContext): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of ctx.deps.blobs.list()) keys.push(key);
  return keys;
}

const pairs = storageCombos.flatMap((a) => storageCombos.map((b) => [a, b] as const));

describe.each(pairs)('round trip %s → %s', (from, to) => {
  test(
    'everything comes back',
    async () => {
      // With sqlite+local → postgres+s3 this is acceptance 6: the upgrade to Postgres and S3.
      const key = randomBytes(32).toString('hex');
      const src = await storageContext(from, { PINWALL_SECRET_KEY: key });
      onTestFinished(() => src.close());
      const seeded = await seedInstallation(src);
      const { buf } = await backupToBuffer(src.deps);
      const dst = await storageContext(to, { PINWALL_SECRET_KEY: key });
      onTestFinished(() => dst.close());

      expect((await restoreBackup(dst.deps, Readable.from(buf))).warnings).toEqual([]);

      expect(await dumpLogical(dst.deps)).toEqual(await dumpLogical(src.deps));
      for (const s of await referencedShas(src.deps)) {
        expect(await readAll(dst.deps.blobs.get(s))).toEqual(await readAll(src.deps.blobs.get(s)));
      }
      expect(await searchQuery(dst.deps.db, 'chup anh', 10, SYSTEM_SCOPE)).toEqual([
        seeded.artifactId,
      ]);
      await expectServing(dst, seeded);
    },
    RESTORE_TIMEOUT_MS,
  );
});

/** The restored installation signs people in, serves files, answers 410 and guards shares. */
async function expectServing(dst: TestContext, seeded: Seeded): Promise<void> {
  const signIn = await dst.request(
    '/api/v1/auth/password/sign-in',
    apiInit(dst, { body: { password: seeded.ownerPassword } }),
  );
  expect(signIn.status).toBe(200);
  const me = await dst.request('/api/v1/me', apiInit(dst, { bearer: seeded.apiToken }));
  expect(me.status).toBe(200);

  const bearer = { authorization: `Bearer ${seeded.apiToken}` };
  const raw = await dst.request(`/a/${seeded.artifactId}/raw`, {
    headers: bearer,
    redirect: 'manual',
  });
  expect(raw.status).toBe(302);
  const page = await dst.request(raw.headers.get('location') ?? '');
  expect(Buffer.from(await page.arrayBuffer())).toEqual(seeded.files['index.html']);
  const deleted = await dst.request(`/a/${seeded.deletedArtifactId}/raw`, {
    headers: bearer,
    redirect: 'manual',
  });
  expect(deleted.status).toBe(410);

  const share = await dst.request(`/api/v1/share/${seeded.shareToken}`, apiInit(dst));
  expect(share.status).toBe(401);
  expect(await share.json()).toMatchObject({ error: { details: { password_required: true } } });
  const unlock = await dst.request(
    `/api/v1/share/${seeded.shareToken}/unlock`,
    apiInit(dst, { body: { password: seeded.sharePassword } }),
  );
  expect(unlock.status).toBe(204);
}

describe('restore', () => {
  /** A seeded SQLite installation and its backup, shared by the tests below; nobody changes it. */
  let src: TestContext;
  let seed: Seeded;
  let good: Buffer;

  beforeAll(async () => {
    src = await storageContext('sqlite+local');
    seed = await seedInstallation(src);
    good = (await backupToBuffer(src.deps)).buf;
  }, RESTORE_TIMEOUT_MS);
  afterAll(() => src.close());

  describe.each(storageCombos)('into %s', (combo) => {
    let dst: TestContext;

    beforeEach(async () => {
      dst = await storageContext(combo);
    });
    afterEach(() => dst.close());

    /** The target holds no row and no stored file; no lease is held and no spool is left. */
    async function expectUntouched(): Promise<void> {
      expect(Object.values(await rowCounts(dst.deps)).every((n) => n === 0)).toBe(true);
      expect(await storedKeys(dst)).toEqual([]);
      expect(await dst.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
      expect(await spoolDirs(dst)).toEqual([]);
    }

    test.each(DAMAGE)(
      '%s is refused and leaves the target untouched',
      async (_name, damage, message) => {
        const restoring = restoreBackup(dst.deps, Readable.from(await damage(good)));
        await expect(restoring).rejects.toThrow(message);
        await expect(restoring).rejects.toBeInstanceOf(RestoreError);
        await expectUntouched();
        // The same target still takes the good archive.
        await restoreBackup(dst.deps, Readable.from(good));
        expect(await dumpLogical(dst.deps)).toEqual(await dumpLogical(src.deps));
        expect(await spoolDirs(dst)).toEqual([]);
      },
      RESTORE_TIMEOUT_MS,
    );

    test('a non-empty target is refused before the archive is read', async () => {
      await createSignedInUser(dst);
      const unread = () =>
        new Readable({
          read() {
            throw new Error('the archive was read');
          },
        });

      await expect(restoreBackup(dst.deps, unread())).rejects.toThrow(
        t('restore.notEmpty', { found: '1 user, 1 session' }),
      );
      await expect(restoreBackup(dst.deps, unread())).rejects.toThrow(/not empty \(1 user/);
      expect(await dst.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
    });

    test('stored files alone make a target non-empty', async () => {
      await dst.deps.blobs.put(sha('left behind'), Buffer.from('left behind'), 11);

      await expect(restoreBackup(dst.deps, Readable.from(good))).rejects.toThrow(
        t('restore.notEmpty', { found: '1 stored file' }),
      );
    });

    test('a freshly started target counts as empty', async () => {
      await ensureDefaultProject(dst.deps);

      expect((await restoreBackup(dst.deps, Readable.from(good))).warnings).toEqual([]);
      expect((await dumpLogical(dst.deps)).projects).toEqual(
        (await dumpLogical(src.deps)).projects,
      );
    });

    test('gzip-compressed archives restore', async () => {
      await restoreBackup(dst.deps, Readable.from(gzipSync(good)));

      expect(await dumpLogical(dst.deps)).toEqual(await dumpLogical(src.deps));
    });

    test(
      'a different secret key clears IdP refresh tokens with a warning',
      async () => {
        const key1 = randomBytes(32).toString('hex');
        const origin = await storageContext('sqlite+local', { PINWALL_SECRET_KEY: key1 });
        onTestFinished(() => origin.close());
        const owner = await createSignedInUser(origin);
        const apiToken = await createUserToken(origin, owner.user.id);
        const sso = await createSignedInUser(origin, { kind: 'oidc', name: 'Linh' });
        const sealed = encryptString(
          deriveKey(Buffer.from(key1, 'hex'), IDP_REFRESH_TOKEN_PURPOSE),
          'rt',
        );
        await origin.deps.db.db
          .updateTable('users')
          .set({ idp_refresh_token: sealed })
          .where('id', '=', sso.user.id)
          .execute();
        // An IdP user without a refresh token has nothing to lose.
        const plain = await createSignedInUser(origin, { kind: 'oidc', name: 'Minh' });
        const { buf } = await backupToBuffer(origin.deps);
        const userRow = (ctx: TestContext, id: string): Promise<UserRow> =>
          ctx.deps.db.db
            .selectFrom('users')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();

        const other = await storageContext(combo, {
          PINWALL_SECRET_KEY: randomBytes(32).toString('hex'),
        });
        onTestFinished(() => other.close());
        const summary = await restoreBackup(other.deps, Readable.from(buf));
        expect(summary.warnings).toEqual([t('restore.keyChanged', { count: 1 })]);
        const cleared = await userRow(other, sso.user.id);
        expect(cleared).toMatchObject({ idp_refresh_token: null, idp_checked_at: null });
        // Access waits for a new sign-in; nothing is left to decrypt later.
        expect(idpAccessDeadline(cleared, other.deps.config)).toBe(0);
        expect(await userRow(other, plain.user.id)).toEqual(await userRow(origin, plain.user.id));
        // Sessions and tokens are stored as plain hashes, so they survive the new key.
        const viaToken = await other.request('/api/v1/me', apiInit(other, { bearer: apiToken }));
        expect(viaToken.status).toBe(200);
        const viaCookie = await other.request(
          '/api/v1/me',
          apiInit(other, { cookie: owner.cookie }),
        );
        expect(viaCookie.status).toBe(200);

        const same = await storageContext(combo, { PINWALL_SECRET_KEY: key1 });
        onTestFinished(() => same.close());
        expect((await restoreBackup(same.deps, Readable.from(buf))).warnings).toEqual([]);
        const kept = await userRow(same, sso.user.id);
        expect(kept.idp_refresh_token).toBe(sealed);
        expect(kept.idp_checked_at).toBe(sso.user.idp_checked_at);
        expect(openRefreshToken(same.deps, sealed)).toBe('rt');
      },
      RESTORE_TIMEOUT_MS,
    );

    test('a restore is refused while the lease is held', async () => {
      expect(await dst.deps.leases.acquire(BACKUP_LEASE, 'b', 60_000)).toBe(true);

      await expect(restoreBackup(dst.deps, Readable.from(good))).rejects.toThrow(t('backup.busy'));
      expect(Object.values(await rowCounts(dst.deps)).every((n) => n === 0)).toBe(true);
      expect(await storedKeys(dst)).toEqual([]);
    });

    test('a target that gains data during the restore is left alone', async () => {
      let intruder: UserRow | undefined;
      await expect(
        restoreBackup(dst.deps, Readable.from(good), {
          beforeInsert: async () => {
            intruder = (await createSignedInUser(dst)).user;
          },
        }),
      ).rejects.toThrow(t('restore.changed'));

      const counts = await rowCounts(dst.deps);
      expect(counts).toEqual({
        ...Object.fromEntries(BACKUP_TABLES.map((table) => [table, 0])),
        users: 1,
        sessions: 1,
      });
      const users = await dst.deps.db.db.selectFrom('users').select('id').execute();
      expect(users).toEqual([{ id: intruder?.id }]);
      expect(await storedKeys(dst)).toEqual([]);
      expect(await dst.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
    });

    test('a file the target stores during the restore outlives its cleanup', async () => {
      // The archive holds this page too, so the target's copy has the same key as the restore's.
      const page = seed.files['index.html']?.toString('utf8') ?? '';
      let member: UserRow | undefined;
      await expect(
        restoreBackup(dst.deps, Readable.from(good), {
          beforeInsert: async () => {
            // Someone signs in on the new installation and publishes before the rows go in.
            member = (await createSignedInUser(dst)).user;
            await publishFiles(dst, member, { 'index.html': page });
          },
        }),
      ).rejects.toThrow(t('restore.changed'));

      // The member's page is still there; every other file the restore stored is gone.
      expect(await storedKeys(dst)).toEqual([sha(page)]);
      const versions = await dst.deps.db.db.selectFrom('versions').select('created_by').execute();
      expect(versions).toEqual([{ created_by: member?.id }]);
    });

    test('a file that is in the store before the restore stores it is not removed', async () => {
      const page = seed.files['index.html']?.toString('utf8') ?? '';
      const store = dst.deps.blobs;
      // Another writer stores the page's bytes just before the restore comes to them, after it
      // found the store empty.
      let raced = false;
      const race = async (key: string) => {
        if (raced || key !== sha(page)) return;
        raced = true;
        await store.put(key, Buffer.from(page), Buffer.byteLength(page));
      };
      const racing: BlobStore = Object.assign(Object.create(store) as BlobStore, {
        has: async (key: string) => {
          await race(key);
          return store.has(key);
        },
        put: async (...args: Parameters<BlobStore['put']>) => {
          await race(args[0]);
          return store.put(...args);
        },
      });

      await expect(
        restoreBackup({ ...dst.deps, blobs: racing }, Readable.from(good), {
          beforeInsert: () => Promise.reject(new Error('the restore stops here')),
        }),
      ).rejects.toThrow('the restore stops here');

      expect(raced).toBe(true);
      expect(await storedKeys(dst)).toEqual([sha(page)]);
      expect(Object.values(await rowCounts(dst.deps)).every((n) => n === 0)).toBe(true);
    });

    test('a cleanup that cannot reach the database leaves the files, and says so once', async () => {
      const warn = vi.spyOn(dst.deps.logger, 'warn');

      await expect(
        restoreBackup(dst.deps, Readable.from(good), {
          beforeInsert: async () => {
            await dst.deps.db.close();
            throw new Error('the database went away');
          },
        }),
      ).rejects.toThrow('the database went away');

      // Unchecked files may be the target's own, so none is deleted, and one line says so.
      const archived = (await readArchive(good))
        .filter((entry) => entry.name.startsWith('blobs/'))
        .map((entry) => entry.name.slice('blobs/'.length));
      const stored = await storedKeys(dst);
      expect(stored.sort()).toEqual(archived.sort());
      const left = warn.mock.calls.filter(([, message]) => String(message).includes('are left'));
      expect(left).toEqual([
        [expect.objectContaining({ left: stored.length }), expect.any(String)],
      ]);
    });

    test('a restore that loses its lease stops and removes what it stored', async () => {
      const clock = new FixedClock(Date.now());
      const store = dst.deps.blobs;
      // Each stored file takes longer than the lease lasts, so it has run out by the next entry.
      let stored = 0;
      const slow: BlobStore = Object.assign(Object.create(store) as BlobStore, {
        put: async (...args: Parameters<BlobStore['put']>) => {
          await store.put(...args);
          stored += 1;
          clock.advance(MAINTENANCE_LEASE_TTL_MS + 1);
        },
      });

      await expect(
        restoreBackup({ ...dst.deps, clock, blobs: slow }, Readable.from(good)),
      ).rejects.toThrow(t('backup.leaseLost'));
      expect(stored).toBe(1);
      await expectUntouched();
    });

    test(
      'an insert that runs past the lease term keeps the lease, with one database connection',
      async () => {
        // On SQLite, and on Postgres with a pool of one, the insert holds the only connection.
        const clock = new FixedClock(Date.now());
        const one = await storageContext(combo, { PINWALL_DATABASE_POOL_SIZE: '1' }, { clock });
        onTestFinished(() => one.close());
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        onTestFinished(() => {
          vi.useRealTimers();
        });

        await restoreBackup(one.deps, Readable.from(good), {
          duringInsert: (trx) => outlastMaintenanceLease(clock, () => maintenanceLeaseExpiry(trx)),
        });
        expect(await dumpLogical(one.deps)).toEqual(await dumpLogical(src.deps));
        expect(await one.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
      },
      RESTORE_TIMEOUT_MS,
    );

    test('a reply listed before its thread root is restored after it', async () => {
      const origin = await storageContext('sqlite+local');
      onTestFinished(() => origin.close());
      const { user } = await createSignedInUser(origin);
      const { artifact, version } = await publishFiles(origin, user, { 'index.html': '<p>x</p>' });
      const now = origin.deps.clock.now();
      const comment = {
        artifact_id: artifact.id,
        version_id: version.id,
        author_user_id: user.id,
        anchor: null,
        created_at: now,
        updated_at: now,
      };
      // Rows are archived in id order, so this reply comes first.
      await origin.deps.db.db
        .insertInto('comments')
        .values([
          {
            ...comment,
            id: 'cmt_zzzzzzzzzzzzzzzzzzzz',
            parent_id: null,
            body: 'root',
            status: 'open',
          },
          {
            ...comment,
            id: 'cmt_00000000000000000000',
            parent_id: 'cmt_zzzzzzzzzzzzzzzzzzzz',
            body: 'reply',
          },
        ])
        .execute();
      const { buf } = await backupToBuffer(origin.deps);

      await restoreBackup(dst.deps, Readable.from(buf));
      expect((await dumpLogical(dst.deps)).comments).toEqual(
        (await dumpLogical(origin.deps)).comments,
      );
    });
  });
});

test.runIf(storageCombos.includes('postgres+s3'))(
  'the Postgres schema has no sequence a restore would have to move forward',
  async () => {
    const ctx = await storageContext('postgres+s3');
    onTestFinished(() => ctx.close());
    // Every key is a generated text id. A migration adding a sequence or an identity column
    // must also make restore set it past the restored rows.
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_class c
      join pg_namespace s on s.oid = c.relnamespace
      where c.relkind = 'S' and s.nspname = current_schema()
    `.execute(ctx.deps.db.db);
    expect(rows[0]?.n).toBe(0);
  },
);
