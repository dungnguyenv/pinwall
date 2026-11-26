import type { MigrationDb } from './index.ts';

/**
 * Projects visible to everyone (v1.3): `projects.visible_to_everyone` is 1 when the owner chose to
 * let everyone who signs in view the project. Whether it is in effect is decided as it is read
 * (`PINWALL_EVERYONE_PROJECTS`, and the owner's standing), never stored.
 */
export async function up(db: MigrationDb): Promise<void> {
  await db.schema
    .alterTable('projects')
    .addColumn('visible_to_everyone', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
}
