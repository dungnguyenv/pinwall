import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import Sqlite from 'better-sqlite3';
import {
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresDialect,
  SqliteDialect,
  type SqliteDialectConfig,
  SqliteDriver,
  sql,
  type TransactionSettings,
} from 'kysely';
import pg from 'pg';
import type { Config } from '../config/types.ts';
import type { Database } from './schema.ts';

export type DbDialect = 'sqlite' | 'postgres';

export interface DbHandle {
  db: Kysely<Database>;
  dialect: DbDialect;
  /** Closes every connection. Safe to call more than once. */
  close(): Promise<void>;
  /** Resolves when the database answers a trivial query; rejects otherwise. */
  ping(): Promise<void>;
}

// int8 (bigint) arrives as a string by default; every bigint we store (timestamps, sizes,
// counters) fits a double exactly, so parse it to a number. This is process-wide in `pg`.
pg.types.setTypeParser(20, Number);

/** How long a SQLite statement waits for another connection's lock before failing. */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Switches the file to WAL. When two processes open a new file at the same moment, SQLite can
 * refuse one of them with SQLITE_BUSY at once instead of waiting on busy_timeout; that one tries
 * again until the other has switched the file (the mode is stored in the file) or time runs out.
 */
async function enableWal(database: Sqlite.Database): Promise<void> {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      database.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'SQLITE_BUSY' || Date.now() >= deadline) {
        throw error;
      }
      await sleep(20);
    }
  }
}

/**
 * Kysely's SQLite driver begins every transaction with a plain, deferred `BEGIN`, which takes the
 * write lock only at the first write. In WAL mode a transaction that has read and then writes
 * fails at once with SQLITE_BUSY ("database is locked") if another process (`pinwall backup`
 * taking its lease, say) committed in between: its snapshot is out of date, so no busy timeout
 * can help. This driver begins with `BEGIN IMMEDIATE`, which takes the write lock up front and
 * waits for it under `busy_timeout`. A transaction started with `setAccessMode('read only')`
 * (the backup's snapshot) stays deferred, so it never holds up writers in other processes.
 */
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(
    connection: DatabaseConnection,
    settings?: TransactionSettings,
  ): Promise<void> {
    const begin = settings?.accessMode === 'read only' ? 'begin' : 'begin immediate';
    await connection.executeQuery(CompiledQuery.raw(begin));
  }
}

class ImmediateSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;

  constructor(config: SqliteDialectConfig) {
    super(config);
    this.#config = config;
  }

  override createDriver(): Driver {
    return new ImmediateSqliteDriver(this.#config);
  }
}

/**
 * Opens the configured database. `logger` receives errors that happen outside any query, such as
 * an idle Postgres connection dropped by the server. On SQLite, write transactions take the
 * write lock when they begin (see `ImmediateSqliteDriver`); a transaction that only reads should
 * say so with `setAccessMode('read only')`.
 */
export async function connectDb(
  cfg: Config['database'],
  logger?: { error(o: object, m: string): void },
): Promise<DbHandle> {
  if (cfg.kind === 'sqlite') {
    await mkdir(dirname(cfg.path), { recursive: true });
    const database = new Sqlite(cfg.path);
    try {
      // busy_timeout first, so switching to WAL waits for another connection instead of failing.
      database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      await enableWal(database);
      database.pragma('synchronous = NORMAL');
      database.pragma('foreign_keys = ON');
    } catch (error) {
      database.close();
      throw error;
    }
    return handle(
      new Kysely<Database>({ dialect: new ImmediateSqliteDialect({ database }) }),
      'sqlite',
    );
  }

  const pool = new pg.Pool({ connectionString: cfg.url, max: cfg.poolSize });
  // Without a listener, an idle client losing its connection (server restart, network blip)
  // would crash the process. The pool discards that client and the next query reconnects;
  // a lasting outage surfaces as query errors and a failing `ping()`.
  pool.on('error', (err) => {
    logger?.error({ err }, 'An idle PostgreSQL connection failed; the pool will open a new one');
  });
  return handle(new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }), 'postgres');
}

function handle(db: Kysely<Database>, dialect: DbDialect): DbHandle {
  let closing: Promise<void> | undefined;
  return {
    db,
    dialect,
    close: () => {
      closing ??= db.destroy();
      return closing;
    },
    ping: async () => {
      await sql`select 1`.execute(db);
    },
  };
}
