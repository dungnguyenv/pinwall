import { sql } from 'kysely';
import {
  DEFAULT_MIGRATION_TABLE,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
  Migrator,
} from 'kysely/migration';
import type { DbHandle } from './connect.ts';
import { type MigrationDb, migrations, type PinwallMigration } from './migrations/index.ts';

/** How long a SQLite migration waits for another process's run (or any writer) to finish. */
const SQLITE_MIGRATE_BUSY_TIMEOUT_MS = 30_000;

/** Applies every pending migration; returns the names applied, in order. */
export function migrateToLatest(h: DbHandle): Promise<string[]> {
  return runMigrations(h, migrations);
}

/** The names of the migrations applied to the database, in order; none if it never was migrated. */
export async function appliedMigrations(h: DbHandle): Promise<string[]> {
  const tables = await h.db.introspection.getTables({ withInternalKyselyTables: true });
  if (!tables.some((table) => table.name === DEFAULT_MIGRATION_TABLE)) return [];
  const { rows } = await sql<{ name: string }>`
    select name from ${sql.table(DEFAULT_MIGRATION_TABLE)} order by name
  `.execute(h.db);
  return rows.map((row) => row.name);
}

/**
 * Runs `set` through Kysely's `Migrator`. A run is one locked transaction on both dialects: the
 * read of what was applied, every pending migration and Kysely's record of each one commit
 * together or not at all, and a second process (the server and `pinwall migrate`, say) waits for
 * the first and then finds nothing to do. Kysely does this itself on Postgres (an advisory lock
 * plus a transaction); on SQLite it takes no lock, so `exclusiveSqliteRun` provides one.
 */
export async function runMigrations(
  h: DbHandle,
  set: Record<string, PinwallMigration>,
): Promise<string[]> {
  const wrapped: Record<string, Migration> = {};
  for (const [name, migration] of Object.entries(set)) {
    wrapped[name] = { up: (db) => migration.up(db, h.dialect) };
  }
  const provider: MigrationProvider = { getMigrations: async () => wrapped };
  const migrate = (db: MigrationDb) => new Migrator({ db, provider }).migrateToLatest();

  const { error, results = [] } =
    h.dialect === 'sqlite' ? await exclusiveSqliteRun(h, migrate) : await migrate(h.db);
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

/**
 * Runs `migrate` on SQLite's one connection inside `BEGIN IMMEDIATE`, which takes the database's
 * write lock up front: another process's run blocks in its own `BEGIN IMMEDIATE` (for up to
 * `SQLITE_MIGRATE_BUSY_TIMEOUT_MS`) until this one commits. Kysely issues no BEGIN of its own
 * on SQLite, so its bookkeeping lands in this transaction too.
 */
async function exclusiveSqliteRun(
  h: DbHandle,
  migrate: (db: MigrationDb) => Promise<MigrationResultSet>,
): Promise<MigrationResultSet> {
  return h.db.connection().execute(async (db) => {
    const { rows } = await sql<{ timeout: number }>`pragma busy_timeout`.execute(db);
    const busyTimeout = rows[0]?.timeout ?? 0;
    await sql`pragma busy_timeout = ${sql.lit(SQLITE_MIGRATE_BUSY_TIMEOUT_MS)}`.execute(db);
    try {
      await sql`begin immediate`.execute(db);
      try {
        const result = await migrate(db);
        if (result.error === undefined) await sql`commit`.execute(db);
        else await rollback(db);
        return result;
      } catch (error) {
        await rollback(db);
        throw error;
      }
    } finally {
      await sql`pragma busy_timeout = ${sql.lit(busyTimeout)}`.execute(db);
    }
  });
}

/** SQLite may have rolled back already (a full disk, say); the original error is the one to keep. */
async function rollback(db: MigrationDb): Promise<void> {
  try {
    await sql`rollback`.execute(db);
  } catch {
    // no transaction left to roll back
  }
}
