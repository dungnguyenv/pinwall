import { ArtifactSummary, Project, ProjectList } from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { createProject, DEFAULT_PROJECT_ID } from '../../src/domain/projects.ts';
import { defaultProjectFor, scopeForUser } from '../../src/domain/spaces.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';
import {
  addMember,
  MODES,
  type Person,
  sameAnswer,
  spacesContext,
  spacesFixture,
  T,
  UNKNOWN_IDS,
  withVisibility,
} from './fixture.ts';

const PAGE = { 'index.html': '<!doctype html><h1>Hello</h1>' };

describe.each(dialects)('projects and artifacts in spaces on %s', (dialect) => {
  let ctx: TestContext;
  afterEach(() => ctx?.close());

  const api = (person: { cookie: string }) => restClient(ctx, person.cookie);
  const clock = () => ctx.deps.clock as FixedClock;
  const projectRow = (id: string) =>
    ctx.deps.db.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const artifactRow = (id: string) =>
    ctx.deps.db.db
      .selectFrom('artifacts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  /** `person`'s default project, made as a `personal` instance would make it, on this database. */
  const personalDefault = (person: Person) => {
    const personal = withVisibility(ctx.deps, 'personal');
    return defaultProjectFor(personal, scopeForUser(personal, person.user));
  };

  /** Every page of `GET /projects` as `person`, `limit` at a time. */
  async function allProjects(person: Person, limit: number): Promise<Project[]> {
    const items: Project[] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        cursor === null ? `?limit=${limit}` : `?limit=${limit}&cursor=${cursor}`;
      const r = await api(person).get(`/projects${query}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const page = ProjectList.parse(r.body);
      items.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor !== null);
    return items;
  }

  test.each(MODES)(
    'the project DTO names owner and role only in personal mode (%s)',
    async (mode) => {
      ctx = await spacesContext(dialect, mode);
      const fx = await spacesFixture(ctx);
      const { A, E, V } = fx.people;
      const owner = { id: A.user.id, name: 'A' };

      const read = async (person: Person) => {
        const r = await api(person).get<Record<string, unknown>>(`/projects/${fx.ids.P}`);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return r.body;
      };
      const listed = async (person: Person) =>
        (await allProjects(person, 50)).find((project) => project.id === fx.ids.P);
      const renamed = await api(A).patch<Record<string, unknown>>(`/projects/${fx.ids.P}`, {
        name: 'P2',
      });
      const created = await api(E).post<Record<string, unknown>>('/projects', { name: 'Mine' });
      expect(renamed.status).toBe(200);
      expect(created.status).toBe(201);

      const bodies = [await read(A), await read(E), await read(V), renamed.body, created.body];
      for (const body of bodies) Project.parse(body);
      if (mode === 'personal') {
        expect(await read(E)).toMatchObject({ role: 'editor', owner });
        expect(await read(V)).toMatchObject({ role: 'viewer', owner });
        expect(await read(A)).toMatchObject({ role: 'owner', owner });
        expect(renamed.body).toMatchObject({ name: 'P2', role: 'owner', owner });
        expect(created.body).toMatchObject({ role: 'owner', owner: { id: E.user.id, name: 'E' } });
        expect(await listed(E)).toMatchObject({ role: 'editor', owner });
      } else {
        for (const body of [...bodies, await listed(E)]) {
          expect(body).not.toHaveProperty('role');
          expect(body).not.toHaveProperty('owner');
        }
      }
    },
  );

  test.each(MODES)('can_manage only in personal mode (%s)', async (mode) => {
    ctx = await spacesContext(dialect, mode);
    const fx = await spacesFixture(ctx);
    const { A, E, V } = fx.people;
    const { ids } = fx;

    const read = async (person: Person, id: string) => {
      const r = await api(person).get(`/artifacts/${id}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return ArtifactSummary.parse(r.body);
    };
    const listedAs = async (person: Person) => {
      const r = await api(person).get<{ items: ArtifactSummary[] }>(
        `/artifacts?project_id=${ids.P}`,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return new Map(r.body.items.map((item) => [item.id, item]));
    };

    const seen = [
      [await read(A, ids.p), true],
      [await read(E, ids.p), false],
      [await read(E, ids.e), true],
      [await read(V, ids.p), false],
      [await read(A, ids.e), true],
    ] as const;
    const listedE = await listedAs(E);
    const listed = [
      [listedE.get(ids.p), false],
      [listedE.get(ids.e), true],
    ] as const;
    for (const [summary, canManage] of [...seen, ...listed]) {
      if (mode === 'personal') expect(summary?.can_manage, summary?.id).toBe(canManage);
      else expect(summary).not.toHaveProperty('can_manage');
    }
  });

  test('personal: listing projects gives each person a default project of their own, listed first', async () => {
    ctx = await spacesContext(dialect, 'personal');
    const fx = await spacesFixture(ctx);
    const { A, E, S } = fx.people;
    clock().advance(1000);

    const sList = await allProjects(S, 50);
    expect(sList).toHaveLength(1);
    expect(sList[0]).toMatchObject({
      name: t('project.defaultName'),
      is_default: true,
      role: 'owner',
      owner: { id: S.user.id, name: 'S' },
      created_at: T + 1000,
    });
    expect(await projectRow(sList[0]?.id ?? '')).toMatchObject({
      owner_id: S.user.id,
      is_default: 1,
    });
    // Listing again finds the same default.
    expect((await allProjects(S, 50)).map((p) => p.id)).toEqual([sList[0]?.id]);

    // Made after P, and still first; then P, which E edits.
    const eList = await allProjects(E, 50);
    expect(eList.map((p) => [p.id === fx.ids.P ? 'P' : 'own', p.is_default, p.role])).toEqual([
      ['own', true, 'owner'],
      ['P', false, 'editor'],
    ]);
    expect(eList[0]?.owner).toEqual({ id: E.user.id, name: 'E' });

    // A page at a time, the order holds: A's default, then P and Q (made in the same
    // millisecond, so by id).
    const aList = await allProjects(A, 1);
    expect(aList.map((p) => p.id)).toEqual([
      (await personalDefault(A)).id,
      ...[fx.ids.P, fx.ids.Q].sort(),
    ]);
    const defaults = await ctx.deps.db.db
      .selectFrom('projects')
      .select('owner_id')
      .where('is_default', '=', 1)
      .execute();
    expect(defaults.map((row) => row.owner_id).sort()).toEqual(
      [A.user.id, E.user.id, S.user.id].sort(),
    );
  });

  test("personal: a publish without a project lands in the publisher's own default project", async () => {
    ctx = await spacesContext(dialect, 'personal');
    const fx = await spacesFixture(ctx);
    const { E, S } = fx.people;

    const fromS = await publishFiles(ctx, S.user, PAGE);
    const fromE = await publishFiles(ctx, E.user, PAGE);
    const sProject = await projectRow(fromS.artifact.project_id);
    const eProject = await projectRow(fromE.artifact.project_id);
    expect(sProject).toMatchObject({ owner_id: S.user.id, is_default: 1 });
    expect(eProject).toMatchObject({ owner_id: E.user.id, is_default: 1 });
    expect(sProject.id).not.toBe(eProject.id);
    // The one their library lists first.
    expect((await allProjects(S, 50)).map((p) => p.id)).toEqual([sProject.id]);
    expect((await allProjects(E, 50))[0]?.id).toBe(eProject.id);
  });

  test('team mode lists the oldest default first and later defaults as ordinary projects', async () => {
    ctx = await spacesContext(dialect, 'team');
    const { user, cookie } = await createSignedInUser(ctx, { kind: 'oidc', name: 'S' });
    const S: Person = { user, cookie, token: '' };
    // The shared default (at T) gets an artifact, so a personal period cannot adopt it.
    const shared = await publishFiles(ctx, S.user, PAGE);
    expect(shared.artifact.project_id).toBe(DEFAULT_PROJECT_ID);
    const before = await createProject(ctx.deps, S.user, { name: 'Before' });
    clock().advance(1);
    const sDefault = await personalDefault(S);
    expect(sDefault).toMatchObject({ owner_id: S.user.id, is_default: 1, created_at: T + 1 });
    clock().advance(1);
    const after = await createProject(ctx.deps, S.user, { name: 'After' });

    for (const limit of [50, 1]) {
      const list = await allProjects(S, limit);
      expect(list.map((p) => [p.id, p.is_default])).toEqual([
        [DEFAULT_PROJECT_ID, true],
        [before.id, false],
        [sDefault.id, false],
        [after.id, false],
      ]);
    }

    // A default project never archives, whoever's it was.
    const r = await api(S).patch<ErrorJson>(`/projects/${sDefault.id}`, { archived: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'conflict', message: t('project.defaultArchive') });
    expect((await projectRow(sDefault.id)).archived_at).toBeNull();
  });

  test.each(MODES)('an artifact moves only between projects of one owner (%s)', async (mode) => {
    ctx = await spacesContext(dialect, mode);
    const fx = await spacesFixture(ctx);
    const { A, E, S } = fx.people;
    const { ids } = fx;
    const eDefault = await personalDefault(E);
    const sProject = await createProject(ctx.deps, S.user, { name: 'S' });
    // E views Q, which A owns as A owns P.
    await addMember(ctx, ids.Q, E.user.id, 'viewer', A.user.id);
    const move = (person: Person, artifactId: string, projectId: string) =>
      api(person).patch<ErrorJson>(`/artifacts/${artifactId}`, { project_id: projectId });

    const toOwnDefault = await move(E, ids.e, eDefault.id);
    const toStranger = await move(A, ids.p, sProject.id);
    const toViewed = await move(E, ids.e, ids.Q);
    if (mode === 'team') {
      expect([toOwnDefault.status, toStranger.status, toViewed.status]).toEqual([200, 200, 200]);
      expect((await artifactRow(ids.e)).project_id).toBe(ids.Q);
      expect((await artifactRow(ids.p)).project_id).toBe(sProject.id);
      return;
    }

    expect(toOwnDefault.status).toBe(403);
    expect(toOwnDefault.body.error).toEqual({
      code: 'forbidden',
      message: t('spaces.move.otherSpace'),
      details: { reason: 'other_space' },
    });
    expect(toStranger.status).toBe(404);
    sameAnswer(toStranger, await move(A, ids.p, UNKNOWN_IDS.Q));
    // Same owner, but E may not publish into Q.
    expect(toViewed.status).toBe(403);
    expect(toViewed.body.error).toEqual({
      code: 'forbidden',
      message: t('spaces.role.publish'),
      details: { reason: 'role' },
    });
    expect((await artifactRow(ids.e)).project_id).toBe(ids.P);
    expect((await artifactRow(ids.p)).project_id).toBe(ids.P);
  });
});
