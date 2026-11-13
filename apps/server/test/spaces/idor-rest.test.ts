import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { apiInit } from '../helpers/auth.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import {
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
