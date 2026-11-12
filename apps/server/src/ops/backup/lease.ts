import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { AppDeps } from '../../deps.ts';
import { BACKUP_LEASE } from '../../domain/blobs.ts';
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
  /** Stops renewing and frees the lease. */
  release(): Promise<void>;
}

/**
 * Takes `BACKUP_LEASE` for a backup or a restore and keeps renewing it until `release`. While it
 * is held, blob garbage collection deletes nothing, and a second backup or restore is refused
 * with 409. The lease counts as lost once a renewal fails or is refused, and once its term has
 * run out without one (on SQLite a renewal waits while a long read holds the one connection);
 * `assertHeld` then throws.
 */
export async function holdMaintenanceLease(
  deps: AppDeps,
  role: 'backup' | 'restore',
): Promise<MaintenanceLease> {
  const { leases, clock, logger } = deps;
  const holder = `${role}:${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  // The lease ends at or after this: the database counts its term from a later moment.
  let heldUntil = clock.now() + MAINTENANCE_LEASE_TTL_MS;
  if (!(await leases.acquire(BACKUP_LEASE, holder, MAINTENANCE_LEASE_TTL_MS))) {
    throw conflict(t('backup.busy'));
  }

  let lost = false;
  let renewing: Promise<void> | null = null;
  const renew = async () => {
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
    // One renewal at a time: on SQLite it waits for the connection a snapshot holds.
    if (lost || renewing !== null) return;
    renewing = renew().finally(() => {
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
    async release() {
      clearInterval(timer);
      await renewing;
      await leases.release(BACKUP_LEASE, holder);
    },
  };
}
