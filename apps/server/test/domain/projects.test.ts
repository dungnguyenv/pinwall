import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import {
  createProject,
  DEFAULT_PROJECT_ID,
  ensureDefaultProject,
  getProject,
  updateProject,
} from '../../src/domain/projects.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const T = Date.UTC(2026, 10, 10);

describe.each(dialects)('projects on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let actor: UserRow;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    actor = (await createSignedInUser(ctx)).user;
  });
  afterEach(() => ctx.close());

  const projectRows = () => ctx.deps.db.db.selectFrom('projects').selectAll().execute();

  test('the default project exists exactly once', async () => {
    const made = await Promise.all([
      ensureDefaultProject(ctx.deps),
      ensureDefaultProject(ctx.deps),
      ensureDefaultProject(ctx.deps),
    ]);
    const expected = {
      id: DEFAULT_PROJECT_ID,
      name: 'Default',
      instructions: '',
      is_default: 1,
      archived_at: null,
      created_by: null,
      created_at: T,
      updated_at: T,
      owner_id: null,
    };
    expect(made).toEqual([expected, expected, expected]);
    expect(await projectRows()).toEqual([expected]);

    // Later calls return the row as it is, renamed or not.
    await updateProject(ctx.deps, SYSTEM_SCOPE, DEFAULT_PROJECT_ID, { name: 'Inbox' });
    expect(await ensureDefaultProject(ctx.deps)).toMatchObject({ name: 'Inbox' });
    expect(await projectRows()).toHaveLength(1);
  });

  test('the default project cannot be archived', async () => {
    await ensureDefaultProject(ctx.deps);
    await expect(
      updateProject(ctx.deps, SYSTEM_SCOPE, DEFAULT_PROJECT_ID, { archived: true }),
    ).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
      message: t('project.defaultArchive'),
    });
    expect(await getProject(ctx.deps.db.db, SYSTEM_SCOPE, DEFAULT_PROJECT_ID)).toMatchObject({
      archived_at: null,
    });

    clock.advance(1000);
    const renamed = await updateProject(ctx.deps, SYSTEM_SCOPE, DEFAULT_PROJECT_ID, {
      name: 'Inbox',
      instructions: 'Write in Vietnamese.',
      archived: false,
    });
    expect(renamed).toMatchObject({
      name: 'Inbox',
      instructions: 'Write in Vietnamese.',
      archived_at: null,
      updated_at: T + 1000,
    });
    expect(await getProject(ctx.deps.db.db, SYSTEM_SCOPE, DEFAULT_PROJECT_ID)).toEqual(renamed);
  });

  test('projects are created, renamed, archived and unarchived', async () => {
    const project = await createProject(ctx.deps, actor, { name: 'Website' });
    expect(project).toEqual({
      id: expect.stringMatching(/^prj_[0-9a-z]{20}$/),
      name: 'Website',
      instructions: '',
      is_default: 0,
      archived_at: null,
      created_by: actor.id,
      created_at: T,
      updated_at: T,
      owner_id: actor.id,
    });
    expect(await getProject(ctx.deps.db.db, SYSTEM_SCOPE, project.id)).toEqual(project);

    clock.advance(1000);
    const archived = await updateProject(ctx.deps, SYSTEM_SCOPE, project.id, { archived: true });
    expect(archived).toMatchObject({ archived_at: T + 1000, updated_at: T + 1000 });

    // Archiving again keeps the time it was first archived.
    clock.advance(1000);
    expect(
      await updateProject(ctx.deps, SYSTEM_SCOPE, project.id, { archived: true }),
    ).toMatchObject({
      archived_at: T + 1000,
      updated_at: T + 2000,
    });

    const back = await updateProject(ctx.deps, SYSTEM_SCOPE, project.id, {
      archived: false,
      instructions: 'Use the brand colors.',
    });
    expect(back).toMatchObject({
      name: 'Website',
      instructions: 'Use the brand colors.',
      archived_at: null,
    });
    expect(await getProject(ctx.deps.db.db, SYSTEM_SCOPE, project.id)).toEqual(back);
  });

  test('an unknown project is not found', async () => {
    const notFound = { code: 'not_found', status: 404, message: t('project.notFound') };
    await expect(getProject(ctx.deps.db.db, SYSTEM_SCOPE, 'prj_nope')).rejects.toMatchObject(
      notFound,
    );
    await expect(
      updateProject(ctx.deps, SYSTEM_SCOPE, 'prj_nope', { name: 'x' }),
    ).rejects.toMatchObject(notFound);
  });
});
