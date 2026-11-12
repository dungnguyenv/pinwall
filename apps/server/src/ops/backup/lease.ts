import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Kysely, Transaction } from 'kysely';
import type { Config } from '../../config/types.ts';
import { connectDb } from '../../db/connect.ts';
import type { Database } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { BACKUP_LEASE } from '../../domain/blobs.ts';
import { DbLeaseManager, type LeaseManager } from '../../infra/index.ts';
import { conflict } from '../../lib/errors.ts';
import { t } from '../../lib/i18n.ts';

/** How long the lease lasts without a renewal. */
export const MAINTENANCE_LEASE_TTL_MS = 600_000;
/** How often a holder renews it. */
export const MAINTENANCE_LEASE_RENEW_MS = 60_000;

/** `BACKUP_LEASE`, held by a backup or a restore for as long as it runs. */
export interface MaintenanceLease {
  /** Throws once the lease may have passed to someone else; call it before each step. */
  assertHeld(): void;
  /**
   * Runs `work` in a write transaction of `db`, renewing the lease all along. On SQLite the
   * transaction holds the database's write lock, so the lease's own connection could not write
   * until it ends (and nobody else can take the lease meanwhile): the renewals go through the
   * transaction instead, and commit with it.
   */
  writeTransaction<T>(
    db: Kysely<Database>,
    work: (trx: Transaction<Database>) => Promise<T>,
  ): Promise<T>;
  /** Stops renewing, frees the lease and closes its connection. */
  release(): Promise<void>;
}

/**
 * Takes `BACKUP_LEASE` for a backup or a restore and keeps renewing it until `release`. While it
 * is held, blob garbage collection deletes nothing, and a second backup or restore is refused
 * with 409. The lease counts as lost once a renewal fails or is refused, and once its term has
 * run out without one; `assertHeld` then throws.
 *
 * The lease has a database connection of its own. The job holds its own connection for as long
 * as a snapshot or an insert lasts, which can be more than the lease's term, and with SQLite or a
 * Postgres pool of one it is the only one: a renewal sent through it would wait for the job.
 */
export async function holdMaintenanceLease(
  deps: AppDeps,
  role: 'backup' | 'restore',
): Promise<MaintenanceLease> {
  const { clock, logger } = deps;
  const holder = `${role}:${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  const connection = await connectDb(oneConnection(deps.config.database), logger);
  const own = new DbLeaseManager(connection, clock);
  // The lease ends at or after this: the database counts its term from a later moment.
  let heldUntil = clock.now() + MAINTENANCE_LEASE_TTL_MS;
  try {
    if (!(await own.acquire(BACKUP_LEASE, holder, MAINTENANCE_LEASE_TTL_MS))) {
      throw conflict(t('backup.busy'));
    }
  } catch (error) {
    await connection.close();
    throw error;
  }

  let lost = false;
  /** Where renewals go: the lease's own connection, or the job's SQLite write transaction. */
  let through: LeaseManager | null = own;
  let renewing: Promise<void> | null = null;
  const renew = async (leases: LeaseManager) => {
    const requestedAt = clock.now();
    try {
      if (await leases.renew(BACKUP_LEASE, holder, MAINTENANCE_LEASE_TTL_MS)) {
        heldUntil = requestedAt + MAINTENANCE_LEASE_TTL_MS;
      } else {
        lost = true;
      }
    } catch (err) {
      lost = true;
      logger.warn({ err }, 'Could not renew the maintenance lease');
    }
  };
  const timer = setInterval(() => {
    // One renewal at a time, and none while the job's transaction begins or ends.
    if (lost || renewing !== null || through === null) return;
    renewing = renew(through).finally(() => {
      renewing = null;
    });
  }, MAINTENANCE_LEASE_RENEW_MS);
  timer.unref();

  return {
    assertHeld() {
      if (lost || clock.now() > heldUntil) {
        lost = true;
        throw new Error(t('backup.leaseLost'));
      }
    },
    async writeTransaction(db, work) {
      if (connection.dialect !== 'sqlite') return db.transaction().execute(work);
      // From before the transaction takes the write lock until it has ended, nothing is sent
      // through the lease's own connection: better-sqlite3 would wait for the lock synchronously,
      // holding up the very transaction it waits for.
      through = null;
      await renewing;
      try {
        return await db.transaction().execute(async (trx) => {
          through = new DbLeaseManager({ ...connection, db: trx }, clock);
          try {
            return await work(trx);
          } finally {
            through = null;
            await renewing;
          }
        });
      } finally {
        through = own;
      }
    },
    async release() {
      clearInterval(timer);
      await renewing;
      try {
        await own.release(BACKUP_LEASE, holder);
      } finally {
        await connection.close();
      }
    },
  };
}

/** The job's database, through a single connection. */
function oneConnection(database: Config['database']): Config['database'] {
  return database.kind === 'postgres' ? { ...database, poolSize: 1 } : database;
}
