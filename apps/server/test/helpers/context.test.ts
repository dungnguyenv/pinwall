import { sql } from 'kysely';
import { describe, expect, test, vi } from 'vitest';
import { createTestContext } from './context.ts';
import { dialects, runAsAdmin } from './db.ts';

describe.runIf(dialects.includes('postgres'))('a Postgres test context', () => {
  test('close() names a query that outlived its test, drops the database and fails', async () => {
    const ctx = await createTestContext({ dialect: 'postgres' });
    const { database } = ctx.deps.config;
    if (database.kind !== 'postgres') throw new Error('expected Postgres');
    const name = new URL(database.url).pathname.slice(1);
    // A request still running a query when its test ends keeps a pool connection in use.
    const outlived = sql`select pg_sleep(60)`.execute(ctx.deps.db.db);
    outlived.catch(() => {}); // asserted below
    await vi.waitFor(async () => {
      const running = await runAsAdmin(
        `select 1 from pg_stat_activity where datname = $1 and query = 'select pg_sleep(60)'`,
        [name],
      );
      expect(running).toHaveLength(1);
    });

    await expect(ctx.close()).rejects.toThrow(
      /did not close within 5000 ms.*active, waiting on Timeout\/PgSleep: select pg_sleep\(60\)/,
    );
    expect(await runAsAdmin('select 1 from pg_database where datname = $1', [name])).toEqual([]);
    // Dropping the database ended the query instead of leaving it to run on.
    await expect(outlived).rejects.toThrow();
  });
});
