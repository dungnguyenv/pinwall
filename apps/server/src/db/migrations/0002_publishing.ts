import { sql } from 'kysely';
import type { DbDialect } from '../connect.ts';
import { bigintCol } from '../dialect.ts';
import type { MigrationDb } from './index.ts';

/**
 * Publishing (M4): the `tombstones` table, which lets deleted artifacts, content grants and share
 * links answer 410 instead of 404; an index on `version_files(sha256)` so blob garbage
 * collection can ask cheaply whether any version still references a blob; and
 * `content_grants.user_id`, the person a grant was made for, so revoking their credentials ends
 * their grants too (null for a share link's guest).
 */
export async function up(db: MigrationDb, dialect: DbDialect): Promise<void> {
  const big = bigintCol({ dialect });
  // STRICT, as in 0001: SQLite then rejects values of the wrong type, as Postgres does.
  const tombstones =
    dialect === 'sqlite'
      ? db.schema.createTable('tombstones').modifyEnd(sql`strict`)
      : db.schema.createTable('tombstones');
  await tombstones
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('deleted_at', big, (c) => c.notNull())
    // Null keeps the tombstone for good.
    .addColumn('expires_at', big)
    .addPrimaryKeyConstraint('tombstones_pkey', ['kind', 'key'])
    .execute();
  await db.schema
    .createIndex('tombstones_expires_at_idx')
    .on('tombstones')
    .column('expires_at')
    .execute();

  await db.schema
    .createIndex('version_files_sha256_idx')
    .on('version_files')
    .column('sha256')
    .execute();

  // SQLite adds a column with a foreign key only when it may be null, as this one is.
  await db.schema
    .alterTable('content_grants')
    .addColumn('user_id', 'text', (c) => c.references('users.id').onDelete('cascade'))
    .execute();
  await db.schema
    .createIndex('content_grants_user_id_idx')
    .on('content_grants')
    .column('user_id')
    .execute();
}
