import type { Db } from '../auth/passkeys.ts';
import type { TombstoneKind } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';

/** Rows per insert statement: 2,000 parameters, well under either database's limit. */
const CHUNK = 500;

export interface NewTombstone {
  kind: TombstoneKind;
  key: string;
  /** When the tombstone may go; null keeps it for good. */
  expiresAt: number | null;
}

/**
 * Records deleted things, `deleted_at = now`. A tombstone that already exists is left as it
 * was, so adding one twice is harmless. Runs in whatever `db` is: pass the transaction that
 * deletes the rows, so the tombstones commit with the deletion.
 */
export async function addTombstones(
  db: Db,
  rows: readonly NewTombstone[],
  now: number,
): Promise<void> {
  for (let start = 0; start < rows.length; start += CHUNK) {
    const values = rows.slice(start, start + CHUNK).map((row) => ({
      kind: row.kind,
      key: row.key,
      deleted_at: now,
      expires_at: row.expiresAt,
    }));
    await db
      .insertInto('tombstones')
      .values(values)
      .onConflict((conflict) => conflict.columns(['kind', 'key']).doNothing())
      .execute();
  }
}

/**
 * Whether `key` of `kind` was deleted. A tombstone whose `expires_at` is at or before `now`
 * counts as absent, whether or not `pruneTombstones` has removed it yet.
 */
export async function isTombstoned(
  db: Db,
  kind: TombstoneKind,
  key: string,
  now: number,
): Promise<boolean> {
  const row = await db
    .selectFrom('tombstones')
    .select('kind')
    .where('kind', '=', kind)
    .where('key', '=', key)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .executeTakeFirst();
  return row !== undefined;
}

/** Deletes the tombstones that have expired; returns how many. */
export async function pruneTombstones(deps: AppDeps): Promise<number> {
  const result = await deps.db.db
    .deleteFrom('tombstones')
    .where('expires_at', '<=', deps.clock.now())
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
