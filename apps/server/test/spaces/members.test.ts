import { ProjectMember, ProjectMemberList } from '@pinwall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Visibility } from '../../src/config/types.ts';
import type { MemberRole } from '../../src/db/schema.ts';
import { listMembers, removeMember, setMemberRole } from '../../src/domain/members.ts';
import { scopeForUser } from '../../src/domain/spaces.ts';
import type { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { type ErrorJson, type Reply, restClient } from '../helpers/rest.ts';
import {
  addMember,
  MODES,
  type Person,
  type SpacesFixture,
  sameAnswer,
  spacesContext,
  spacesFixture,
  T,
  UNKNOWN_IDS,
} from './fixture.ts';

describe.each(dialects)('project members on %s', (dialect) => {
  const contexts = {} as Record<Visibility, TestContext>;
  beforeAll(async () => {
    for (const mode of MODES) contexts[mode] = await spacesContext(dialect, mode);
  });
  afterAll(async () => {
    for (const mode of MODES) await contexts[mode]?.close();
  });
  // Every test builds its own fixture, at T: a test that moves the clock leaves the next one at T.
  beforeEach(() => {
    for (const mode of MODES) (contexts[mode].deps.clock as FixedClock).set(T);
  });

  const api = (mode: Visibility, person: Person) => restClient(contexts[mode], person.cookie);
  const personal = (person: Person) => api('personal', person);
  const membersOf = (projectId: string) => `/projects/${projectId}/members`;

  /** The `project_members` rows of `projectId`, as `user_id: role`. */
  async function storedRoles(mode: Visibility, projectId: string) {
    const rows = await contexts[mode].deps.db.db
      .selectFrom('project_members')
      .select(['user_id', 'role'])
      .where('project_id', '=', projectId)
      .execute();
    return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
  }

  /** `person` as a member with `role`, added at `addedAt`, with their email or with none. */
  const memberOf = (
    person: Person,
    role: MemberRole,
    o: { withEmail: boolean; addedAt?: number },
  ): ProjectMember => ({
    user: {
      id: person.user.id,
      name: person.user.name,
      email: o.withEmail ? person.user.email : null,
    },
    role,
    added_at: o.addedAt ?? T,
  });

  /** E (editor) and V (viewer) of P, sorted by user id: both were added at T. */
  const eAndV = (fx: SpacesFixture, withEmail: boolean): ProjectMember[] => {
    const { E, V } = fx.people;
    return [memberOf(E, 'editor', { withEmail }), memberOf(V, 'viewer', { withEmail })].sort(
      (a, b) => (a.user.id < b.user.id ? -1 : 1),
    );
  };

  function expectStatus(r: Reply, status: number) {
    expect(r.status, JSON.stringify(r.body)).toBe(status);
  }

  test('team mode answers every member route as an unknown route', async () => {
    const ctx = contexts.team;
    const fx = await spacesFixture(ctx);
    const { A, E, S, V } = fx.people;
    const a = api('team', A);
    const members = membersOf(fx.ids.P);
    const unknown = `/projects/${fx.ids.P}/no-such-route`;
    const notFound = {
      error: { code: 'not_found', message: t('error.notFound.message') },
    } satisfies ErrorJson;

    const listed = await a.get(members);
    expectStatus(listed, 404);
    expect(listed.body).toEqual(notFound);
    sameAnswer(listed, await a.get(unknown));
    const add = { email: S.user.email, role: 'viewer' };
    sameAnswer(await a.post(members, add), await a.post(unknown, add));
    const change = { role: 'viewer' };
    sameAnswer(
      await a.patch(`${members}/${E.user.id}`, change),
      await a.patch(`${unknown}/${E.user.id}`, change),
    );
    sameAnswer(await a.del(`${members}/${E.user.id}`), await a.del(`${unknown}/${E.user.id}`));

    // Before authentication: no cookie gets the same 404, not a 401.
    const anonymous = async (path: string) => {
      const res = await ctx.request(`/api/v1${path}`, apiInit(ctx));
      return { status: res.status, body: await res.json() };
    };
    const anonymousList = await anonymous(members);
    expect(anonymousList.status).toBe(404);
    sameAnswer(anonymousList, await anonymous(unknown));

    expect(await storedRoles('team', fx.ids.P)).toEqual({
      [E.user.id]: 'editor',
      [V.user.id]: 'viewer',
    });
  });

  test('the domain refuses a scope that sees every project', async () => {
    const { deps } = contexts.team;
    const fx = await spacesFixture(contexts.team);
    const { A, E } = fx.people;
    const scope = scopeForUser(deps, A.user);
    const missing = { status: 404, message: t('project.notFound') };

    await expect(listMembers(deps, scope, fx.ids.P)).rejects.toMatchObject(missing);
    await expect(setMemberRole(deps, scope, fx.ids.P, E.user.id, 'viewer')).rejects.toMatchObject(
      missing,
    );
    await expect(removeMember(deps, scope, fx.ids.P, E.user.id)).rejects.toMatchObject(missing);
    expect(await storedRoles('team', fx.ids.P)).toEqual({
      [E.user.id]: 'editor',
      [fx.people.V.user.id]: 'viewer',
    });
  });

  test('the owner sees members with their emails, oldest first; members see names only', async () => {
    const ctx = contexts.personal;
    const fx = await spacesFixture(ctx);
    const { A, E, V, S } = fx.people;
    const members = membersOf(fx.ids.P);

    const owners = await personal(A).get(members);
    expectStatus(owners, 200);
    expect(owners.headers.get('cache-control')).toBe('no-store');
    ProjectMemberList.parse(owners.body);
    expect(owners.body).toEqual({ items: eAndV(fx, true) });

    for (const person of [E, V]) {
      const r = await personal(person).get(members);
      expectStatus(r, 200);
      expect(r.body).toEqual({ items: eAndV(fx, false) });
    }

    (ctx.deps.clock as FixedClock).advance(1000);
    await addMember(ctx, fx.ids.P, S.user.id, 'viewer', A.user.id);
    const later = await personal(A).get(members);
    expectStatus(later, 200);
    expect(later.body).toEqual({
      items: [...eAndV(fx, true), memberOf(S, 'viewer', { withEmail: true, addedAt: T + 1000 })],
    });
  });

  test('a stranger or an admin gets the answer of an unknown project', async () => {
    const fx = await spacesFixture(contexts.personal);
    const { E, S, X } = fx.people;

    for (const person of [S, X]) {
      const r = await personal(person).get(membersOf(fx.ids.P));
      expectStatus(r, 404);
      sameAnswer(r, await personal(person).get(membersOf(UNKNOWN_IDS.P)));
    }
    const other = await personal(E).get(membersOf(fx.ids.Q));
    expectStatus(other, 404);
    sameAnswer(other, await personal(E).get(membersOf(UNKNOWN_IDS.Q)));
  });

  test('the owner changes a role', async () => {
    const fx = await spacesFixture(contexts.personal);
    const { A, E, V } = fx.people;
    const members = membersOf(fx.ids.P);
    const sessionInP = { target: { project_id: fx.ids.P } };

    const promoted = await personal(A).patch(`${members}/${V.user.id}`, { role: 'editor' });
    expectStatus(promoted, 200);
    expect(promoted.headers.get('cache-control')).toBe('no-store');
    ProjectMember.parse(promoted.body);
    expect(promoted.body).toEqual(memberOf(V, 'editor', { withEmail: true }));
    expectStatus(await personal(V).post('/publish-sessions', sessionInP), 201);

    const demoted = await personal(A).patch(`${members}/${E.user.id}`, { role: 'viewer' });
    expectStatus(demoted, 200);
    expect(demoted.body).toEqual(memberOf(E, 'viewer', { withEmail: true }));
    const refused = await personal(E).post<ErrorJson>('/publish-sessions', sessionInP);
    expectStatus(refused, 403);
    expect(refused.body.error.details).toMatchObject({ reason: 'role' });

    const again = await personal(A).patch(`${members}/${E.user.id}`, { role: 'viewer' });
    expectStatus(again, 200);
    expect(again.body).toEqual(demoted.body);
    expect(await storedRoles('personal', fx.ids.P)).toEqual({
      [E.user.id]: 'viewer',
      [V.user.id]: 'editor',
    });
  });

  test('only the owner manages members', async () => {
    const fx = await spacesFixture(contexts.personal);
    const { E, V } = fx.people;
    const member = (person: Person) => `${membersOf(fx.ids.P)}/${person.user.id}`;
    const forbidden = {
      error: {
        code: 'forbidden',
        message: t('spaces.role.manageMembers'),
        details: { reason: 'role' },
      },
    } satisfies ErrorJson;

    const attempts: [string, () => Promise<Reply>][] = [
      ['E changes V', () => personal(E).patch(member(V), { role: 'editor' })],
      ['V changes themselves', () => personal(V).patch(member(V), { role: 'editor' })],
      ['E removes V', () => personal(E).del(member(V))],
      ['V removes E', () => personal(V).del(member(E))],
    ];
    for (const [name, attempt] of attempts) {
      const r = await attempt();
      expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body, name).toEqual(forbidden);
    }
    expect(await storedRoles('personal', fx.ids.P)).toEqual({
      [E.user.id]: 'editor',
      [V.user.id]: 'viewer',
    });
  });

  test('a member leaves, and the owner removes one', async () => {
    const fx = await spacesFixture(contexts.personal);
    const { A, E, V } = fx.people;
    const members = membersOf(fx.ids.P);

    const left = await personal(V).del(`${members}/${V.user.id}`);
    expectStatus(left, 204);
    expect(left.headers.get('cache-control')).toBe('no-store');
    expectStatus(await personal(V).get(`/projects/${fx.ids.P}`), 404);

    expectStatus(await personal(A).del(`${members}/${E.user.id}`), 204);
    expectStatus(await personal(E).get(`/artifacts/${fx.ids.p}`), 404);
    const listed = await personal(A).get(members);
    expectStatus(listed, 200);
    expect(listed.body).toEqual({ items: [] });
  });

  test('someone who is not a member', async () => {
    const fx = await spacesFixture(contexts.personal);
    const { A, E, S, V } = fx.people;
    const members = membersOf(fx.ids.P);
    const notMember = {
      error: { code: 'not_found', message: t('spaces.members.notMember') },
    } satisfies ErrorJson;

    const attempts: [string, () => Promise<Reply>][] = [
      ['A changes S', () => personal(A).patch(`${members}/${S.user.id}`, { role: 'viewer' })],
      ['A removes S', () => personal(A).del(`${members}/${S.user.id}`)],
      ['A leaves their own project', () => personal(A).del(`${members}/${A.user.id}`)],
    ];
    for (const [name, attempt] of attempts) {
      const r = await attempt();
      expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(404);
      expect(r.body, name).toEqual(notMember);
    }

    const owner = await personal(A).patch<ErrorJson>(`${members}/${E.user.id}`, { role: 'owner' });
    expectStatus(owner, 400);
    expect(owner.body.error.code).toBe('bad_request');
    expect(await storedRoles('personal', fx.ids.P)).toEqual({
      [E.user.id]: 'editor',
      [V.user.id]: 'viewer',
    });
  });
});
