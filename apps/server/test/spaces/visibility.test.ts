import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { ConfigError } from '../../src/config/types.ts';
import {
  createProject,
  DEFAULT_PROJECT_ID,
  ensureDefaultProject,
} from '../../src/domain/projects.ts';
import {
  checkVisibility,
  confirmTeamVisibility,
  countProjectOwners,
  LAST_VISIBILITY,
  readSetting,
  startSpaces,
} from '../../src/domain/spaces-startup.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { MODES, withVisibility } from './fixture.ts';

const T = 1_762_000_000_000;

test('the loader reads PINWALL_VISIBILITY', () => {
  expect(loadConfig({}).visibility).toBe('team');
  expect(loadConfig({ PINWALL_VISIBILITY: 'personal' }).visibility).toBe('personal');
  expect(() => loadConfig({ PINWALL_VISIBILITY: 'private' })).toThrow(
    /PINWALL_VISIBILITY: must be "team" or "personal"/,
  );
});

describe.each(dialects)('PINWALL_VISIBILITY on %s', (dialect) => {
  let ctx: TestContext;
  afterEach(() => ctx?.close());

  const start = async (visibility: 'team' | 'personal' = 'team'): Promise<TestContext> => {
    ctx = await createTestContext({ dialect, env: { PINWALL_VISIBILITY: visibility } });
    return ctx;
  };
  const lastMode = () => readSetting(ctx.deps.db.db, LAST_VISIBILITY);
  /** A project owned by a new person. */
  const projectOfNewOwner = async (name: string) => {
    const { user } = await createSignedInUser(ctx, { kind: 'oidc' });
    return createProject(ctx.deps, user, { name });
  };

  test.each(MODES)('a fresh instance records the mode it runs in: %s', async (mode) => {
    await start(mode);
    expect(await lastMode()).toBeNull();
    await checkVisibility(ctx.deps);
    expect(await lastMode()).toBe(mode);
  });

  test('team after personal with two owners is refused until confirmed', async () => {
    await start('personal');
    await projectOfNewOwner('A');
    await projectOfNewOwner('B');
    await checkVisibility(ctx.deps);

    const team = withVisibility(ctx.deps, 'team');
    await expect(checkVisibility(team)).rejects.toThrow(ConfigError);
    await expect(checkVisibility(team)).rejects.toThrow(/pinwall visibility team --confirm/);
    await expect(checkVisibility(team)).rejects.toThrow(/2 people own projects/);
    expect(await lastMode()).toBe('personal');

    expect(await confirmTeamVisibility(ctx.deps.db.db, T)).toBe(2);
    await checkVisibility(team);
    expect(await lastMode()).toBe('team');
  });

  test('one owner may go back to team without confirmation', async () => {
    await start('personal');
    const a = await projectOfNewOwner('A');
    // Two projects of one person are still one owner.
    await ctx.deps.db.db
      .insertInto('projects')
      .values({ ...a, id: 'prj_second', name: 'A again' })
      .execute();
    await checkVisibility(ctx.deps);
    expect(await countProjectOwners(ctx.deps.db.db)).toBe(1);

    await checkVisibility(withVisibility(ctx.deps, 'team'));
    expect(await lastMode()).toBe('team');
  });

  test('going to personal needs no confirmation', async () => {
    await start('team');
    await projectOfNewOwner('A');
    await projectOfNewOwner('B');
    await checkVisibility(ctx.deps);
    expect(await lastMode()).toBe('team');

    await checkVisibility(withVisibility(ctx.deps, 'personal'));
    expect(await lastMode()).toBe('personal');
  });

  test('an unowned project belongs to no one when owners are counted', async () => {
    await start('personal');
    await ensureDefaultProject(ctx.deps);
    expect(await countProjectOwners(ctx.deps.db.db)).toBe(0);
    await projectOfNewOwner('A');
    expect(await countProjectOwners(ctx.deps.db.db)).toBe(1);
  });

  test('startSpaces gives an unowned default project to the owner account', async () => {
    await start('team');
    await ensureDefaultProject(ctx.deps);
    const { user: owner } = await createSignedInUser(ctx);
    const ownerOf = async () =>
      (
        await ctx.deps.db.db
          .selectFrom('projects')
          .select('owner_id')
          .where('id', '=', DEFAULT_PROJECT_ID)
          .executeTakeFirstOrThrow()
      ).owner_id;
    expect(await ownerOf()).toBeNull();

    await startSpaces(ctx.deps);
    expect(await ownerOf()).toBe(owner.id);
    expect(await lastMode()).toBe('team');
  });

  test('startSpaces stops a start that checkVisibility refuses', async () => {
    await start('personal');
    await projectOfNewOwner('A');
    await projectOfNewOwner('B');
    await startSpaces(ctx.deps);
    await expect(startSpaces(withVisibility(ctx.deps, 'team'))).rejects.toThrow(ConfigError);
  });

  test.each(MODES)('public config names the mode only in personal mode: %s', async (mode) => {
    await start(mode);
    const body = (await (await ctx.request('/api/v1/config/public')).json()) as Record<
      string,
      unknown
    >;
    if (mode === 'personal') expect(body.visibility).toBe('personal');
    else expect(Object.keys(body)).not.toContain('visibility');
  });
});
