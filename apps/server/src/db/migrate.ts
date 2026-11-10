import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';
import type { DbHandle } from './connect.ts';
import { migrations, type PinwallMigration } from './migrations/index.ts';

/** Applies every pending migration; returns the names applied, in order. */
export function migrateToLatest(h: DbHandle): Promise<string[]> {
  return runMigrations(h, migrations);
}

/**
 * Runs `set` through Kysely's `Migrator`. Each migration is atomic on both dialects: Kysely
 * wraps Postgres migrations in a transaction itself but not SQLite ones, so those get their own.
 */
export async function runMigrations(
  h: DbHandle,
  set: Record<string, PinwallMigration>,
): Promise<string[]> {
  const wrapped: Record<string, Migration> = {};
  for (const [name, migration] of Object.entries(set)) {
    wrapped[name] = {
      up: (db) =>
        h.dialect === 'sqlite'
          ? db.transaction().execute((trx) => migration.up(trx, h.dialect))
          : migration.up(db, h.dialect),
    };
  }
  const provider: MigrationProvider = { getMigrations: async () => wrapped };

  const { error, results = [] } = await new Migrator({ db: h.db, provider }).migrateToLatest();
  if (error !== undefined) {
    const failed = results.find((r) => r.status === 'Error')?.migrationName;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      failed ? `Migration ${failed} failed: ${reason}` : `Migrations failed: ${reason}`,
      { cause: error },
    );
  }
  return results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
