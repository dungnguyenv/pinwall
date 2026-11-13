import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import {
  type Case,
  type CaseIds,
  c,
  expectCase,
  MODES,
  type Person,
  type SpacesFixture,
  spacesContext,
  spacesFixture,
  type Who,
} from './fixture.ts';

type People = Record<Who, Person>;

/** A path under `/api/v1`, built from the ids and the people of the fixture it runs on. */
type Path = (ids: CaseIds, people: People) => string;

const members =
  (project: 'P' | 'Q'): Path =>
  (ids) =>
    `/projects/${ids[project]}/members`;
const memberOf =
  (project: 'P' | 'Q', who: Who): Path =>
  (ids, people) =>
    `${members(project)(ids, people)}/${people[who].user.id}`;

const get =
  (path: Path): Case['send'] =>
  (api, ids, people) =>
    api.get(path(ids, people));
const post =
  (path: Path, body: (people: People) => object): Case['send'] =>
  (api, ids, people) =>
    api.post(path(ids, people), body(people));
const patch =
  (path: Path, body: object): Case['send'] =>
  (api, ids, people) =>
    api.patch(path(ids, people), body);
const del =
  (path: Path): Case['send'] =>
  (api, ids, people) =>
    api.del(path(ids, people));

const listP = get(members('P'));
const listQ = get(members('Q'));
const addToP = (who: 'S' | 'X') =>
  post(members('P'), (people) => ({ email: people[who].user.email, role: 'viewer' }));
const addSToQ = post(members('Q'), (people) => ({ email: people.S.user.email, role: 'viewer' }));
const makeVAnEditor = patch(memberOf('P', 'V'), { role: 'editor' });
const removeE = del(memberOf('P', 'E'));

/**
 * The member routes: in team mode there are none (every one answers like an unknown route); in
 * personal mode every member lists, only the owner adds, changes and removes, any member leaves,
 * and a stranger, an admin included, learns nothing of P.
 */
const MEMBERS: Case[] = [
  c('A', 'list P', listP, 404, 200),
  c('E', 'list P', listP, 404, 200),
  c('V', 'list P', listP, 404, 200),
  c('S', 'list P', listP, 404, 404),
  c('X', 'list P', listP, 404, 404),
  c('E', 'list Q', listQ, 404, 404),

  c('A', 'add S to P', addToP('S'), 404, 201),
  c('E', 'add S to P', addToP('S'), 404, 403),
  c('V', 'add S to P', addToP('S'), 404, 403),
  c('S', 'add S to P', addToP('S'), 404, 404),
  c('X', 'add X to P', addToP('X'), 404, 404),
  c('E', 'add S to Q', addSToQ, 404, 404),

  c('A', 'make V an editor', makeVAnEditor, 404, 200),
  c('E', 'make V an editor', makeVAnEditor, 404, 403),
  c('V', 'make V an editor', makeVAnEditor, 404, 403),
  c('S', 'make V an editor', makeVAnEditor, 404, 404),

  c('A', 'remove E', removeE, 404, 204),
  c('V', 'remove E', removeE, 404, 403),
  c('S', 'remove E', removeE, 404, 404),
  c('X', 'remove E', removeE, 404, 404),

  c('E', 'leave P', del(memberOf('P', 'E')), 404, 204),
  c('V', 'leave P', del(memberOf('P', 'V')), 404, 204),
  c('S', 'leave P', del(memberOf('P', 'S')), 404, 404),
  c('E', 'leave Q', del(memberOf('Q', 'E')), 404, 404),
];

describe.each(dialects)('project member routes by id on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
    });
    // Members come and go, so each case gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    /** Who is in P and Q, and as what. */
    const stored = () =>
      ctx.deps.db.db
        .selectFrom('project_members')
        .select(['project_id', 'user_id', 'role'])
        .where('project_id', 'in', [fx.ids.P, fx.ids.Q])
        .orderBy('project_id')
        .orderBy('user_id')
        .execute();

    test.each(MEMBERS)('$who: $name', async (memberCase) => {
      const before = await stored();
      await expectCase(ctx, fx, mode, memberCase);
      const status = mode === 'team' ? memberCase.team : memberCase.personal;
      // A refused request writes nothing.
      if (status >= 400)
        expect(await stored(), 'a refused request changed the members').toEqual(before);
    });
  });
});
