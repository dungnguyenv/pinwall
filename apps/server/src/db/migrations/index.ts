import type { Kysely } from 'kysely';
import type { DbDialect } from '../connect.ts';
import * as m0001 from './0001_initial.ts';
import * as m0002 from './0002_publishing.ts';

/** A migration sees the schema as it was when it was written, not today's `Database`. */
// biome-ignore lint/suspicious/noExplicitAny: same as Kysely's own `Migration` type.
export type MigrationDb = Kysely<any>;

/**
 * A schema change. It receives the dialect so it can pick portable column types. It runs inside
 * the transaction of the whole migration run, so it must not open a transaction of its own.
 */
export interface PinwallMigration {
  up(db: MigrationDb, dialect: DbDialect): Promise<void>;
}

/**
 * Every migration, by name; they run in name order. Listed in code rather than read from disk,
 * so the bundled server carries them. Add new ones here; never edit or rename an applied one.
 */
export const migrations: Record<string, PinwallMigration> = {
  '0001_initial': m0001,
  '0002_publishing': m0002,
};
