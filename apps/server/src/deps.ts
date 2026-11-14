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
  InFlight,
  InMemoryOneTimeStore,
  InMemoryRateLimiter,
  InProcessEventBus,
  InProcessScheduler,
  type LeaseManager,
  LiveStreams,
  type OneTimeStore,
  type RateLimiter,
  type Scheduler,
} from './infra/index.ts';
import { type Clock, systemClock } from './lib/clock.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { createMetrics, instrumentScheduler, type Metrics } from './ops/metrics.ts';
import { ingestDeadlineMs } from './publish/ingest-slots.ts';
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
  /** Open live-update streams, which `closeDeps` ends. */
  liveStreams: LiveStreams;
  /** Work this process bounds: publishes being ingested, review pages held in memory. */
  inFlight: InFlight;
  /**
   * How long one publish may hold its place, from `PINWALL_MAX_UPLOAD_BYTES` (`ingestDeadlineMs`).
   * Tests shorten it.
   */
  ingestDeadlineMs: number;
  logger: Logger;
  clock: Clock;
  metrics: Metrics;
}

/**
 * Connects and migrates the database, makes sure the instance secret exists (and puts it into
 * `config.secretKey`), and builds the blob store and the in-process infrastructure. `overrides`
 * replace individual parts, mostly for tests; a given `db` is still migrated. With
 * `migrate: false` the schema is left as it is, for a command that must not change it
 * (`pinwall backup`). If a step fails, a database this call opened is closed again.
 */
export async function createDeps(
  config: Config,
  overrides: Partial<Omit<AppDeps, 'config'>> = {},
  options: { migrate?: boolean } = {},
): Promise<AppDeps> {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const clock = overrides.clock ?? systemClock;
  const secretKey = ensureSecretKey(config, logger);
  const resolved: Config = { ...config, secretKey };

  const db = overrides.db ?? (await connectDb(resolved.database, logger));
  try {
    // A database that cannot be reached fails here, for its own reason, not as a failed migration.
    await db.ping();
    if (options.migrate !== false) await migrateToLatest(db);
    const leases = overrides.leases ?? new DbLeaseManager(db, clock);
    const metrics = overrides.metrics ?? createMetrics(db, clock);
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
      scheduler: instrumentScheduler(
        overrides.scheduler ?? new InProcessScheduler(leases, logger, holder),
        metrics,
      ),
      liveStreams: overrides.liveStreams ?? new LiveStreams(),
      inFlight: overrides.inFlight ?? new InFlight(),
      ingestDeadlineMs:
        overrides.ingestDeadlineMs ?? ingestDeadlineMs(resolved.limits.maxUploadBytes),
      logger,
      clock,
      metrics,
    };
  } catch (error) {
    if (!overrides.db) await db.close();
    throw error;
  }
}

/**
 * Ends open live-update streams (they hold connections and check access in the database), stops
 * scheduled jobs (they may still need the database), then closes the database.
 */
export async function closeDeps(d: AppDeps): Promise<void> {
  d.liveStreams.closeAll();
  try {
    await d.scheduler.stop();
  } finally {
    await d.db.close();
  }
}
