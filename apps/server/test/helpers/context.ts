import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { type AppEnv, buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config/load.ts';
import type { DbDialect } from '../../src/db/connect.ts';
import { type AppDeps, closeDeps, createDeps } from '../../src/deps.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { createPostgresDatabase } from './db.ts';

export interface TestContext {
  app: Hono<AppEnv>;
  deps: AppDeps;
  /**
   * Sends a request through the app. A path is resolved against the public origin; an absolute
   * URL is used as given, to play a request that reached the server under another Host.
   */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Closes the deps and removes what the context created. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * A complete app on a fresh temp data dir: migrated database (SQLite in the data dir, or a new
 * Postgres database on the test server, with a random `PINWALL_SECRET_KEY`), local blobs, a
 * silent logger unless `PINWALL_LOG_LEVEL` is given. A `PINWALL_DATA_DIR` passed in `env` is used
 * and left in place on close.
 */
export async function createTestContext(
  opts: { env?: Record<string, string>; dialect?: DbDialect; clock?: FixedClock } = {},
): Promise<TestContext> {
  const given = opts.env ?? {};
  const cleanups: (() => Promise<unknown>)[] = [];
  const cleanUp = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  };

  let deps: AppDeps;
  try {
    const env: Record<string, string> = {};
    if (given.PINWALL_DATA_DIR === undefined) {
      const dataDir = await mkdtemp(join(tmpdir(), 'pinwall-test-'));
      cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
      env.PINWALL_DATA_DIR = dataDir;
    }
    if (opts.dialect === 'postgres' && given.PINWALL_DATABASE_URL === undefined) {
      const database = await createPostgresDatabase();
      cleanups.push(database.drop);
      env.PINWALL_DATABASE_URL = database.url;
      env.PINWALL_DATABASE_POOL_SIZE = '4';
      // Postgres needs an explicit key; a `PINWALL_SECRET_KEY_FILE` in `env` replaces it.
      if (given.PINWALL_SECRET_KEY_FILE === undefined) {
        env.PINWALL_SECRET_KEY = randomBytes(32).toString('hex');
      }
    }
    Object.assign(env, given);

    const config = loadConfig(env);
    const logger = createLogger(given.PINWALL_LOG_LEVEL === undefined ? 'silent' : config.logLevel);
    deps = await createDeps(config, { logger, ...(opts.clock ? { clock: opts.clock } : {}) });
  } catch (error) {
    await cleanUp();
    throw error;
  }

  const app = buildApp(deps);
  let closing: Promise<void> | undefined;
  return {
    app,
    deps,
    request: async (path, init) => {
      const url = /^https?:\/\//.test(path) ? path : new URL(path, deps.config.publicOrigin).href;
      return app.request(url, init);
    },
    close: () => {
      closing ??= closeDeps(deps).finally(cleanUp);
      return closing;
    },
  };
}
