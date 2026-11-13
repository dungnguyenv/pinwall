import { describe, expect, onTestFinished, test } from 'vitest';
import type { DbHandle } from '../../src/db/connect.ts';
import { migrateToLatest, runMigrations } from '../../src/db/migrate.ts';
import { backfillProjectOwners } from '../../src/db/migrations/0003_spaces.ts';
import { migrations } from '../../src/db/migrations/index.ts';
import type { RoleOverride } from '../../src/db/schema.ts';
import { DEFAULT_PROJECT_ID } from '../../src/domain/projects.ts';
import { dialects, withDb } from '../helpers/db.ts';

const T = 1_762_000_000_000;

/** The migrations a 1.0 database has. */
const V10_MIGRATIONS = ['0001_initial', '0002_publishing'];

interface Seed {
  /** Whether the owner account `usr_o` exists. */
  owner?: boolean;
  adminDisabled?: boolean;
  adminOverride?: RoleOverride;
}

describe.each(dialects)('migration 0003_spaces on %s', (dialect) => {
  /** A database migrated as 1.0 left it, with nothing in it. */
  async function openV10(): Promise<DbHandle> {
    const h = await withDb(dialect);
    onTestFinished(() => h.close());
    const v10 = Object.entries(migrations).filter(([name]) => V10_MIGRATIONS.includes(name));
    expect(await runMigrations(h, Object.fromEntries(v10))).toEqual(V10_MIGRATIONS);
    return h;
  }

  /**
   * 1.0 rows: `usr_m`, an IdP member (created at T); `usr_a`, an IdP admin (T+1); `usr_o`, the
   * owner account (T+2). The default project and `prj_lost` have no creator; `usr_m` made
   * `prj_mine`.
   */
  async function seedV10(h: DbHandle, o: Seed = {}): Promise<void> {
    const oidc = (id: string, at: number) => ({
      id,
      kind: 'oidc' as const,
      email: `${id}@example.test`,
      email_verified: 1 as const,
      oidc_issuer: 'https://idp.example.test',
      oidc_subject: id,
      created_at: at,
    });
    await h.db
      .insertInto('users')
      .values([
        { ...oidc('usr_m', T), idp_role: 'member' },
        {
          ...oidc('usr_a', T + 1),
          idp_role: 'admin',
          role_override: o.adminOverride ?? null,
          disabled_at: o.adminDisabled ? T + 10 : null,
        },
      ])
      .execute();
    if (o.owner !== false) {
      await h.db
        .insertInto('users')
        .values({ id: 'usr_o', kind: 'owner', email_verified: 0, created_at: T + 2 })
        .execute();
    }
    await h.db
      .insertInto('projects')
      .values([
        project(DEFAULT_PROJECT_ID, { is_default: 1 }),
        project('prj_mine', { created_by: 'usr_m' }),
        project('prj_lost'),
      ])
      .execute();
  }

  /** Each project's owner, by project id. */
  async function owners(h: DbHandle): Promise<Record<string, string | null>> {
    const rows = await h.db.selectFrom('projects').select(['id', 'owner_id']).execute();
    return Object.fromEntries(rows.map((row) => [row.id, row.owner_id]));
  }

  const user = (h: DbHandle, id: string) =>
    h.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  test('a 1.0 database gets its owners as spec §8.1 says', async () => {
    const h = await openV10();
    await seedV10(h);

    expect(await migrateToLatest(h)).toEqual(['0003_spaces']);

    expect(await owners(h)).toEqual({
      [DEFAULT_PROJECT_ID]: 'usr_o',
      prj_mine: 'usr_m',
      prj_lost: 'usr_o',
    });
    expect(await user(h, 'usr_m')).toMatchObject({
      share_approved: 0,
      quota_bytes: null,
      quota_artifacts: null,
    });
    expect(await h.db.selectFrom('instance_settings').selectAll().execute()).toEqual([]);
  });

  test.each([
    ['no owner account: the earliest active admin', { owner: false }, 'usr_a'],
    [
      'the only admin is disabled: the earliest user',
      { owner: false, adminDisabled: true },
      'usr_m',
    ],
    [
      'the only admin is blocked: the earliest user',
      { owner: false, adminOverride: 'blocked' },
      'usr_m',
    ],
  ] as const)('%s', async (_name, seed: Seed, expected) => {
    const h = await openV10();
    await seedV10(h, seed);

    await migrateToLatest(h);

    expect(await owners(h)).toEqual({
      [DEFAULT_PROJECT_ID]: expected,
      prj_mine: 'usr_m',
      prj_lost: expected,
    });
  });

  test('an empty instance leaves the default project unowned', async () => {
    const h = await openV10();
    await h.db
      .insertInto('projects')
      .values(project(DEFAULT_PROJECT_ID, { is_default: 1 }))
      .execute();

    await migrateToLatest(h);

    expect(await owners(h)).toEqual({ [DEFAULT_PROJECT_ID]: null });
  });

  test('each owner has at most one default project', async () => {
    const h = await openV10();
    await seedV10(h);
    await migrateToLatest(h); // usr_o owns the default project
    const insert = (id: string, o: { is_default: 0 | 1; owner_id: string | null }) =>
      h.db.insertInto('projects').values(project(id, o)).execute();

    await expect(insert('prj_second', { is_default: 1, owner_id: 'usr_o' })).rejects.toThrow(
      /unique|duplicate/i,
    );
    await insert('prj_hers', { is_default: 1, owner_id: 'usr_m' });
    await insert('prj_plain', { is_default: 0, owner_id: 'usr_o' });
    await insert('prj_free_1', { is_default: 1, owner_id: null });
    await insert('prj_free_2', { is_default: 1, owner_id: null });

    expect(await owners(h)).toMatchObject({
      prj_hers: 'usr_m',
      prj_plain: 'usr_o',
      prj_free_1: null,
      prj_free_2: null,
    });
  });

  test('the backfill gives nobody a second default project and counts what it changed', async () => {
    const h = await openV10();
    await seedV10(h);
    await migrateToLatest(h); // usr_o owns the default project
    await h.db
      .insertInto('projects')
      .values([
        project('prj_default_2', { is_default: 1, owner_id: null }),
        project('prj_unknown', { owner_id: null }),
        project('prj_by_a', { created_by: 'usr_a', owner_id: null }),
      ])
      .execute();

    expect(await backfillProjectOwners(h.db)).toBe(2);

    expect(await owners(h)).toMatchObject({
      prj_default_2: null,
      prj_unknown: 'usr_o',
      prj_by_a: 'usr_a',
    });
    expect(await backfillProjectOwners(h.db)).toBe(0);
  });

  test('memberships go with their project and their user', async () => {
    const h = await openV10();
    await seedV10(h);
    await migrateToLatest(h); // usr_o owns the default project and prj_lost, usr_m prj_mine
    const member = (project_id: string, user_id: string, added_by: string) =>
      ({ project_id, user_id, role: 'viewer', added_by, created_at: T }) as const;
    await h.db
      .insertInto('project_members')
      .values([
        { ...member('prj_mine', 'usr_a', 'usr_m'), role: 'editor' },
        member('prj_lost', 'usr_a', 'usr_o'),
        member('prj_lost', 'usr_m', 'usr_a'),
      ])
      .execute();
    const memberships = () =>
      h.db
        .selectFrom('project_members')
        .select(['project_id', 'user_id', 'added_by'])
        .orderBy('project_id')
        .orderBy('user_id')
        .execute();

    await expect(
      h.db
        .insertInto('project_members')
        .values(member('prj_mine', 'usr_a', 'usr_o'))
        .execute(),
    ).rejects.toThrow(/unique|duplicate/i);
    // Someone who owns a project cannot go: it would be left without an owner.
    await expect(h.db.deleteFrom('users').where('id', '=', 'usr_m').execute()).rejects.toThrow(
      /foreign key/i,
    );

    await h.db.deleteFrom('users').where('id', '=', 'usr_a').execute();
    expect(await memberships()).toEqual([
      { project_id: 'prj_lost', user_id: 'usr_m', added_by: null },
    ]);

    await h.db.deleteFrom('projects').where('id', '=', 'prj_lost').execute();
    expect(await memberships()).toEqual([]);
  });
});

function project(
  id: string,
  o: { is_default?: 0 | 1; created_by?: string | null; owner_id?: string | null } = {},
) {
  return {
    id,
    name: id,
    instructions: '',
    is_default: o.is_default ?? 0,
    archived_at: null,
    created_by: o.created_by ?? null,
    created_at: T,
    updated_at: T,
    ...(o.owner_id === undefined ? {} : { owner_id: o.owner_id }),
  };
}
