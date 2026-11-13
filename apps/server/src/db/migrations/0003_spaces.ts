import { sql } from 'kysely';
import type { DbDialect } from '../connect.ts';
import { bigintCol } from '../dialect.ts';
import type { MigrationDb } from './index.ts';

/**
 * Personal spaces (v1.1): every project gets an owner, `projects.owner_id`, and each owner at most
 * one default project; `project_members` lets an owner add people to a project; users get the
 * share-link approval and their quota overrides; `instance_settings` keeps instance-wide state
 * such as the last visibility mode. Existing projects get their owners from
 * `backfillProjectOwners`.
 */
export async function up(db: MigrationDb, dialect: DbDialect): Promise<void> {
  const big = bigintCol({ dialect });
  // STRICT, as in 0001: SQLite then rejects values of the wrong type, as Postgres does.
  const createTable = (name: string) =>
    dialect === 'sqlite'
      ? db.schema.createTable(name).modifyEnd(sql`strict`)
      : db.schema.createTable(name);

  // No ON DELETE: someone who owns projects cannot be deleted while they do.
  await db.schema
    .alterTable('projects')
    .addColumn('owner_id', 'text', (c) => c.references('users.id'))
    .execute();
  await db.schema.createIndex('projects_owner_id_idx').on('projects').column('owner_id').execute();
  await db.schema
    .createIndex('projects_owner_default_idx')
    .on('projects')
    .column('owner_id')
    .unique()
    .where(sql.ref('is_default'), '=', sql.lit(1))
    .execute();

  await createTable('project_members')
    .addColumn('project_id', 'text', (c) =>
      c.references('projects.id').onDelete('cascade').notNull(),
    )
    .addColumn('user_id', 'text', (c) => c.references('users.id').onDelete('cascade').notNull())
    .addColumn('role', 'text', (c) => c.notNull())
    .addColumn('added_by', 'text', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('created_at', big, (c) => c.notNull())
    .addPrimaryKeyConstraint('project_members_pkey', ['project_id', 'user_id'])
    .execute();
  await db.schema
    .createIndex('project_members_user_id_idx')
    .on('project_members')
    .column('user_id')
    .execute();

  await db.schema
    .alterTable('users')
    .addColumn('share_approved', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema.alterTable('users').addColumn('quota_bytes', big).execute();
  await db.schema.alterTable('users').addColumn('quota_artifacts', 'integer').execute();

  await createTable('instance_settings')
    .addColumn('key', 'text', (c) => c.primaryKey().notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('updated_at', big, (c) => c.notNull())
    .execute();

  await backfillProjectOwners(db);
}

/**
 * Spec §8.1: owner_id = created_by; else the owner account, else the earliest active admin, else
 * the earliest user. Rows changed.
 */
export async function backfillProjectOwners(db: MigrationDb): Promise<number> {
  const byCreator = await db
    .updateTable('projects')
    .set((eb) => ({ owner_id: eb.ref('created_by') }))
    .where('owner_id', 'is', null)
    .where('created_by', 'is not', null)
    .executeTakeFirst();

  // An active admin as 1.0 decides it (`effectiveRole`, `hasAccess`): an IdP account, not
  // disabled, that the IdP admits, whose override (or else whose IdP role) is admin.
  const fallback = await db
    .selectFrom('users')
    .select('id')
    .orderBy(
      sql`case
        when kind = 'owner' then 0
        when kind = 'oidc' and disabled_at is null and idp_role is not null
          and coalesce(role_override, idp_role) = 'admin' then 1
        else 2
      end`,
    )
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  if (fallback === undefined) return Number(byCreator.numUpdatedRows);

  // A default project stays unowned when the fallback has one already: one default per owner.
  const byFallback = await db
    .updateTable('projects')
    .set({ owner_id: fallback.id })
    .where('owner_id', 'is', null)
    .where((eb) =>
      eb.or([
        eb('is_default', '<>', 1),
        eb.not(
          eb.exists(
            eb
              .selectFrom('projects as owned')
              .select('owned.id')
              .where('owned.owner_id', '=', fallback.id)
              .where('owned.is_default', '=', 1),
          ),
        ),
      ]),
    )
    .executeTakeFirst();
  return Number(byCreator.numUpdatedRows) + Number(byFallback.numUpdatedRows);
}
