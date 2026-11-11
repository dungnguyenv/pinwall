import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import { type Kysely, sql, type Transaction } from 'kysely';
import { type Extract, extract } from 'tar-stream';
import { extractVersionText } from '../../content/metadata.ts';
import type { DbDialect } from '../../db/connect.ts';
import { migrations } from '../../db/migrations/index.ts';
import type { Database } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { getTags } from '../../domain/artifacts.ts';
import { DEFAULT_PROJECT_ID } from '../../domain/projects.ts';
import { indexArtifact } from '../../domain/search.ts';
import { AppError } from '../../lib/errors.ts';
import { t } from '../../lib/i18n.ts';
import { isSha256 } from '../../storage/blob-store.ts';
import type { BlobStore } from '../../storage/index.ts';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  type BackupTable,
  keyFingerprint,
  type Manifest,
  ManifestSchema,
  type TableStats,
} from './format.ts';
import { holdMaintenanceLease, type MaintenanceLease } from './lease.ts';

/** A larger first entry is not a manifest this program wrote. */
const MANIFEST_MAX_BYTES = 1024 * 1024;
/** Bound values per insert statement: under SQLite's 32 766 and Postgres' 65 535. */
const INSERT_VALUES_MAX = 30_000;
/** How much of a stray entry name an error message repeats. */
const NAME_SHOWN_CHARS = 100;

/** A restore that did not happen. Its message is what the CLI prints. */
export class RestoreError extends Error {
  override readonly name = 'RestoreError';
}

export interface RestoreHooks {
  /** Runs once the archive is verified and its files stored, before any row goes in (tests only). */
  beforeInsert?(): Promise<void>;
}

export interface RestoreSummary {
  manifest: Manifest;
  /** What the operator must know about the restored installation, ready to print. */
  warnings: string[];
}

type Row = Record<string, unknown>;

/** One file of the archive: its tar header and a stream of its bytes. */
type Entry = Extract extends AsyncIterable<infer E> ? E : never;

/** How `restore.notEmpty` names what a table holds: singular, plural. */
const NOUNS: Record<BackupTable, readonly [string, string]> = {
  users: ['user', 'users'],
  password_credentials: ['password', 'passwords'],
  passkeys: ['passkey', 'passkeys'],
  sessions: ['session', 'sessions'],
  api_tokens: ['API token', 'API tokens'],
  oauth_clients: ['OAuth client', 'OAuth clients'],
  oauth_grants: ['OAuth grant', 'OAuth grants'],
  oauth_tokens: ['OAuth token', 'OAuth tokens'],
  projects: ['project', 'projects'],
  artifacts: ['artifact', 'artifacts'],
  artifact_tags: ['tag', 'tags'],
  artifact_views: ['view', 'views'],
  versions: ['version', 'versions'],
  version_files: ['version file', 'version files'],
  blobs: ['stored file record', 'stored file records'],
  share_links: ['share link', 'share links'],
  content_grants: ['content grant', 'content grants'],
  comments: ['comment', 'comments'],
  tombstones: ['deletion record', 'deletion records'],
};
const STORED_FILES = ['stored file', 'stored files'] as const;

const damaged = (detail: string) => new RestoreError(t('restore.damaged', { detail }));
const notBackup = () => new RestoreError(t('restore.notBackup'));

/**
 * Throws `restore.notEmpty`, listing what it found, unless the target is empty: no row in any
 * backed-up table but the default project a server creates when it first starts, and nothing in
 * the blob store.
 */
export async function assertEmptyTarget(deps: AppDeps): Promise<void> {
  const found = await targetContents(deps.db.db, deps.blobs, {
    defaultProject: true,
    blobs: new Set(),
  });
  if (found.length > 0) {
    throw new RestoreError(t('restore.notEmpty', { found: found.join(', ') }));
  }
}

/**
 * Restores a backup archive (see `format.ts`), plain or gzip-compressed, into the empty
 * installation `deps` opens, whatever its database and blob store:
 * 1. under `BACKUP_LEASE`, it checks the target is empty;
 * 2. it reads the archive once: the manifest first, then each table into a spool directory
 *    under `<data dir>/tmp`, checked against the manifest, and each blob into the store, which
 *    verifies it against its key;
 * 3. it checks every row against the target's columns, the row counts, and that each version's
 *    files arrived;
 * 4. one transaction then inserts every row and rebuilds the search index.
 *
 * Nothing is written to the database before the whole archive has been verified. When the secret
 * key differs from the backup's, IdP refresh tokens (the only values sealed with it) are dropped
 * and a warning says who must sign in again. If anything fails, the blobs it stored are deleted,
 * so the same target can take the archive again; the error is a `RestoreError`.
 */
export async function restoreBackup(
  deps: AppDeps,
  input: Readable,
  hooks: RestoreHooks = {},
): Promise<RestoreSummary> {
  const { secretKey } = deps.config;
  if (secretKey === null) {
    throw new Error("No secret key to compare with the backup's: createDeps sets one");
  }
  const lease = await holdMaintenanceLease(deps, 'restore');
  const written = new Set<string>();
  let spool: string | null = null;
  let archive: ArchiveReader | null = null;
  try {
    await assertEmptyTarget(deps);
    const tmp = join(deps.config.dataDir, 'tmp');
    await mkdir(tmp, { recursive: true });
    spool = await mkdtemp(join(tmp, 'restore-'));
    archive = await openArchive(input);
    const manifest = await unpack(deps, archive, { lease, spool, written });
    const columns = await tableColumns(deps.db.db);
    await verifyRows(manifest, { spool, columns, written });

    lease.assertHeld();
    await hooks.beforeInsert?.();
    const keyChanged = manifest.key_fingerprint !== keyFingerprint(secretKey);
    const cleared = await insertEverything(deps, { lease, spool, columns, written, keyChanged });
    const warnings = cleared > 0 ? [t('restore.keyChanged', { count: cleared })] : [];
    return { manifest, warnings };
  } catch (error) {
    archive?.close();
    await removeBlobs(deps, written);
    throw asRestoreError(error);
  } finally {
    await cleanUp(deps, lease, spool);
  }
}

/** Counts like "2 users" for whatever the target holds; empty when it holds nothing. */
async function targetContents(
  db: Kysely<Database>,
  blobs: BlobStore,
  ignore: { defaultProject: boolean; blobs: ReadonlySet<string> },
): Promise<string[]> {
  const found: string[] = [];
  for (const table of BACKUP_TABLES) {
    const where =
      ignore.defaultProject && table === 'projects'
        ? sql`where id <> ${DEFAULT_PROJECT_ID}`
        : sql``;
    const { rows } = await sql<{ n: number | string }>`
      select count(*) as n from ${sql.table(table)} ${where}
    `.execute(db);
    found.push(...counted(Number(rows[0]?.n ?? 0), NOUNS[table]));
  }
  let stored = 0;
  for await (const key of blobs.list()) {
    if (!ignore.blobs.has(key)) stored += 1;
  }
  found.push(...counted(stored, STORED_FILES));
  return found;
}

function counted(n: number, [one, other]: readonly [string, string]): string[] {
  return n === 0 ? [] : [`${n} ${n === 1 ? one : other}`];
}

/** The entries of a tar archive, read once from the input as they are asked for. */
interface ArchiveReader {
  /** The next entry, or null after the last. Read each one's `body` to its end first. */
  next(): Promise<Entry | null>;
  /** The bytes of `entry`. */
  body(entry: Entry): AsyncIterable<Buffer>;
  /** Stops reading and lets go of the input. */
  close(): void;
}

/**
 * Starts reading `input` as a tar archive, through gunzip when it begins with the gzip magic
 * bytes. A failure while reading surfaces from `next` or `body` as the input's own error when
 * the input failed, and as `the archive ends early` when its bytes are not a whole archive.
 */
async function openArchive(input: Readable): Promise<ArchiveReader> {
  const chunks = input[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  let inputFailure: { error: unknown } | null = null;
  const pull = async (): Promise<Buffer | null> => {
    let result: IteratorResult<Buffer | string>;
    try {
      result = await chunks.next();
    } catch (error) {
      inputFailure = { error };
      throw error;
    }
    if (result.done) return null;
    return Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value);
  };

  const head: Buffer[] = [];
  let peeked = 0;
  while (peeked < 2) {
    const chunk = await pull();
    if (chunk === null) break;
    head.push(chunk);
    peeked += chunk.length;
  }
  const start = Buffer.concat(head);
  const gzipped = start[0] === 0x1f && start[1] === 0x8b;
  async function* bytes(): AsyncGenerator<Buffer> {
    try {
      yield* head;
      for (let chunk = await pull(); chunk !== null; chunk = await pull()) yield chunk;
    } finally {
      await chunks.return?.();
    }
  }

  const extractor = extract();
  const entries = extractor[Symbol.asyncIterator]();
  const raw = Readable.from(bytes(), { objectMode: false });
  const feed = async (data: AsyncIterable<Buffer>) => {
    for await (const chunk of data) {
      if (!extractor.write(chunk)) await drained(extractor);
    }
    extractor.end(null); // no last chunk
  };
  const feeding = gzipped ? pipeline(raw, createGunzip(), feed) : pipeline(raw, feed);
  // A gunzip or input failure reaches the reader through the extractor.
  feeding.catch((error: unknown) => {
    extractor.destroy(error instanceof Error ? error : new Error(String(error)));
  });

  // The extractor's own error ("Unexpected end of data") says nothing an operator can act on.
  const failure = (): unknown =>
    inputFailure !== null ? inputFailure.error : damaged('the archive ends early');
  return {
    async next() {
      let result: IteratorResult<Entry>;
      try {
        result = await entries.next();
      } catch {
        throw failure();
      }
      return result.done ? null : result.value;
    },
    async *body(entry) {
      try {
        for await (const chunk of entry) yield chunk as Buffer;
      } catch {
        throw failure();
      }
    },
    close() {
      raw.destroy();
      extractor.destroy();
      input.destroy();
    },
  };
}

/** Resolves once `w` takes writes again; rejects once it has been destroyed instead. */
function drained(w: Extract): Promise<void> {
  const closed = () => new Error('The archive reader was closed');
  if (w.destroyed) return Promise.reject(closed());
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      off();
      resolve();
    };
    const onClose = () => {
      off();
      reject(closed());
    };
    const off = () => {
      w.off('drain', onDrain);
      w.off('close', onClose);
    };
    w.on('drain', onDrain);
    w.on('close', onClose);
  });
}

interface UnpackTarget {
  lease: MaintenanceLease;
  spool: string;
  /** Every blob key stored so far. */
  written: Set<string>;
}

/**
 * Reads the whole archive: checks the manifest, spools each table and checks it against the
 * manifest, and stores each blob (the store checks it against its key). Returns the manifest
 * once every table and blob it lists has arrived, and nothing else.
 */
async function unpack(
  deps: AppDeps,
  archive: ArchiveReader,
  { lease, spool, written }: UnpackTarget,
): Promise<Manifest> {
  lease.assertHeld();
  const first = await archive.next();
  if (first === null) throw damaged('manifest.json is missing');
  if (first.header.name !== 'manifest.json' || first.header.type !== 'file') {
    throw damaged('manifest.json must come first');
  }
  const manifest = await readManifest(archive, first);

  const tables = new Set<BackupTable>();
  let blobCount = 0;
  let blobBytes = 0;
  for (;;) {
    lease.assertHeld();
    const entry = await archive.next();
    if (entry === null) break;
    const { name, type } = entry.header;
    const size = entry.header.size;
    const table = type === 'file' ? tableOf(name) : null;
    if (table !== null && !tables.has(table)) {
      tables.add(table);
      await spoolTable(archive, entry, join(spool, `${table}.jsonl`), manifest.tables[table]);
      continue;
    }
    const sha256 = type === 'file' ? blobOf(name) : null;
    if (sha256 !== null && !written.has(sha256)) {
      // Recorded first: a store that fails after the object landed still gets it deleted.
      written.add(sha256);
      await storeBlob(deps, archive, entry, sha256, size);
      blobCount += 1;
      blobBytes += size;
      continue;
    }
    throw damaged(`unexpected entry "${printable(name.slice(0, NAME_SHOWN_CHARS))}"`);
  }

  for (const table of BACKUP_TABLES) {
    if (!tables.has(table)) throw damaged(`${tableEntry(table)} is missing`);
  }
  if (blobCount !== manifest.blobs.count) {
    throw damaged(`expected ${manifest.blobs.count} blobs, found ${blobCount}`);
  }
  if (blobBytes !== manifest.blobs.bytes) {
    throw damaged(`expected ${manifest.blobs.bytes} bytes of blobs, found ${blobBytes}`);
  }
  return manifest;
}

/**
 * The manifest in `entry`, checked in this order: a Pinwall backup at all, a format this version
 * reads, a well-formed manifest, and migrations this version has.
 */
async function readManifest(archive: ArchiveReader, entry: Entry): Promise<Manifest> {
  if (entry.header.size > MANIFEST_MAX_BYTES) throw notBackup();
  const parts: Buffer[] = [];
  for await (const chunk of archive.body(entry)) parts.push(chunk);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw notBackup();
  }
  if (!isObject(parsed) || parsed.format !== BACKUP_FORMAT) throw notBackup();
  const version = parsed.format_version;
  if (typeof version === 'number' && version > BACKUP_FORMAT_VERSION) {
    throw new RestoreError(t('restore.newerFormat', { version }));
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) throw notBackup();
  const manifest = result.data;

  const known = Object.keys(migrations);
  const diverges = manifest.migrations.findIndex((name, i) => known[i] !== name);
  if (diverges !== -1) {
    const rest = manifest.migrations.slice(diverges);
    const unknown = rest.filter((name) => !known.includes(name));
    const names = (unknown.length > 0 ? unknown : rest).map((name) => printable(name));
    throw new RestoreError(t('restore.unknownMigrations', { names: names.join(', ') }));
  }
  return manifest;
}

function tableEntry(table: BackupTable): string {
  return `tables/${table}.jsonl`;
}

/** The table a `tables/<table>.jsonl` entry holds, or null for any other name. */
function tableOf(name: string): BackupTable | null {
  const table = BACKUP_TABLES.find((candidate) => tableEntry(candidate) === name);
  return table ?? null;
}

/** The key of a `blobs/<sha256>` entry, or null for any other name. */
function blobOf(name: string): string | null {
  if (!name.startsWith('blobs/')) return null;
  const key = name.slice('blobs/'.length);
  return isSha256(key) ? key : null;
}

/** Copies a table entry into the spool, failing unless it is exactly what the manifest lists. */
async function spoolTable(
  archive: ArchiveReader,
  entry: Entry,
  path: string,
  expected: TableStats,
): Promise<void> {
  const mismatch = () => damaged(`${entry.header.name} does not match its checksum`);
  const hash = createHash('sha256');
  let bytes = 0;
  async function* checked(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      bytes += chunk.length;
      // Stop at once rather than spool an entry that can no longer match.
      if (bytes > expected.bytes) throw mismatch();
      hash.update(chunk);
      yield chunk;
    }
  }
  await pipeline(
    archive.body(entry),
    checked,
    createWriteStream(path, { flags: 'wx', mode: 0o600 }),
  );
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) throw mismatch();
}

/** Streams a blob entry into the store, which refuses bytes that do not hash to its key. */
async function storeBlob(
  deps: AppDeps,
  archive: ArchiveReader,
  entry: Entry,
  sha256: string,
  size: number,
): Promise<void> {
  try {
    await deps.blobs.put(sha256, Readable.from(archive.body(entry), { objectMode: false }), size);
  } catch (error) {
    // The entry delivers exactly its `size` bytes, so a refusal means they hash to another key.
    if (error instanceof AppError && error.code === 'bad_request') {
      throw damaged(`blob ${sha256} does not match its SHA-256`);
    }
    throw error;
  }
}

/** The columns each backed-up table has in the target, which is migrated to this version. */
async function tableColumns(db: Kysely<Database>): Promise<Map<BackupTable, ReadonlySet<string>>> {
  const found = await db.introspection.getTables();
  const columns = new Map<BackupTable, ReadonlySet<string>>();
  for (const table of BACKUP_TABLES) {
    const meta = found.find((candidate) => candidate.name === table);
    if (meta === undefined) throw new Error(`The database has no table ${table}`);
    columns.set(table, new Set(meta.columns.map((column) => column.name)));
  }
  return columns;
}

function columnsOf(
  columns: Map<BackupTable, ReadonlySet<string>>,
  table: BackupTable,
): ReadonlySet<string> {
  const found = columns.get(table);
  if (found === undefined) throw new Error(`No columns known for ${table}`);
  return found;
}

/**
 * Reads every spooled table before anything is written: each line must be a row of the
 * target's columns, each table must hold the rows the manifest counts, and every file a version
 * lists must be a stored blob.
 */
async function verifyRows(
  manifest: Manifest,
  {
    spool,
    columns,
    written,
  }: {
    spool: string;
    columns: Map<BackupTable, ReadonlySet<string>>;
    written: ReadonlySet<string>;
  },
): Promise<void> {
  for (const table of BACKUP_TABLES) {
    let rows = 0;
    for await (const row of spooledRows(spool, table, columnsOf(columns, table))) {
      rows += 1;
      if (table === 'version_files') {
        const sha256 = String(row.sha256);
        if (!written.has(sha256)) throw damaged(`blobs/${printable(sha256)} is missing`);
      }
    }
    if (rows !== manifest.tables[table].rows) {
      throw damaged(`${tableEntry(table)} does not match its checksum`);
    }
  }
}

/** The rows of a spooled table, each checked to be an object of `columns` and plain values. */
async function* spooledRows(
  spool: string,
  table: BackupTable,
  columns: ReadonlySet<string>,
): AsyncGenerator<Row> {
  const name = tableEntry(table);
  let line = 0;
  for await (const text of lines(join(spool, `${table}.jsonl`))) {
    line += 1;
    const bad = () => damaged(`${name} line ${line} is not a row`);
    let row: unknown;
    try {
      row = JSON.parse(text);
    } catch {
      throw bad();
    }
    if (!isObject(row) || Object.keys(row).length === 0) throw bad();
    for (const [column, value] of Object.entries(row)) {
      if (!columns.has(column)) {
        throw damaged(
          `${name} line ${line} has unknown column ${printable(column.slice(0, NAME_SHOWN_CHARS))}`,
        );
      }
      const plain =
        value === null ||
        typeof value === 'string' ||
        (typeof value === 'number' && Number.isFinite(value));
      if (!plain) throw bad();
    }
    yield row;
  }
}

/** The lines of a UTF-8 file, without their `\n`. */
async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of createReadStream(path)) {
    const parts = (rest + decoder.write(chunk as Buffer)).split('\n');
    rest = parts.pop() ?? '';
    yield* parts;
  }
  rest += decoder.end();
  if (rest !== '') yield rest;
}

interface InsertSource {
  lease: MaintenanceLease;
  spool: string;
  columns: Map<BackupTable, ReadonlySet<string>>;
  written: ReadonlySet<string>;
  /** The target's secret key is not the backup's: IdP refresh tokens are dropped. */
  keyChanged: boolean;
}

/**
 * In one transaction: makes sure the target is still empty, inserts every spooled row, and
 * rebuilds the search index. Returns how many users lost their IdP refresh token.
 */
async function insertEverything(deps: AppDeps, source: InsertSource): Promise<number> {
  const { db, dialect } = deps.db;
  return db.transaction().execute(async (trx) => {
    await takeTarget(trx, dialect);
    const found = await targetContents(trx, deps.blobs, {
      defaultProject: false,
      blobs: source.written,
    });
    if (found.length > 0) throw new RestoreError(t('restore.changed'));

    let cleared = 0;
    const sealed = (row: Row): Row => {
      const token = row.idp_refresh_token;
      if (!source.keyChanged || token === null || token === undefined) return row;
      // Sealed with a key this installation does not have: unreadable, so dropped. Clearing the
      // check time too makes the person sign in again, rather than wait out the last check.
      cleared += 1;
      return { ...row, idp_refresh_token: null, idp_checked_at: null };
    };
    for (const table of BACKUP_TABLES) {
      const columns = columnsOf(source.columns, table);
      const rows = () => spooledRows(source.spool, table, columns);
      if (table === 'users') {
        await insertRows(trx, table, columns.size, mapRows(rows(), sealed));
      } else if (table === 'comments') {
        // Replies point at their thread's root, which must be there first.
        const isRoot = (row: Row) => row.parent_id === null || row.parent_id === undefined;
        await insertRows(trx, table, columns.size, filterRows(rows(), isRoot));
        await insertRows(
          trx,
          table,
          columns.size,
          filterRows(rows(), (row) => !isRoot(row)),
        );
      } else {
        await insertRows(trx, table, columns.size, rows());
      }
    }

    await rebuildSearch(deps, trx);
    // Committing after the lease passed on could race whoever holds it now.
    source.lease.assertHeld();
    return cleared;
  });
}

/**
 * Makes the target the restore's until it commits: on Postgres every backed-up table is locked
 * against writers (readers go on), so nothing lands between the check and the rows. Then the
 * default project a first start created is deleted, unless an artifact already uses it; on
 * SQLite this write is what takes the database's write lock.
 */
async function takeTarget(trx: Transaction<Database>, dialect: DbDialect): Promise<void> {
  if (dialect === 'postgres') {
    const tables = sql.join(BACKUP_TABLES.map((table) => sql.table(table)));
    await sql`lock table ${tables} in exclusive mode`.execute(trx);
  }
  await trx
    .deleteFrom('projects')
    .where('id', '=', DEFAULT_PROJECT_ID)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(selectFrom('artifacts').select('id').where('project_id', '=', DEFAULT_PROJECT_ID)),
      ),
    )
    .execute();
}

async function* mapRows(rows: AsyncIterable<Row>, map: (row: Row) => Row): AsyncGenerator<Row> {
  for await (const row of rows) yield map(row);
}

async function* filterRows(
  rows: AsyncIterable<Row>,
  keep: (row: Row) => boolean,
): AsyncGenerator<Row> {
  for await (const row of rows) if (keep(row)) yield row;
}

/** Inserts `rows` into `table` in statements of at most `INSERT_VALUES_MAX` values. */
async function insertRows(
  trx: Transaction<Database>,
  table: BackupTable,
  columnCount: number,
  rows: AsyncIterable<Row>,
): Promise<void> {
  const perStatement = Math.max(1, Math.floor(INSERT_VALUES_MAX / columnCount));
  let batch: Row[] = [];
  for await (const row of rows) {
    batch.push(row);
    if (batch.length === perStatement) {
      await insertBatch(trx, table, batch);
      batch = [];
    }
  }
  if (batch.length > 0) await insertBatch(trx, table, batch);
}

/**
 * One multi-row insert of the columns the rows carry. A column the archive lacks (a backup made
 * before a later migration added it) takes the table's default.
 */
async function insertBatch(
  trx: Transaction<Database>,
  table: BackupTable,
  rows: Row[],
): Promise<void> {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const values = rows.map((row) => sql`(${sql.join(columns.map((c) => row[c] ?? null))})`);
  await sql`
    insert into ${sql.table(table)} (${sql.join(columns.map((c) => sql.ref(c)))})
    values ${sql.join(values)}
  `.execute(trx);
}

/** Indexes every artifact that has a current version, inside the restore's transaction. */
async function rebuildSearch(deps: AppDeps, trx: Transaction<Database>): Promise<void> {
  // On SQLite the transaction holds the only connection: every read must go through `trx`.
  const txDeps: AppDeps = { ...deps, db: { ...deps.db, db: trx } };
  const scope = { db: trx, dialect: deps.db.dialect };
  const artifacts = await trx
    .selectFrom('artifacts')
    .selectAll()
    .where('current_version_id', 'is not', null)
    .execute();
  for (const artifact of artifacts) {
    if (artifact.current_version_id === null) continue;
    const text = await extractVersionText(txDeps, artifact.current_version_id);
    await indexArtifact(scope, artifact, await getTags(trx, artifact.id), text);
  }
}

/** Deletes the blobs a failed restore stored. Failures are logged; the error that ended it stands. */
async function removeBlobs(deps: AppDeps, written: ReadonlySet<string>): Promise<void> {
  for (const sha256 of written) {
    try {
      await deps.blobs.delete(sha256);
    } catch (err) {
      deps.logger.warn({ err, sha256 }, 'Could not remove a file a failed restore had stored');
    }
  }
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
    deps.logger.warn({ err, spool }, 'Could not remove the restore spool directory');
  }
}

/** `error` as the `RestoreError` the caller gets: a failure of the target or the input as is. */
function asRestoreError(error: unknown): RestoreError {
  if (error instanceof RestoreError) return error;
  return new RestoreError(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

function isObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `text` safe to print on a terminal: control and format characters become `\u{…}`. */
function printable(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (c) => `\\u{${c.codePointAt(0)?.toString(16) ?? ''}}`);
}
