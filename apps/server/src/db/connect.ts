import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import Sqlite from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely';
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

export async function connectDb(cfg: Config['database']): Promise<DbHandle> {
  if (cfg.kind === 'sqlite') {
    await mkdir(dirname(cfg.path), { recursive: true });
    const database = new Sqlite(cfg.path);
    try {
      // busy_timeout first, so switching to WAL waits for another connection instead of failing.
      database.pragma('busy_timeout = 5000');
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = NORMAL');
      database.pragma('foreign_keys = ON');
    } catch (error) {
      database.close();
      throw error;
    }
    return handle(new Kysely<Database>({ dialect: new SqliteDialect({ database }) }), 'sqlite');
  }

  const pool = new pg.Pool({ connectionString: cfg.url, max: cfg.poolSize });
  // Without a listener, an idle client losing its connection (server restart, network blip)
  // would crash the process. The pool discards that client and the next query reconnects;
  // a lasting outage surfaces as query errors and a failing `ping()`.
  pool.on('error', () => {});
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
