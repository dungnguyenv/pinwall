import type { DbHandle } from '../db/connect.ts';
import type { Clock } from '../lib/clock.ts';

/**
 * Named, time-limited locks between processes sharing a database: scheduled jobs, blob garbage
 * collection, backups. A lease nobody renews frees itself when its term ends.
 */
export interface LeaseManager {
  /** Takes the lease if nobody holds it or the holder's term ended; false when it is held. */
  acquire(name: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Extends the holder's unexpired lease to `ttlMs` from now; false for anyone else. */
  renew(name: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Frees the lease if `holder` holds it; does nothing otherwise. */
  release(name: string, holder: string): Promise<void>;
  isHeld(name: string): Promise<boolean>;
}

/**
 * Backed by the `leases` table. A lease lasts through its `expires_at` millisecond and can be
 * taken over from the next one. Every operation is a single statement, so competing processes
 * cannot both win.
 */
export class DbLeaseManager implements LeaseManager {
  constructor(
    private readonly h: DbHandle,
    private readonly clock: Clock,
  ) {}

  async acquire(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const expiresAt = now + ttlMs;
    // Insert, or take over only a lease that has expired; success means one row was written.
    const result = await this.h.db
      .insertInto('leases')
      .values({ name, holder, expires_at: expiresAt })
      .onConflict((conflict) =>
        conflict
          .column('name')
          .doUpdateSet({ holder, expires_at: expiresAt })
          .where('leases.expires_at', '<', now),
      )
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows) === 1;
  }

  async renew(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const result = await this.h.db
      .updateTable('leases')
      .set({ expires_at: now + ttlMs })
      .where('name', '=', name)
      .where('holder', '=', holder)
      .where('expires_at', '>=', now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async release(name: string, holder: string): Promise<void> {
    await this.h.db
      .deleteFrom('leases')
      .where('name', '=', name)
      .where('holder', '=', holder)
      .execute();
  }

  async isHeld(name: string): Promise<boolean> {
    const row = await this.h.db
      .selectFrom('leases')
      .select('name')
      .where('name', '=', name)
      .where('expires_at', '>=', this.clock.now())
      .executeTakeFirst();
    return row !== undefined;
  }
}
