import { CommentThreadList, CreatedShareLink, GuestCreated } from '@pinwall/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { apiInit } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { restClient } from '../helpers/rest.ts';
import { sampleAnchor } from '../helpers/review.ts';
import {
  type Case,
  type CaseIds,
  c,
  expectCase,
  MODES,
  type Person,
  removeMember,
  type SpacesFixture,
  sameAnswer,
  spacesContext,
  spacesFixture,
  UNKNOWN_IDS,
  type Who,
} from './fixture.ts';

/** Each REST read by id, as a path under `/api/v1` naming an artifact and its project. */
const READS: [string, (ids: { artifact: string; project: string }) => string][] = [
  ['artifact', (i) => `/artifacts/${i.artifact}`],
  ['versions', (i) => `/artifacts/${i.artifact}/versions`],
  ['version', (i) => `/artifacts/${i.artifact}/versions/2`],
  ['files', (i) => `/artifacts/${i.artifact}/versions/2/files`],
  ['threads', (i) => `/artifacts/${i.artifact}/comments`],
  ['share links', (i) => `/artifacts/${i.artifact}/share-links`],
  ['diff', (i) => `/artifacts/${i.artifact}/diff?from=1&to=2`],
  ['text diff', (i) => `/artifacts/${i.artifact}/diff/file?from=1&to=2&path=index.html`],
  ['markdown diff', (i) => `/artifacts/${i.artifact}/diff/markdown?from=1&to=2&path=notes.md`],
  ['preview grant', (i) => `/artifacts/${i.artifact}/versions/2/preview?mode=review`],
  ['thumbnail', (i) => `/artifacts/${i.artifact}/thumbnail`],
  ['project', (i) => `/projects/${i.project}`],
  ['project filter', (i) => `/artifacts?project_id=${i.project}`],
];

interface Answer {
  status: number;
  body: unknown;
}

describe.each(dialects)('REST reads by id on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    // Reads change nothing, so one fixture serves every test but the last, which builds its own.
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    /** GET `/api/v1${path}` as `person`; the body parsed when it is JSON (a thumbnail is not). */
    async function get(person: Person, path: string): Promise<Answer> {
      const res = await ctx.request(`/api/v1${path}`, apiInit(ctx, { cookie: person.cookie }));
      const json = res.headers.get('content-type')?.includes('application/json') ?? false;
      return { status: res.status, body: json ? await res.json() : await res.text() };
    }

    /** `who` reads `path` (200), or gets what the same read of unknown ids gets (404). */
    async function expectRead(who: Who, path: string, unknownPath: string, sees: boolean) {
      const person = fx.people[who];
      const answer = await get(person, path);
      const label = `${who} reads ${path} in ${mode} mode, answered ${JSON.stringify(answer.body)}`;
      if (sees) {
        expect(answer.status, label).toBe(200);
        return;
      }
      expect(answer.status, label).toBe(404);
      sameAnswer(answer, await get(person, unknownPath));
    }

    test.each(READS)(
      '%s of Q: E, V, S and X read it in team mode and get not-found in personal mode',
      async (_name, path) => {
        const of = path({ artifact: fx.ids.q, project: fx.ids.Q });
        const unknown = path({ artifact: UNKNOWN_IDS.q, project: UNKNOWN_IDS.Q });
        await expectRead('A', of, unknown, true);
        for (const who of ['E', 'V', 'S', 'X'] as const) {
          await expectRead(who, of, unknown, mode === 'team');
        }
      },
    );

    test.each(READS)(
      '%s of P: E and V read it in both modes; S and X only in team mode',
      async (_name, path) => {
        const of = path({ artifact: fx.ids.p, project: fx.ids.P });
        const unknown = path({ artifact: UNKNOWN_IDS.p, project: UNKNOWN_IDS.P });
        for (const who of ['A', 'E', 'V'] as const) await expectRead(who, of, unknown, true);
        for (const who of ['S', 'X'] as const) {
          await expectRead(who, of, unknown, mode === 'team');
        }
      },
    );

    test('lists leave out what the viewer cannot see', async () => {
      const { S } = fx.people;
      const { ids } = fx;
      const listed = async (path: string) => {
        const answer = await get(S, path);
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        return (answer.body as { items: { id: string }[] }).items.map((item) => item.id);
      };

      const artifacts = await listed('/artifacts');
      if (mode === 'team') expect(artifacts).toEqual(expect.arrayContaining([ids.p, ids.q, ids.e]));
      else for (const id of [ids.p, ids.q, ids.e]) expect(artifacts).not.toContain(id);

      const projects = await listed('/projects');
      if (mode === 'team') {
        expect(projects).toEqual(expect.arrayContaining([ids.P, ids.Q]));
      } else {
        const own = await ctx.deps.db.db
          .selectFrom('projects')
          .select('id')
          .where('owner_id', '=', S.user.id)
          .execute();
        expect(projects.sort()).toEqual(own.map((row) => row.id).sort());
      }
    });

    test('Recent forgets an artifact its viewer can no longer see', async () => {
      // Its own fixture: taking E out of P would change what the other tests expect.
      const own = await spacesFixture(ctx);
      const { E } = own.people;
      const recent = async () => {
        const answer = await get(E, '/artifacts/recent');
        expect(answer.status, JSON.stringify(answer.body)).toBe(200);
        return (answer.body as { items: { id: string }[] }).items.map((item) => item.id);
      };

      const preview = await get(E, `/artifacts/${own.ids.p}/versions/2/preview?mode=review`);
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(await recent()).toContain(own.ids.p);

      await removeMember(ctx, own.ids.P, E.user.id);
      if (mode === 'team') expect(await recent()).toContain(own.ids.p);
      else expect(await recent()).not.toContain(own.ids.p);
    });
  });
});

/** A path under `/api/v1`, built from the ids the case runs on. */
type Path = (i: CaseIds) => string;

const post =
  (path: Path, body: object): Case['send'] =>
  (api, i) =>
    api.post(path(i), body);
const patch =
  (path: Path, body: object | ((i: CaseIds) => object)): Case['send'] =>
  (api, i) =>
    api.patch(path(i), typeof body === 'function' ? body(i) : body);
const del =
  (path: Path): Case['send'] =>
  (api, i) =>
    api.del(path(i));

const renameP = patch((i) => `/projects/${i.P}`, { name: 'x' });
const renameQ = patch((i) => `/projects/${i.Q}`, { name: 'x' });
const renamep = patch((i) => `/artifacts/${i.p}`, { name: 'x' });
const renamee = patch((i) => `/artifacts/${i.e}`, { name: 'x' });
const deletep = del((i) => `/artifacts/${i.p}`);
const deletee = del((i) => `/artifacts/${i.e}`);
const deletepV1 = del((i) => `/artifacts/${i.p}/versions/1`);

/** Project and artifact writes: team mode keeps the 1.0 rules, personal mode the roles of §4.3. */
const WRITES: Case[] = [
  c('A', 'rename P', renameP, 200, 200),
  c('E', 'rename P', renameP, 200, 403),
  c('V', 'rename P', renameP, 200, 403),
  c('S', 'rename P', renameP, 200, 404),
  c('E', 'rename Q', renameQ, 200, 404),
  c('A', 'rename p', renamep, 200, 200),
  c('E', 'rename p', renamep, 200, 403),
  c('V', 'rename p', renamep, 200, 403),
  c('S', 'rename p', renamep, 200, 404),
  c('E', 'rename e', renamee, 200, 200),
  c(
    'A',
    'move p to Q',
    patch(
      (i) => `/artifacts/${i.p}`,
      (i) => ({ project_id: i.Q }),
    ),
    200,
    200,
  ),
  c('E', 'delete p', deletep, 403, 403),
  c('V', 'delete p', deletep, 403, 403),
  c('S', 'delete p', deletep, 403, 404),
  c('X', 'delete p', deletep, 204, 404),
  c('A', 'delete p', deletep, 204, 204),
  c('E', 'delete e', deletee, 204, 204),
  // Team: A is neither e's publisher nor an admin; personal: A owns e's project.
  c('A', 'delete e', deletee, 403, 204),
  c('E', 'delete version 1 of p', deletepV1, 403, 403),
  c('A', 'delete version 1 of p', deletepV1, 204, 204),
];

describe.each(dialects)('REST project and artifact writes on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
    });
    // Writes change the fixture, so each case gets its own, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    test.each(WRITES)('$who: $name', (writeCase) => expectCase(ctx, fx, mode, writeCase));
  });
});

const commentOnp = post((i) => `/artifacts/${i.p}/comments`, { body: 'x', anchor: sampleAnchor() });
const replyTopThread = post((i) => `/comments/${i.pThread}/replies`, { body: 'x' });
const editpThread = patch((i) => `/comments/${i.pThread}`, { body: 'x' });
const deletepReply = del((i) => `/comments/${i.pReply}`);
const deleteeThread = del((i) => `/comments/${i.eThread}`);
const resolvepThread = post((i) => `/comments/${i.pThread}/resolve`, {});
const reopenpThread = post((i) => `/comments/${i.pThread}/reopen`, {});
const linkOnp = post((i) => `/artifacts/${i.p}/share-links`, { allow_comments: false });
const revokepLink = del((i) => `/share-links/${i.pLink}`);
const revokeeLink = del((i) => `/share-links/${i.eLink}`);

/**
 * Comments and share links: every role comments, replies, resolves and reopens; only the owner
 * deletes others' comments; owners and editors make links; owners revoke any, editors their own.
 */
const REVIEW: Case[] = [
  c('V', 'comment on p', commentOnp, 201, 201),
  c('S', 'comment on p', commentOnp, 201, 404),
  c('V', "reply to A's thread", replyTopThread, 201, 201),
  c('S', "reply to A's thread", replyTopThread, 201, 404),
  // Author only, in both modes, with the 1.0 message and no reason.
  c('E', "edit A's comment", editpThread, 403, 403, null),
  c('S', "edit A's comment", editpThread, 403, 404),
  c('E', "delete A's reply", deletepReply, 403, 403),
  c('S', "delete A's reply", deletepReply, 403, 404),
  c('X', "delete A's reply", deletepReply, 204, 404),
  c('A', "delete E's thread on p", deleteeThread, 204, 204),
  c('V', "resolve A's thread", resolvepThread, 200, 200),
  c('S', "resolve A's thread", resolvepThread, 200, 404),
  c('S', "reopen A's thread", reopenpThread, 200, 404),
  c('E', 'create a link on p', linkOnp, 201, 201),
  c('V', 'create a link on p', linkOnp, 201, 403),
  c('S', 'create a link on p', linkOnp, 201, 404),
  c('E', "revoke A's link", revokepLink, 403, 403),
  c('S', "revoke A's link", revokepLink, 403, 404),
  c('X', "revoke A's link", revokepLink, 204, 404),
  c('E', "revoke E's link", revokeeLink, 204, 204),
  // Team: A neither made the link nor published e; personal: A owns e's project.
  c('A', "revoke E's link", revokeeLink, 403, 204),
];

describe.each(dialects)('REST comment and share link writes on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
    });
    // Writes change the fixture, so each case gets its own, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
    });
    afterAll(() => ctx?.close());

    test.each(REVIEW)('$who: $name', (reviewCase) => expectCase(ctx, fx, mode, reviewCase));
  });
});

describe.each(dialects)('share links in personal mode on %s', (dialect) => {
  let ctx: TestContext;
  let fx: SpacesFixture;
  beforeAll(async () => {
    ctx = await spacesContext(dialect, 'personal');
    fx = await spacesFixture(ctx);
  });
  afterAll(() => ctx?.close());

  test('guests keep reading and commenting through a share link in personal mode', async () => {
    const made = await restClient(ctx, fx.people.A.cookie).post(
      `/artifacts/${fx.ids.p}/share-links`,
      { allow_comments: true },
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const { token } = CreatedShareLink.parse(made.body);
    const share = `/api/v1/share/${token}`;

    const opened = await ctx.request(share, apiInit(ctx));
    expect(opened.status, await opened.clone().text()).toBe(200);

    const posted = await ctx.request(
      `${share}/comments`,
      apiInit(ctx, { body: { guest_name: 'Lan', body: 'x', anchor: sampleAnchor() } }),
    );
    expect(posted.status, await posted.clone().text()).toBe(201);
    const { thread } = GuestCreated.parse(await posted.json());

    const replied = await ctx.request(
      `${share}/comments/${thread.id}/replies`,
      apiInit(ctx, { body: { guest_name: 'Lan', body: 'y' } }),
    );
    expect(replied.status, await replied.clone().text()).toBe(201);

    const listed = await ctx.request(`${share}/comments`, apiInit(ctx));
    expect(listed.status, await listed.clone().text()).toBe(200);
    const threads = CommentThreadList.parse(await listed.json()).items;
    const listedThread = threads.find((item) => item.id === thread.id);
    expect(listedThread?.replies.map((reply) => reply.body)).toEqual(['y']);
  });
});
