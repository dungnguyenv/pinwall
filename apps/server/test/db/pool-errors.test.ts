import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { connectDb } from '../../src/db/connect.ts';
import { createPostgresDatabase, dialects, runAsAdmin } from '../helpers/db.ts';

const LOSER = fileURLToPath(new URL('./pg-connection-loss.child.ts', import.meta.url));

/** What `pg-connection-loss.child.ts` reports, and how its process ended. */
interface Loss {
  code: number | null;
  stderr: string;
  report: {
    transaction: string;
    logged: { fields: object; message: string }[];
    next: number;
  } | null;
}

/** Runs `pg-connection-loss.child.ts` against `url` in `mode` until the process exits. */
function loseConnection(url: string, mode: 'query' | 'idle'): Promise<Loss> {
  const child = spawn(process.execPath, [LOSER, url, mode]);
  onTestFinished(() => {
    child.kill();
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      const line = stdout.trim().split('\n').at(-1) ?? '';
      resolve({ code, stderr, report: line.startsWith('{') ? JSON.parse(line) : null });
    });
  });
}

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

    // Once per connection, and only what the error says: pg attaches the client, which carries
    // the connection's cancel key.
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        { err: { message: 'terminating connection due to administrator command', code: '57P01' } },
        expect.any(String),
      ),
    );
    await expect(sql`select 1`.execute(h.db)).resolves.toBeDefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['during a query', 'query', { message: 'Connection terminated unexpectedly' }],
    [
      'between two statements',
      'idle',
      { message: 'terminating connection due to administrator command', code: '57P01' },
    ],
  ] as const)(
    'a connection lost %s fails its transaction, is logged once and is replaced',
    async (_when, mode, err) => {
      const database = await createPostgresDatabase();
      onTestFinished(database.drop);

      const { code, stderr, report } = await loseConnection(database.url, mode);

      // The process lives on: an error event nobody listened for would have ended it.
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(report?.transaction).toMatch(/^rejected: /);
      expect(report?.logged).toEqual([{ fields: { err }, message: expect.any(String) }]);
      expect(report?.next).toBe(1);
    },
  );
});
