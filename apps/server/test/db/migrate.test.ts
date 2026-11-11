import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { type Insertable, type Kysely, sql } from 'kysely';
import { describe, expect, onTestFinished, test } from 'vitest';
import { connectDb, type DbHandle } from '../../src/db/connect.ts';
import { migrateToLatest, runMigrations } from '../../src/db/migrate.ts';
import type { MigrationDb } from '../../src/db/migrations/index.ts';
import type { Database } from '../../src/db/schema.ts';
import { createPostgresDatabase, dialects, withDb } from '../helpers/db.ts';

const T = 1_762_000_000_000;
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
/** Every migration, in the order they apply. */
const ALL_MIGRATIONS = ['0001_initial', '0002_publishing'];

type Rows = { [K in keyof Database]: Required<Insertable<Database[K]>>[] };

/**
 * One fully populated graph, every column set, in an order that satisfies the foreign keys.
 * `ver_1` and `ver_2` belong to `art_1`; `shr_1` is pinned to `ver_1`; `cmt_1` was written on
 * `ver_1` and resolved in `ver_2`, `cmt_2` replies to it on `ver_2`; `cmt_3` was written on
 * `ver_2` and points at `ver_1` as the version it was resolved in.
 */
function graph(): Rows {
  const user = 'usr_1';
  return {
    users: [
      {
        id: user,
        kind: 'oidc',
        email: 'an@example.com',
        email_verified: 1,
        name: 'An Nguyễn',
        avatar_url: 'https://idp.example/an.png',
        idp_role: 'member',
        role_override: 'admin',
        oidc_issuer: 'https://idp.example',
        oidc_subject: 'subject-1',
        idp_refresh_token: 'v1.iv.ct.tag',
        idp_checked_at: T,
        disabled_at: T + 1,
        disabled_reason: 'left the team',
        created_at: T,
        last_seen_at: T + 2,
      },
    ],
    password_credentials: [{ user_id: user, hash: 'scrypt$32768$8$1$salt$hash', updated_at: T }],
    passkeys: [
      {
        id: 'pky_1',
        user_id: user,
        credential_id: 'credential-1',
        public_key: 'public-key',
        counter: 7,
        transports: '["internal"]',
        name: 'Laptop',
        created_at: T,
        last_used_at: T + 1,
      },
    ],
    sessions: [
      {
        id_hash: 'session-hash-1',
        user_id: user,
        auth_method: 'oidc',
        created_at: T,
        expires_at: T + 1000,
        last_seen_at: T + 1,
        ip: '203.0.113.5',
        user_agent: 'Mozilla/5.0',
      },
    ],
    api_tokens: [
      {
        id: 'tok_1',
        user_id: user,
        name: 'CI',
        token_hash: 'token-hash-1',
        prefix: 'pw_abcd',
        created_at: T,
        last_used_at: T + 1,
        expires_at: T + 1000,
        revoked_at: T + 2,
      },
    ],
    oauth_clients: [
      {
        id: 'cli_1',
        name: 'Claude Code',
        redirect_uris: '["http://127.0.0.1:33418/callback"]',
        created_at: T,
        last_used_at: T + 1,
      },
    ],
    oauth_grants: [
      {
        id: 'gnt_1',
        client_id: 'cli_1',
        user_id: user,
        resource: 'http://localhost:8080/mcp',
        scope: 'mcp',
        created_at: T,
        last_used_at: T + 1,
        revoked_at: T + 2,
      },
    ],
    oauth_tokens: [
      {
        token_hash: 'oauth-token-hash-1',
        grant_id: 'gnt_1',
        kind: 'refresh',
        created_at: T,
        expires_at: T + 1000,
        used_at: T + 1,
      },
    ],
    projects: [
      {
        id: 'prj_1',
        name: 'Default',
        instructions: 'Write in Vietnamese.',
        is_default: 1,
        archived_at: T + 5,
        created_by: user,
        created_at: T,
        updated_at: T + 1,
      },
    ],
    artifacts: [
      {
        id: 'art_1',
        project_id: 'prj_1',
        name: 'Bảng giá',
        kind: 'html',
        current_version_id: 'ver_2',
        latest_number: 2,
        created_by: user,
        created_at: T,
        updated_at: T + 1,
      },
    ],
    artifact_tags: [{ artifact_id: 'art_1', tag: 'pricing' }],
    artifact_views: [{ user_id: user, artifact_id: 'art_1', viewed_at: T + 3 }],
    versions: [1, 2].map((n) => ({
      id: `ver_${n}`,
      artifact_id: 'art_1',
      number: n,
      parent_version_id: n === 1 ? 'ver_0' : 'ver_1',
      entry_path: 'index.html',
      title: `Bảng giá v${n}`,
      theme_color: '#112233',
      thumbnail_path: 'thumb.png',
      file_count: 1,
      total_bytes: 5_000_000_000,
      message: `version ${n}`,
      source: n === 1 ? 'mcp' : 'restore',
      restored_from_version_id: 'ver_0',
      meta: '{"warnings":[]}',
      created_by: user,
      created_at: T + n,
    })),
    version_files: [
      {
        version_id: 'ver_1',
        path: 'index.html',
        sha256: SHA_A,
        size: 5_000_000_000,
        content_type: 'text/html',
      },
      {
        version_id: 'ver_2',
        path: 'index.html',
        sha256: SHA_B,
        size: 12,
        content_type: 'text/html',
      },
    ],
    blobs: [
      { sha256: SHA_A, size: 5_000_000_000, created_at: T },
      { sha256: SHA_B, size: 12, created_at: T },
    ],
    share_links: [
      {
        id: 'shr_1',
        artifact_id: 'art_1',
        version_id: 'ver_1',
        token_hash: 'share-hash-1',
        password_hash: 'scrypt$32768$8$1$salt$hash',
        allow_comments: 1,
        expires_at: T + 1000,
        created_by: user,
        created_at: T,
        last_used_at: T + 1,
        revoked_at: T + 2,
      },
    ],
    content_grants: [
      {
        token: 'grant-1',
        version_id: 'ver_1',
        mode: 'review',
        share_link_id: 'shr_1',
        created_at: T,
        expires_at: T + 1000,
      },
      {
        token: 'grant-2',
        version_id: 'ver_2',
        mode: 'raw',
        share_link_id: null,
        created_at: T,
        expires_at: T + 1000,
      },
    ],
    comments: [
      comment('cmt_1', {
        version_id: 'ver_1',
        status: 'resolved',
        resolved_in_version_id: 'ver_2',
      }),
      comment('cmt_2', { version_id: 'ver_2', parent_id: 'cmt_1', anchor: null, status: null }),
      comment('cmt_3', {
        version_id: 'ver_2',
        status: 'resolved',
        resolved_in_version_id: 'ver_1',
      }),
    ],
    leases: [{ name: 'job:gc', holder: 'host-1', expires_at: T + 60_000 }],
    tombstones: [
      { kind: 'artifact', key: 'art_0', deleted_at: T, expires_at: null },
      { kind: 'content_grant', key: 'grant-0', deleted_at: T, expires_at: T + 1000 },
    ],
  };
}

function comment(
  id: string,
  fields: Partial<Insertable<Database['comments']>> & { version_id: string },
): Required<Insertable<Database['comments']>> {
  return {
    id,
    artifact_id: 'art_1',
    parent_id: null,
    author_user_id: 'usr_1',
    guest_name: 'Guest',
    share_link_id: 'shr_1',
    body: `Comment ${id}`,
    anchor: '{"selector":"h1"}',
    status: 'open',
    resolved_in_version_id: null,
    resolved_by: 'usr_1',
    resolved_at: T + 4,
    created_at: T,
    updated_at: T + 1,
    edited_at: T + 2,
    ...fields,
  };
}

async function insertRows(h: DbHandle, rows: Partial<Rows>): Promise<void> {
  for (const [table, list] of Object.entries(rows)) {
    if (list.length > 0) {
      await h.db
        .insertInto(table as keyof Database)
        .values(list as never)
        .execute();
    }
  }
}

/** The names Kysely recorded as applied. */
async function recorded(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`select name from kysely_migration`.execute(db);
  return rows.map((row) => row.name).sort();
}

async function ids(h: DbHandle, table: keyof Database, column: string): Promise<unknown[]> {
  const rows = await sql<{ v: unknown }>`select ${sql.ref(column)} as v from ${sql.table(table)}`
    .execute(h.db)
    .then((r) => r.rows.map((row) => row.v));
  return rows.sort();
}

describe.each(dialects)('%s schema', (dialect) => {
  async function open(): Promise<DbHandle> {
    const h = await withDb(dialect);
    onTestFinished(() => h.close());
    return h;
  }

  async function openMigrated(): Promise<DbHandle> {
    const h = await open();
    await migrateToLatest(h);
    return h;
  }

  test('migrates an empty database and is idempotent', async () => {
    const h = await open();
    expect(await migrateToLatest(h)).toEqual(ALL_MIGRATIONS);
    expect(await migrateToLatest(h)).toEqual([]);
    const tables: (keyof Database)[] = [
      'users',
      'password_credentials',
      'passkeys',
      'sessions',
      'api_tokens',
      'oauth_clients',
      'oauth_grants',
      'oauth_tokens',
      'projects',
      'artifacts',
      'artifact_tags',
      'artifact_views',
      'versions',
      'version_files',
      'blobs',
      'content_grants',
      'share_links',
      'comments',
      'leases',
      'tombstones',
    ];
    for (const t of tables)
      await expect(h.db.selectFrom(t).selectAll().execute()).resolves.toEqual([]);
  });

  test('a failing migration leaves nothing behind', async () => {
    const h = await open();
    const broken = {
      up: async (db: MigrationDb) => {
        await db.schema.createTable('half_done').addColumn('id', 'text').execute();
        throw new Error('boom');
      },
    };
    await expect(runMigrations(h, { '0001_broken': broken })).rejects.toThrow(
      'Migration 0001_broken failed: boom',
    );
    await expect(sql`select * from half_done`.execute(h.db)).rejects.toThrow();
    expect(await migrateToLatest(h)).toEqual(ALL_MIGRATIONS);
  });

  test('a run that fails applies and records none of its migrations', async () => {
    const h = await open();
    const createTable = (name: string) => ({
      up: async (db: MigrationDb) => {
        await db.schema.createTable(name).addColumn('id', 'text').execute();
      },
    });
    const broken = {
      up: async () => {
        throw new Error('boom');
      },
    };
    await expect(
      runMigrations(h, { '0001_first': createTable('first'), '0002_second': broken }),
    ).rejects.toThrow('Migration 0002_second failed: boom');
    await expect(sql`select * from first`.execute(h.db)).rejects.toThrow();

    // Nothing was recorded either, so the next run applies both again.
    const fixed = { '0001_first': createTable('first'), '0002_second': createTable('second') };
    expect(await runMigrations(h, fixed)).toEqual(['0001_first', '0002_second']);
    expect(await recorded(h.db)).toEqual(['0001_first', '0002_second']);
  });

  test('every column in the schema types exists and round-trips', async () => {
    const h = await openMigrated();
    const rows = graph();
    await insertRows(h, rows);
    for (const [table, expected] of Object.entries(rows)) {
      const actual = await h.db
        .selectFrom(table as keyof Database)
        .selectAll()
        .execute();
      expect(actual, table).toHaveLength(expected.length);
      expect(actual, table).toEqual(expect.arrayContaining(expected as unknown[]));
    }
  });

  test('enforces foreign keys', async () => {
    const h = await openMigrated();
    const orphan = {
      id: 'art_1',
      project_id: 'prj_missing',
      name: 'Orphan',
      kind: 'html',
      latest_number: 0,
      created_at: T,
      updated_at: T,
    } as const;
    await expect(h.db.insertInto('artifacts').values(orphan).execute()).rejects.toThrow(
      /foreign key/i,
    );
  });

  test('cascades version deletion to files and grants', async () => {
    const h = await openMigrated();
    await insertRows(h, graph());
    await h.db.deleteFrom('versions').where('id', '=', 'ver_1').execute();

    expect(await ids(h, 'versions', 'id')).toEqual(['ver_2']);
    expect(await ids(h, 'version_files', 'version_id')).toEqual(['ver_2']);
    expect(await ids(h, 'content_grants', 'token')).toEqual(['grant-2']);
    // The share link pinned to the version goes; threads written on it go, replies included.
    expect(await ids(h, 'share_links', 'id')).toEqual([]);
    expect(await ids(h, 'comments', 'id')).toEqual(['cmt_3']);
    const survivor = await h.db.selectFrom('comments').selectAll().executeTakeFirstOrThrow();
    expect(survivor.resolved_in_version_id).toBeNull();
    expect(survivor.share_link_id).toBeNull();
  });

  test('deleting an artifact removes everything under it', async () => {
    const h = await openMigrated();
    await insertRows(h, graph());
    await h.db.deleteFrom('artifacts').where('id', '=', 'art_1').execute();

    for (const table of [
      'versions',
      'version_files',
      'content_grants',
      'share_links',
      'comments',
      'artifact_tags',
      'artifact_views',
    ] as const) {
      expect(await h.db.selectFrom(table).selectAll().execute(), table).toEqual([]);
    }
    expect(await ids(h, 'projects', 'id')).toEqual(['prj_1']);
    expect(await ids(h, 'blobs', 'sha256')).toEqual([SHA_A, SHA_B]);
  });

  test('deleting a user removes their credentials and keeps their content', async () => {
    const h = await openMigrated();
    await insertRows(h, graph());
    await h.db.deleteFrom('users').where('id', '=', 'usr_1').execute();

    for (const table of [
      'password_credentials',
      'passkeys',
      'sessions',
      'api_tokens',
      'oauth_grants',
      'oauth_tokens',
      'artifact_views',
    ] as const) {
      expect(await h.db.selectFrom(table).selectAll().execute(), table).toEqual([]);
    }
    expect(await ids(h, 'oauth_clients', 'id')).toEqual(['cli_1']);
    expect(await ids(h, 'projects', 'created_by')).toEqual([null]);
    expect(await ids(h, 'artifacts', 'created_by')).toEqual([null]);
    expect(await ids(h, 'versions', 'created_by')).toEqual([null, null]);
    expect(await ids(h, 'share_links', 'created_by')).toEqual([null]);
    expect(await ids(h, 'comments', 'author_user_id')).toEqual([null, null, null]);
    expect(await ids(h, 'comments', 'resolved_by')).toEqual([null, null, null]);
  });

  test('bigint columns come back as numbers', async () => {
    const h = await openMigrated();
    await h.db
      .insertInto('blobs')
      .values({ sha256: SHA_A, size: 5_000_000_000, created_at: T })
      .execute();
    const row = await h.db.selectFrom('blobs').selectAll().executeTakeFirstOrThrow();
    expect(typeof row.size).toBe('number');
    expect(row.size).toBe(5_000_000_000);
    expect(row.created_at).toBe(T);
  });

  test('migration 0002 adds tombstones and the sha256 index', async () => {
    const h = await openMigrated();
    const tombstone = {
      kind: 'share_link',
      key: 'hash-1',
      deleted_at: T,
      expires_at: null,
    } as const;
    await h.db.insertInto('tombstones').values(tombstone).execute();
    // Another kind with the same key is a different tombstone; the same pair is refused.
    await h.db
      .insertInto('tombstones')
      .values({ ...tombstone, kind: 'artifact' })
      .execute();
    await expect(h.db.insertInto('tombstones').values(tombstone).execute()).rejects.toThrow(
      /unique|duplicate/i,
    );

    const { rows } =
      dialect === 'sqlite'
        ? await sql<{ name: string; table: string }>`
            select name, tbl_name as "table" from sqlite_master where type = 'index'`.execute(h.db)
        : await sql<{ name: string; table: string }>`
            select indexname as name, tablename as "table" from pg_indexes
            where schemaname = current_schema()`.execute(h.db);
    expect(rows).toEqual(
      expect.arrayContaining([
        { name: 'tombstones_expires_at_idx', table: 'tombstones' },
        { name: 'version_files_sha256_idx', table: 'version_files' },
      ]),
    );
  });

  test('ping works while open and close can be called twice', async () => {
    const h = await open();
    await expect(h.ping()).resolves.toBeUndefined();
    await h.close();
    await expect(h.close()).resolves.toBeUndefined();
    await expect(h.ping()).rejects.toThrow();
  });
});

describe('sqlite connection', () => {
  async function tempPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'pinwall-sqlite-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    return join(dir, 'nested', 'dir', 'pinwall.db');
  }

  test('creates the parent directory and sets the pragmas', async () => {
    const h = await connectDb({ kind: 'sqlite', path: await tempPath() });
    onTestFinished(() => h.close());
    const pragma = async (name: string) =>
      Object.values((await sql.raw(`pragma ${name}`).execute(h.db)).rows[0] as object)[0];
    expect(await pragma('journal_mode')).toBe('wal');
    expect(await pragma('foreign_keys')).toBe(1);
    expect(await pragma('busy_timeout')).toBe(5000);
    expect(await pragma('synchronous')).toBe(1); // NORMAL
  });

  test('two handles on one file can both write', async () => {
    const path = await tempPath();
    const main = await connectDb({ kind: 'sqlite', path });
    onTestFinished(() => main.close());
    await migrateToLatest(main);

    // The second handle lives in a worker thread, as it would in a second process: it holds a
    // write transaction open while this thread inserts, so the insert has to wait for the lock.
    const worker = new Worker(new URL('./sqlite-writer.worker.ts', import.meta.url), {
      workerData: { path, holdMs: 300 },
    });
    onTestFinished(async () => {
      await worker.terminate();
    });
    const failed = new Promise<never>((_, reject) => worker.once('error', reject));
    failed.catch(() => {}); // raced below; marked handled so an early error is not "unhandled"
    const message = (expected: string) =>
      new Promise<void>((resolve) => {
        const onMessage = (m: unknown) => {
          if (m !== expected) return;
          worker.off('message', onMessage);
          resolve();
        };
        worker.on('message', onMessage);
      });
    const locked = message('locked');
    const done = message('done');

    await Promise.race([locked, failed]);
    await main.db
      .insertInto('leases')
      .values({ name: 'main', holder: 'main', expires_at: T })
      .execute();
    await Promise.race([done, failed]);
    expect(await ids(main, 'leases', 'name')).toEqual(['main', 'worker']);
  });

  test('two processes migrating one fresh file at once apply the schema once', async () => {
    const path = await tempPath();
    // Both processes load first, then open the new file and migrate it at the same moment.
    const migrators = [startMigrator(path), startMigrator(path)];
    await Promise.all(migrators.map((m) => m.ready));
    for (const m of migrators) m.go();
    const applied = await Promise.all(migrators.map((m) => m.applied));

    expect(applied.sort((a, b) => a.length - b.length)).toEqual([[], ALL_MIGRATIONS]);
    const h = await connectDb({ kind: 'sqlite', path });
    onTestFinished(() => h.close());
    expect(await recorded(h.db)).toEqual(ALL_MIGRATIONS);
    expect(await migrateToLatest(h)).toEqual([]);
    await expect(h.db.selectFrom('users').selectAll().execute()).resolves.toEqual([]);
  }, 30_000);
});

describe.runIf(dialects.includes('postgres'))('postgres migrations', () => {
  test('two connections migrating one fresh database at once apply the schema once', async () => {
    const database = await createPostgresDatabase();
    onTestFinished(database.drop);
    const handles = await Promise.all(
      [0, 1].map(() => connectDb({ kind: 'postgres', url: database.url, poolSize: 2 })),
    );
    onTestFinished(() => Promise.all(handles.map((h) => h.close())).then(() => {}));

    const applied = await Promise.all(handles.map((h) => migrateToLatest(h)));
    expect(applied.sort((a, b) => a.length - b.length)).toEqual([[], ALL_MIGRATIONS]);
    expect(await recorded(handles[0]?.db as Kysely<Database>)).toEqual(ALL_MIGRATIONS);
  });
});

const MIGRATOR = fileURLToPath(new URL('./sqlite-migrator.child.ts', import.meta.url));

/**
 * A separate Node process running `sqlite-migrator.child.ts` on `path`. `ready` resolves once it
 * has loaded; `go()` lets it open and migrate; `applied` is what it reports, or rejects with its
 * stderr.
 */
function startMigrator(path: string) {
  const child = spawn(process.execPath, [MIGRATOR, path]);
  onTestFinished(() => {
    child.kill();
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.startsWith('ready\n')) resolve();
    });
    exited.then(
      (code) => reject(new Error(`migrator exited (${code}) before it was ready:\n${stderr}`)),
      reject,
    );
  });
  const applied = exited.then((code) => {
    if (code !== 0) throw new Error(`migrator exited with ${code}:\n${stderr}`);
    const result = stdout.trim().split('\n').at(-1) ?? '';
    return (JSON.parse(result) as { applied: string[] }).applied;
  });
  applied.catch(() => {}); // awaited by the test; marked handled in case `ready` fails first
  return { ready, go: () => child.stdin.end('go\n'), applied };
}
