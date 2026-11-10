import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ensureSecretKey } from './config/secret-key.ts';
import type { Config } from './config/types.ts';
import { connectDb, type DbHandle } from './db/connect.ts';
import { migrateToLatest } from './db/migrate.ts';
import {
  DbLeaseManager,
  type EventBus,
  InMemoryOneTimeStore,
  InMemoryRateLimiter,
  InProcessEventBus,
  InProcessScheduler,
  type LeaseManager,
  type OneTimeStore,
  type RateLimiter,
  type Scheduler,
} from './infra/index.ts';
import { type Clock, systemClock } from './lib/clock.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { type BlobStore, createBlobStore } from './storage/index.ts';

/** Everything a request handler or service needs. Built once per process by `createDeps`. */
export interface AppDeps {
  config: Config;
  db: DbHandle;
  blobs: BlobStore;
  events: EventBus;
  oneTime: OneTimeStore;
  rateLimiter: RateLimiter;
  leases: LeaseManager;
  scheduler: Scheduler;
  logger: Logger;
  clock: Clock;
}

/**
 * Connects and migrates the database, makes sure the instance secret exists (and puts it into
 * `config.secretKey`), and builds the blob store and the in-process infrastructure. `overrides`
 * replace individual parts, mostly for tests; a given `db` is still migrated. If a step fails,
 * a database this call opened is closed again.
 */
export async function createDeps(
  config: Config,
  overrides: Partial<Omit<AppDeps, 'config'>> = {},
): Promise<AppDeps> {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const clock = overrides.clock ?? systemClock;
  const secretKey = ensureSecretKey(config, logger);
  const resolved: Config = { ...config, secretKey };

  const db = overrides.db ?? (await connectDb(resolved.database, logger));
  try {
    await migrateToLatest(db);
    const leases = overrides.leases ?? new DbLeaseManager(db, clock);
    // Unique per process, so a restarted server never takes the old one's leases for its own.
    const holder = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
    return {
      config: resolved,
      db,
      // The image root is read-only: an S3 store spools uploads under the data dir instead.
      blobs: overrides.blobs ?? createBlobStore(resolved.storage, join(resolved.dataDir, 'tmp')),
      events:
        overrides.events ??
        new InProcessEventBus((err, topic) => {
          logger.error({ err, topic }, 'An event handler failed');
        }),
      oneTime: overrides.oneTime ?? new InMemoryOneTimeStore(clock),
      rateLimiter: overrides.rateLimiter ?? new InMemoryRateLimiter(clock),
      leases,
      scheduler: overrides.scheduler ?? new InProcessScheduler(leases, logger, holder),
      logger,
      clock,
    };
  } catch (error) {
    if (!overrides.db) await db.close();
    throw error;
  }
}

/** Stops scheduled jobs (they may still need the database), then closes the database. */
export async function closeDeps(d: AppDeps): Promise<void> {
  try {
    await d.scheduler.stop();
  } finally {
    await d.db.close();
  }
}
