import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { type FileHandle, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { sql, type Transaction } from 'kysely';
import { DEFAULT_MIGRATION_TABLE } from 'kysely/migration';
import { type Pack, pack } from 'tar-stream';
import { appliedMigrations } from '../../db/migrate.ts';
import { migrations } from '../../db/migrations/index.ts';
import type { Database } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { AppError } from '../../lib/errors.ts';
import { t } from '../../lib/i18n.ts';
import { PINWALL_VERSION } from '../../version.ts';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  type BackupTable,
  keyFingerprint,
  type Manifest,
  TABLE_KEYS,
  type TableStats,
} from './format.ts';
import { holdMaintenanceLease, type MaintenanceLease } from './lease.ts';

/** Rows read per query while a table is spooled. */
const PAGE_ROWS = 1000;

export interface BackupHooks {
  /** Runs inside the snapshot transaction, once it has read the database (tests only). */
  duringSnapshot?(): Promise<void>;
  /** Runs once the snapshot has ended, before the archive is written (tests only). */
  afterSnapshot?(): Promise<void>;
}

type Row = Record<string, unknown>;

interface StoredBlob {
  sha256: string;
  size: number;
}

/** What the snapshot read: everything the manifest needs but the archive's own facts. */
interface Snapshot {
  createdAt: number;
  migrations: string[];
  tables: Record<BackupTable, TableStats>;
  /** The blobs some version references, sorted by key. */
  blobs: StoredBlob[];
}

/**
 * Writes a self-contained backup archive (see `format.ts`) to `out` and ends it. The order is
 * what keeps it safe next to blob garbage collection:
 * 1. `BACKUP_LEASE` is taken before the snapshot, so a deletion committed after the snapshot
 *    finds it held and leaves its blobs for the sweep;
 * 2. one read transaction copies every table into a spool directory under `<data dir>/tmp`;
 * 3. the tar goes out: the manifest, each table, then each referenced blob, hashed as it is
 *    read, so a missing or altered blob fails the backup.
 *
 * Before any of it, the database's migrations must be exactly this version's: a backup never
 * migrates (see `assertSchemaMatches`). The lease is held until `out` has finished. On failure
 * the archive stream is destroyed (and `out` with it); either way the lease is released and the
 * spool removed.
 */
export async function createBackup(
  deps: AppDeps,
  out: Writable,
  hooks: BackupHooks = {},
): Promise<{ manifest: Manifest }> {
  const { secretKey } = deps.config;
  if (secretKey === null) {
    throw new Error('No secret key to fingerprint the backup with: createDeps sets one');
  }
  await assertSchemaMatches(deps);
  const lease = await holdMaintenanceLease(deps, 'backup');
  let spool: string | null = null;
  let archive: Pack | null = null;
  try {
    const tmp = join(deps.config.dataDir, 'tmp');
    await mkdir(tmp, { recursive: true });
    spool = await mkdtemp(join(tmp, 'backup-'));
    const snapshot = await takeSnapshot(deps, spool, hooks);
    await hooks.afterSnapshot?.();

    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      format_version: BACKUP_FORMAT_VERSION,
      pinwall_version: PINWALL_VERSION,
      created_at: snapshot.createdAt,
      source: { database: deps.db.dialect, storage: deps.config.storage.kind },
      migrations: snapshot.migrations,
      key_fingerprint: keyFingerprint(secretKey),
      tables: snapshot.tables,
      blobs: {
        count: snapshot.blobs.length,
        bytes: snapshot.blobs.reduce((total, blob) => total + blob.size, 0),
      },
    };
    archive = pack();
    await writeArchive(deps, { archive, out, lease, spool }, manifest, snapshot.blobs);
    return { manifest };
  } catch (error) {
    archive?.destroy(error as Error);
    throw error;
  } finally {
    await cleanUp(deps, lease, spool);
  }
}

/**
 * Refuses, saying which migration the database is at and which one this version expects, unless
 * they are the same list. An older database would have to be migrated first, under the server
 * that runs it, and its archive would no longer restore into that server's version; a newer one
 * has tables and columns this version does not know to copy. Either way the matching version
 * makes the backup.
 */
async function assertSchemaMatches(deps: AppDeps): Promise<void> {
  const applied = await appliedMigrations(deps.db);
  const expected = Object.keys(migrations);
  const isPrefix = applied.every((name, i) => name === expected[i]);
  if (isPrefix && applied.length === expected.length) return;
  const vars = {
    at: applied.at(-1) ?? 'none',
    version: PINWALL_VERSION,
    expected: expected.at(-1) ?? 'none',
  };
  const behind = isPrefix && applied.length < expected.length;
  throw new Error(t(behind ? 'backup.schemaBehind' : 'backup.schemaAhead', vars));
}

/**
 * Copies every table into `<spool>/<table>.jsonl` inside one read transaction. On Postgres that
 * is `REPEATABLE READ READ ONLY`; on SQLite in WAL mode a transaction sees the database as of its
 * first read, and other processes keep writing meanwhile. `read only` keeps it a deferred
 * transaction there: SQLite write transactions take the write lock when they begin.
 */
async function takeSnapshot(deps: AppDeps, spool: string, hooks: BackupHooks): Promise<Snapshot> {
  const { db, dialect } = deps.db;
  const read = async (trx: Transaction<Database>): Promise<Snapshot> => {
    const createdAt = deps.clock.now();
    const applied = await sql<{ name: string }>`
      select name from ${sql.table(DEFAULT_MIGRATION_TABLE)} order by name
    `.execute(trx);
    await hooks.duringSnapshot?.();
    const tables = {} as Record<BackupTable, TableStats>;
    const blobs: StoredBlob[] = [];
    for (const table of BACKUP_TABLES) {
      const onRow =
        table === 'blobs'
          ? (row: Row) => {
              const { sha256, size } = row as { sha256: string; size: number };
              blobs.push({ sha256, size });
            }
          : undefined;
      tables[table] = await spoolTable(trx, table, join(spool, `${table}.jsonl`), onRow);
    }
    blobs.sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
    return { createdAt, migrations: applied.rows.map((r) => r.name), tables, blobs };
  };
  return dialect === 'postgres'
    ? db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(read)
    : db.transaction().setAccessMode('read only').execute(read);
}

/**
 * Writes `table` to `path` as JSONL, one row per line in `TABLE_KEYS` order, reading pages of
 * `PAGE_ROWS` rows after the last key seen. Of `blobs`, only rows a version references.
 */
async function spoolTable(
  trx: Transaction<Database>,
  table: BackupTable,
  path: string,
  onRow?: (row: Row) => void,
): Promise<TableStats> {
  const keys = TABLE_KEYS[table];
  const hash = createHash('sha256');
  let rows = 0;
  let bytes = 0;
  const file = await open(path, 'wx', 0o600);
  try {
    let after: unknown[] | null = null;
    for (;;) {
      const page = await readPage(trx, table, keys, after);
      let text = '';
      for (const row of page) {
        text += `${JSON.stringify(row)}\n`;
        onRow?.(row);
      }
      const chunk = Buffer.from(text, 'utf8');
      hash.update(chunk);
      await writeAll(file, chunk);
      rows += page.length;
      bytes += chunk.length;
      const last = page.at(-1);
      if (page.length < PAGE_ROWS || last === undefined) break;
      after = keys.map((key) => last[key]);
    }
  } finally {
    await file.close();
  }
  return { rows, bytes, sha256: hash.digest('hex') };
}

/** Up to `PAGE_ROWS` rows of `table` whose key comes after `after` (from the start when null). */
async function readPage(
  trx: Transaction<Database>,
  table: BackupTable,
  keys: readonly string[],
  after: unknown[] | null,
): Promise<Row[]> {
  const key = sql.join(keys.map((k) => sql.ref(k)));
  const conditions = [];
  if (table === 'blobs') {
    // Unreferenced blobs are garbage the sweep has not reached yet; restoring them is pointless.
    conditions.push(
      sql`exists (select 1 from version_files where version_files.sha256 = blobs.sha256)`,
    );
  }
  if (after !== null) conditions.push(sql`(${key}) > (${sql.join(after)})`);
  const where = conditions.length === 0 ? sql`` : sql`where ${sql.join(conditions, sql` and `)}`;
  const { rows } = await sql<Row>`
    select * from ${sql.table(table)} ${where} order by ${key} limit ${PAGE_ROWS}
  `.execute(trx);
  return rows;
}

async function writeAll(file: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(chunk, offset);
    offset += bytesWritten;
  }
}

interface ArchiveTarget {
  archive: Pack;
  out: Writable;
  lease: MaintenanceLease;
  spool: string;
}

/** Packs the manifest, the spooled tables and the blobs into `out`; resolves once it finished. */
async function writeArchive(
  deps: AppDeps,
  { archive, out, lease, spool }: ArchiveTarget,
  manifest: Manifest,
  blobs: StoredBlob[],
): Promise<void> {
  const mtime = new Date(manifest.created_at);
  // A failure reaches us through the entries and `out`; these keep it from also being thrown
  // as an unhandled 'error' event or rejection meanwhile.
  archive.on('error', () => {});
  const outFinished = finished(out, { readable: false });
  outFinished.catch(() => {});
  archive.pipe(out);

  lease.assertHeld();
  const manifestJson = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await addEntry(archive, { name: 'manifest.json', size: manifestJson.length, mtime }, [
    manifestJson,
  ]);
  for (const table of BACKUP_TABLES) {
    lease.assertHeld();
    const file = createReadStream(join(spool, `${table}.jsonl`));
    try {
      const header = { name: `tables/${table}.jsonl`, size: manifest.tables[table].bytes, mtime };
      await addEntry(archive, header, file);
    } finally {
      file.destroy();
    }
  }
  for (const blob of blobs) {
    lease.assertHeld();
    await addBlob(deps, archive, blob, mtime);
  }
  archive.finalize();
  await outFinished;
}

/** Adds `blobs/<sha256>`, checking the stored bytes against their key as they stream through. */
async function addBlob(deps: AppDeps, archive: Pack, blob: StoredBlob, mtime: Date) {
  const bad = () => new Error(t('backup.blobBad', { sha: blob.sha256 }));
  let body: Readable;
  try {
    body = await deps.blobs.get(blob.sha256);
  } catch (error) {
    throw error instanceof AppError && error.code === 'not_found' ? bad() : error;
  }
  const hash = createHash('sha256');
  let bytes = 0;
  async function* checked(): AsyncGenerator<Buffer> {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      // The tar header already promised `size` bytes; more would corrupt the archive.
      if (bytes > blob.size) throw bad();
      hash.update(chunk);
      yield chunk;
    }
  }
  try {
    const header = { name: `blobs/${blob.sha256}`, size: blob.size, mtime };
    await addEntry(archive, header, checked(), () => {
      // Before the entry is closed, so a bad blob never becomes a complete archive entry.
      if (bytes !== blob.size || hash.digest('hex') !== blob.sha256) throw bad();
    });
  } finally {
    body.destroy();
  }
}

/**
 * Streams `body` into a new file entry of exactly `size` bytes, waiting whenever the archive is
 * backed up. `verify` runs after the last byte and before the entry is closed; whatever it
 * throws leaves the entry unfinished. Resolves once the entry is complete.
 */
async function addEntry(
  archive: Pack,
  header: { name: string; size: number; mtime: Date },
  body: AsyncIterable<Buffer> | Iterable<Buffer>,
  verify?: () => void,
): Promise<void> {
  let settle: (err?: Error | null) => void = () => {};
  const added = new Promise<void>((resolve, reject) => {
    settle = (err) => (err ? reject(err) : resolve());
  });
  // Settles when the entry is complete, or with the error that ended it (the archive or `out`
  // failing); it is awaited below, and caught here so an early failure is never unhandled.
  added.catch(() => {});
  const sink = archive.entry({ ...header, type: 'file', mode: 0o644 }, (err) => settle(err));
  sink.on('error', () => {});
  for await (const chunk of body) {
    if (!sink.write(chunk)) await Promise.race([once(sink, 'drain'), added]);
  }
  verify?.();
  sink.end(null); // no last chunk
  await added;
}

/** Releases the lease and removes the spool. Failures are logged: they must not hide the result. */
async function cleanUp(deps: AppDeps, lease: MaintenanceLease, spool: string | null) {
  try {
    await lease.release();
  } catch (err) {
    deps.logger.warn({ err }, 'Could not release the maintenance lease; it expires by itself');
  }
  if (spool === null) return;
  try {
    await rm(spool, { recursive: true, force: true });
  } catch (err) {
    deps.logger.warn({ err, spool }, 'Could not remove the backup spool directory');
  }
}
