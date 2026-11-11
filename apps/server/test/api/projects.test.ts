import { Project, ProjectList } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { DEFAULT_PROJECT_ID } from '../../src/domain/projects.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 11);

describe.each(dialects)('projects over REST on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let member: { user: UserRow; cookie: string };
  let api: ReturnType<typeof restClient>;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
    api = restClient(ctx, member.cookie);
  });
  afterEach(() => ctx.close());

  const create = async (name: string, instructions?: string) =>
    Project.parse((await api.post('/projects', { name, instructions })).body);

  test('projects: create, rename, instructions, archive', async () => {
    const created = await api.post('/projects', { name: 'Site', instructions: 'Dùng tiếng Việt' });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const site = Project.parse(created.body);
    expect(site).toEqual({
      id: site.id,
      name: 'Site',
      instructions: 'Dùng tiếng Việt',
      is_default: false,
      archived_at: null,
      artifact_count: 0,
      created_at: T,
      updated_at: T,
    });
    expect(site.id).toMatch(/^prj_/);

    clock.advance(1000);
    const renamed = await api.patch(`/projects/${site.id}`, {
      name: 'Website',
      instructions: 'Viết bằng tiếng Anh',
    });
    expect(renamed.status).toBe(200);
    expect(Project.parse(renamed.body)).toMatchObject({
      name: 'Website',
      instructions: 'Viết bằng tiếng Anh',
      archived_at: null,
      updated_at: T + 1000,
    });
    expect(Project.parse((await api.get(`/projects/${site.id}`)).body).name).toBe('Website');

    clock.advance(1000);
    const archived = Project.parse(
      (await api.patch(`/projects/${site.id}`, { archived: true })).body,
    );
    expect(archived.archived_at).toBe(T + 2000);
    // Archiving again keeps the time it was first archived.
    clock.advance(1000);
    expect(
      Project.parse((await api.patch(`/projects/${site.id}`, { archived: true })).body).archived_at,
    ).toBe(T + 2000);

    const active = ProjectList.parse((await api.get('/projects?archived=false')).body);
    expect(active.items.map((p) => p.id)).not.toContain(site.id);
    const defaulted = ProjectList.parse((await api.get('/projects')).body);
    expect(defaulted.items.map((p) => p.id)).not.toContain(site.id);
    const shelved = ProjectList.parse((await api.get('/projects?archived=true')).body);
    expect(shelved.items.map((p) => p.id)).toEqual([site.id]);

    const back = Project.parse((await api.patch(`/projects/${site.id}`, { archived: false })).body);
    expect(back.archived_at).toBeNull();
    expect(ProjectList.parse((await api.get('/projects?archived=true')).body).items).toEqual([]);
  });

  test('the default project comes first with its artifact count', async () => {
    const first = await create('Alpha');
    clock.advance(1000);
    const second = await create('Beta');
    await publishFiles(ctx, member.user, { 'index.html': '<p>a</p>' });
    await publishFiles(ctx, member.user, { 'index.html': '<p>b</p>' });
    await publishFiles(
      ctx,
      member.user,
      { 'index.html': '<p>c</p>' },
      {
        kind: 'new_artifact',
        projectId: second.id,
        name: null,
        tags: [],
      },
    );

    const list = ProjectList.parse((await api.get('/projects')).body);
    expect(list.next_cursor).toBeNull();
    expect(list.items.map((p) => [p.id, p.is_default, p.artifact_count])).toEqual([
      [DEFAULT_PROJECT_ID, true, 2],
      [first.id, false, 0],
      [second.id, false, 1],
    ]);
  });

  test('the default project exists before anything is published', async () => {
    const list = ProjectList.parse((await api.get('/projects')).body);
    expect(list.items.map((p) => [p.id, p.name, p.artifact_count])).toEqual([
      [DEFAULT_PROJECT_ID, t('project.defaultName'), 0],
    ]);
    const renamed = await api.patch(`/projects/${DEFAULT_PROJECT_ID}`, { name: 'Inbox' });
    expect(renamed.status).toBe(200);
    expect(Project.parse((await api.get(`/projects/${DEFAULT_PROJECT_ID}`)).body).name).toBe(
      'Inbox',
    );
  });

  test('the default project cannot be archived', async () => {
    const r = await api.patch<ErrorJson>(`/projects/${DEFAULT_PROJECT_ID}`, { archived: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'conflict',
      message: t('project.defaultArchive'),
    });
  });

  test('projects page by default, then creation time', async () => {
    const made: Project[] = [];
    for (const name of ['One', 'Two', 'Three']) {
      clock.advance(1000);
      made.push(await create(name));
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const { body }: { body: unknown } = await api.get(`/projects${query}`);
      const pageOf = ProjectList.parse(body);
      expect(pageOf.items.length).toBeLessThanOrEqual(2);
      ids.push(...pageOf.items.map((p) => p.id));
      cursor = pageOf.next_cursor;
    } while (cursor !== null);
    expect(ids).toEqual([DEFAULT_PROJECT_ID, ...made.map((p) => p.id)]);

    const bad = await api.get<ErrorJson>('/projects?cursor=garbage');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_request');
  });

  test('refuses what a project cannot hold', async () => {
    for (const body of [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 'ok', instructions: 'x'.repeat(20_001) },
      {},
    ]) {
      const r = await api.post<ErrorJson>('/projects', body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(r.body.error.code).toBe('bad_request');
    }
    const site = await create('Site');
    expect((await api.patch(`/projects/${site.id}`, { name: '' })).status).toBe(400);
    expect((await api.get('/projects?archived=maybe')).status).toBe(400);
    expect((await api.get('/projects?limit=201')).status).toBe(400);
    expect((await api.get('/projects?limit=0')).status).toBe(400);
  });

  test('a project that does not exist is 404', async () => {
    expect((await api.get<ErrorJson>('/projects/prj_nope')).status).toBe(404);
    const r = await api.patch<ErrorJson>('/projects/prj_nope', { name: 'x' });
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe(t('project.notFound'));
  });

  test('an empty change changes nothing but the update time', async () => {
    const site = await create('Site', 'Keep');
    clock.advance(1000);
    const r = await api.patch(`/projects/${site.id}`, {});
    expect(Project.parse(r.body)).toEqual({ ...site, updated_at: T + 1000 });
  });

  test('every project route needs a signed-in user', async () => {
    const anonymous = restClient(ctx, '');
    const site = await create('Site');
    for (const r of [
      await anonymous.get('/projects'),
      await anonymous.post('/projects', { name: 'x' }),
      await anonymous.get(`/projects/${site.id}`),
      await anonymous.patch(`/projects/${site.id}`, { name: 'x' }),
    ]) {
      expect(r.status).toBe(401);
    }
  });
});
