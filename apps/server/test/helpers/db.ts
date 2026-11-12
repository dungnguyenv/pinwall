import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { type Kysely, sql } from 'kysely';
import pg from 'pg';
import { connectDb, type DbDialect, type DbHandle } from '../../src/db/connect.ts';
import type { Database } from '../../src/db/schema.ts';

const postgresUrl = process.env.PINWALL_TEST_POSTGRES_URL;

/** The dialects DB suites run against. Postgres joins only when the test stack is configured. */
export const dialects: DbDialect[] = postgresUrl ? ['sqlite', 'postgres'] : ['sqlite'];

if (!postgresUrl) {
  console.info(
    'PINWALL_TEST_POSTGRES_URL is not set: Postgres tests skipped (pnpm test:integration).',
  );
}

/**
 * Opens an empty, unmigrated database that nobody else uses: SQLite in a fresh temp dir, or a new
 * Postgres database created from `PINWALL_TEST_POSTGRES_URL`. `close()` removes it again.
 */
export async function withDb(dialect: DbDialect): Promise<DbHandle> {
  return dialect === 'sqlite' ? openSqlite() : openPostgres();
}

async function openSqlite(): Promise<DbHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'pinwall-db-'));
  const handle = await connectDb({ kind: 'sqlite', path: join(dir, 'pinwall.db') });
  return withCleanup(handle, () => rm(dir, { recursive: true, force: true }));
}

async function openPostgres(): Promise<DbHandle> {
  const database = await createPostgresDatabase();
  try {
    const handle = await connectDb({ kind: 'postgres', url: database.url, poolSize: 4 });
    return withCleanup(handle, database.drop);
  } catch (error) {
    await database.drop();
    throw error;
  }
}

/** An empty database on the test server, made by `createPostgresDatabase`. */
export interface PostgresDatabase {
  url: string;
  /** What each connection to the database is doing, or waiting on, as one line. */
  connections(): Promise<string>;
  /** Removes the database, ending any connection still open to it. */
  drop(): Promise<void>;
}

/** Creates an empty Postgres database on the test server. */
export async function createPostgresDatabase(): Promise<PostgresDatabase> {
  if (!postgresUrl) throw new Error('PINWALL_TEST_POSTGRES_URL is not set');
  const name = `pinwall_test_${randomBytes(8).toString('hex')}`;
  await runAsAdmin(`create database ${name}`);
  const url = new URL(postgresUrl);
  url.pathname = `/${name}`;
  return {
    url: url.href,
    connections: () => describeConnections(name),
    drop: async () => {
      await runAsAdmin(`drop database if exists ${name} with (force)`);
    },
  };
}

async function describeConnections(name: string): Promise<string> {
  const rows = (await runAsAdmin(
    `select pid, state, wait_event_type || '/' || wait_event as wait, left(query, 200) as query
     from pg_stat_activity where datname = $1 order by pid`,
    [name],
  )) as { pid: number; state: string | null; wait: string | null; query: string }[];
  if (rows.length === 0) return 'none (one may still be connecting)';
  return rows
    .map(
      (r) =>
        `pid ${r.pid} ${r.state ?? 'starting'}${r.wait ? `, waiting on ${r.wait}` : ''}: ${r.query}`,
    )
    .join('; ');
}

/**
 * Runs one write on the SQLite file `path` through a connection of its own, which SQLite's
 * locks treat as another process (the server next to `pinwall backup`, say). It does not wait
 * for a lock: `busy` means a transaction holds the write lock, where a real process would wait
 * for it.
 */
export function writeElsewhere(
  path: string,
  statement: string,
  ...params: unknown[]
): 'committed' | 'busy' {
  const other = new Sqlite(path);
  try {
    other.pragma('busy_timeout = 0');
    other.prepare(statement).run(...params);
    return 'committed';
  } catch (error) {
    if ((error as { code?: unknown }).code === 'SQLITE_BUSY') return 'busy';
    throw error;
  } finally {
    other.close();
  }
}

/**
 * Connecting as the admin and each admin statement are bounded, so a test hook that creates or
 * drops a database fails with the reason (a connection that never came up, or Postgres's own
 * "canceling statement due to statement timeout") instead of hanging until the hook times out.
 * `DROP DATABASE` waits for locks and a forced checkpoint; on the test server both take
 * milliseconds.
 */
const ADMIN_CONNECT_TIMEOUT_MS = 5_000;
const ADMIN_STATEMENT_TIMEOUT_MS = 10_000;

/** Runs one statement on the test server's maintenance database and returns its rows. */
export async function runAsAdmin(statement: string, params: unknown[] = []): Promise<unknown[]> {
  const client = new pg.Client({
    connectionString: postgresUrl,
    connectionTimeoutMillis: ADMIN_CONNECT_TIMEOUT_MS,
    statement_timeout: ADMIN_STATEMENT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return (await client.query(statement, params)).rows;
  } finally {
    await client.end();
  }
}

/** Wraps `close()` so it also runs `cleanup`, once, however often it is called. */
function withCleanup(handle: DbHandle, cleanup: () => Promise<unknown>): DbHandle {
  let closing: Promise<void> | undefined;
  const close = async () => {
    try {
      await handle.close();
    } finally {
      await cleanup();
    }
  };
  return {
    ...handle,
    close: () => {
      closing ??= close();
      return closing;
    },
  };
}

/**
 * Resolves once another connection of `db`'s Postgres database waits on a row lock, or once
 * `settled` has (the work did not wait, which the caller's test then reports). At most 5 s.
 */
export async function untilWaitingOnALock(
  db: Kysely<Database>,
  settled: Promise<unknown>,
): Promise<void> {
  let done = false;
  void settled.then(() => {
    done = true;
  });
  const deadline = Date.now() + 5000;
  while (!done && Date.now() < deadline) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
    `.execute(db);
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
