import { sql } from 'kysely';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { connectDb } from '../../src/db/connect.ts';
import { createPostgresDatabase, dialects, runAsAdmin } from '../helpers/db.ts';

describe.runIf(dialects.includes('postgres'))('Postgres pool', () => {
  test('logs an idle connection that fails, then reconnects', async () => {
    const database = await createPostgresDatabase();
    onTestFinished(database.drop);
    const logger = { error: vi.fn() };
    const h = await connectDb({ kind: 'postgres', url: database.url, poolSize: 2 }, logger);
    onTestFinished(() => h.close());

    await h.ping(); // leaves one idle client in the pool
    const name = new URL(database.url).pathname.slice(1);
    await runAsAdmin(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${name}'`,
    );

    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.any(String),
      ),
    );
    await expect(sql`select 1`.execute(h.db)).resolves.toBeDefined();
  });
});
