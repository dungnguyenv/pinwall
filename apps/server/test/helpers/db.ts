import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { connectDb, type DbDialect, type DbHandle } from '../../src/db/connect.ts';

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
  if (!postgresUrl) throw new Error('PINWALL_TEST_POSTGRES_URL is not set');
  const name = `pinwall_test_${randomBytes(8).toString('hex')}`;
  await runAsAdmin(`create database ${name}`);
  const url = new URL(postgresUrl);
  url.pathname = `/${name}`;
  const handle = await connectDb({ kind: 'postgres', url: url.href, poolSize: 4 });
  return withCleanup(handle, () => runAsAdmin(`drop database if exists ${name} with (force)`));
}

async function runAsAdmin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(statement);
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
