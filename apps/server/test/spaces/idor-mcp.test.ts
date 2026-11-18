import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_PROJECT_ID, ensureDefaultProject } from '../../src/domain/projects.ts';
import { t } from '../../src/lib/i18n.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { artifactIdsOf, callText, connectMcp } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import {
  type CaseIds,
  MODES,
  type SpacesFixture,
  spacesContext,
  spacesFixture,
  UNKNOWN_IDS,
  type Who,
} from './fixture.ts';

/**
 * Each tool that takes an id of someone else's content, with the arguments that name Q's content
 * (the argument names are the ones of the tool's input schema).
 */
const TOOLS: [string, (ids: CaseIds) => Record<string, unknown>][] = [
  ['get_artifact', (i) => ({ artifact_id: i.q })],
  ['list_comments', (i) => ({ artifact_id: i.q })],
  ['list_share_links', (i) => ({ artifact_id: i.q })],
  ['get_project', (i) => ({ project_id: i.Q })],
  ['reply_to_comment', (i) => ({ comment_id: i.qThread, body: 'x' })],
  ['resolve_comment', (i) => ({ comment_id: i.qThread })],
  ['create_share_link', (i) => ({ artifact_id: i.q })],
  ['revoke_share_link', (i) => ({ share_link_id: i.qLink })],
  ['create_publish_session', (i) => ({ project_id: i.Q })],
  [
    'publish_inline',
    (i) => ({ project_id: i.Q, files: [{ path: 'index.html', content: '<p>x</p>' }] }),
  ],
];

/** Neither E nor S may change A's link in team mode: 1.0 lets only its maker, the publisher or an admin. */
const TEAM_REFUSED: Record<string, string> = { revoke_share_link: t('share.revokeForbidden') };

const WHO: Who[] = ['E', 'S'];

/** The id a `get_project` text names in its heading. */
const projectIdOf = (text: string): string => /^Project (\S+):/.exec(text)?.[1] ?? '';

describe.each(dialects)('MCP tools in spaces on %s', (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    let clients: Client[];
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
    });
    // Calls write, so each test gets its own fixture, in the shared context.
    beforeEach(async () => {
      fx = await spacesFixture(ctx);
      clients = [];
    });
    afterEach(() => Promise.all(clients.map((client) => client.close())));
    afterAll(() => ctx?.close());

    /** `who`'s agent: an MCP client signed in with their API token. */
    async function agent(who: Who) {
      const client = await connectMcp(ctx, { bearer: fx.people[who].token });
      clients.push(client);
      const call = (name: string, args: Record<string, unknown> = {}) =>
        callText(client, name, args);
      return {
        call,
        /** A call that must succeed, with the text it answers with. */
        ok: async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
          const r = await call(name, args);
          expect(r.isError, r.text).toBe(false);
          return r.text;
        },
      };
    }

    describe.each(WHO)("%s calling a tool on someone else's content", (who) => {
      test.each(TOOLS)(
        '%s on Q: personal answers as for an unknown id; team as 1.0',
        async (name, argsOf) => {
          const me = await agent(who);
          const r = await me.call(name, argsOf(fx.ids));
          if (mode === 'team') {
            const refused = TEAM_REFUSED[name];
            expect(r.isError, r.text).toBe(refused !== undefined);
            if (refused !== undefined) expect(r.text).toContain(refused);
            return;
          }
          const missing = await me.call(name, argsOf(UNKNOWN_IDS));
          expect(r.isError, r.text).toBe(true);
          expect(r.text).toBe(missing.text);
        },
      );
    });

    test('list_artifacts, with or without a query, leaves out other spaces', async () => {
      const { P, Q, p, q, e } = fx.ids;
      const idsOf = (text: string) => artifactIdsOf(text).sort();
      const stranger = await agent('S');

      if (mode === 'team') {
        // Everyone sees everything, in every project: what personal mode leaves out is there.
        const inP = [p, e].sort();
        expect(idsOf(await stranger.ok('list_artifacts', { project_id: P }))).toEqual(inP);
        expect(idsOf(await stranger.ok('list_artifacts', { project_id: Q }))).toEqual([q]);
        const search = await stranger.ok('list_artifacts', { query: 'Version', project_id: Q });
        expect(idsOf(search)).toEqual([q]);
        return;
      }

      // S is in no project: nothing of A's or E's, however it is asked for.
      expect(idsOf(await stranger.ok('list_artifacts'))).toEqual([]);
      expect(idsOf(await stranger.ok('list_artifacts', { query: 'Version' }))).toEqual([]);

      // E is in P: p and e, never q.
      const editor = await agent('E');
      expect(idsOf(await editor.ok('list_artifacts'))).toEqual([p, e].sort());
      expect(idsOf(await editor.ok('list_artifacts', { query: 'Version' }))).toEqual([p, e].sort());
    });

    test('a viewer is told why it cannot publish or share', async () => {
      const viewer = await agent('V');
      const publish = await viewer.call('publish_inline', {
        project_id: fx.ids.P,
        files: [{ path: 'index.html', content: '<p>Viewer</p>' }],
      });
      const session = await viewer.call('create_publish_session', { project_id: fx.ids.P });
      const share = await viewer.call('create_share_link', { artifact_id: fx.ids.p });

      if (mode === 'team') {
        for (const r of [publish, session, share]) expect(r.isError, r.text).toBe(false);
        return;
      }
      expect(publish.isError).toBe(true);
      expect(publish.text).toContain(t('spaces.role.publish'));
      expect(session.isError).toBe(true);
      expect(session.text).toContain(t('spaces.role.publish'));
      expect(share.isError).toBe(true);
      expect(share.text).toContain(t('spaces.role.createShareLink'));
    });

    describe('the projects a caller sees and makes', () => {
      test('list_projects and get_project show the projects of the space the caller is in', async () => {
        const editor = await agent('E');
        const listed = await editor.ok('list_projects');
        expect(listed).toContain(`- ${fx.ids.P}:`);
        // One default project: the shared one in team mode, E's own, made by the listing, in personal mode.
        const defaults = listed.split('\n').filter((l) => l.includes(t('mcp.project.flagDefault')));
        expect(defaults).toHaveLength(1);
        expect(projectIdOf(await editor.ok('get_project', { project_id: fx.ids.P }))).toBe(
          fx.ids.P,
        );

        // A viewer reads the project's instructions too.
        const viewer = await agent('V');
        expect(projectIdOf(await viewer.ok('get_project', { project_id: fx.ids.P }))).toBe(
          fx.ids.P,
        );
      });

      test('list_projects and get_project show role and owner in personal mode only', async () => {
        const lineOf = (text: string, id: string) =>
          text.split('\n').find((line) => line.startsWith(`- ${id}:`)) ?? '';
        const editor = await agent('E');
        const listed = await editor.ok('list_projects');
        const heading = (await editor.ok('get_project', { project_id: fx.ids.P })).split('\n')[0];
        if (mode === 'team') {
          expect(listed).not.toContain('role:');
          expect(listed).not.toContain('owner:');
          expect(heading).toBe(t('mcp.project.heading', { id: fx.ids.P, name: 'P' }));
          return;
        }
        const space = (role: string, owner: string) =>
          `${t('mcp.project.role', { role })}; ${t('mcp.project.owner', { owner })}`;
        expect(lineOf(listed, fx.ids.P)).toContain(`; ${space('editor', 'A')})`);
        expect(heading).toBe(
          t('mcp.project.headingSpace', {
            id: fx.ids.P,
            name: 'P',
            details: space('editor', 'A'),
          }),
        );
        // E's own default project, made by the listing, is E's.
        const defaults = listed.split('\n').filter((l) => l.includes(t('mcp.project.flagDefault')));
        expect(defaults).toHaveLength(1);
        expect(defaults[0]).toContain(space('owner', 'E'));

        const viewer = await agent('V');
        const asViewer = await viewer.ok('get_project', { project_id: fx.ids.P });
        expect(asViewer.split('\n')[0]).toContain(space('viewer', 'A'));
      });

      test('create_project makes a project the caller owns', async () => {
        const stranger = await agent('S');
        const text = await stranger.ok('create_project', { name: 'Mine' });
        const id = /prj_[^:\s]+/.exec(text)?.[0] ?? '';
        expect(text).toBe(t('mcp.project.created', { id, name: 'Mine' }));
        const row = await ctx.deps.db.db
          .selectFrom('projects')
          .select('owner_id')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        expect(row.owner_id).toBe(fx.people.S.user.id);
      });
    });

    test("get_project without an id is the caller's own default project", async () => {
      const stranger = await agent('S');
      const project = projectIdOf(await stranger.ok('get_project'));
      if (mode === 'team') {
        expect(project).toBe(DEFAULT_PROJECT_ID);
        return;
      }
      const own = await ctx.deps.db.db
        .selectFrom('projects')
        .select('id')
        .where('owner_id', '=', fx.people.S.user.id)
        .where('is_default', '=', 1)
        .execute();
      expect(own.map((row) => row.id)).toEqual([project]);

      // A's default is another project.
      const owner = await agent('A');
      const theirs = projectIdOf(await owner.ok('get_project'));
      expect(theirs).not.toBe('');
      expect(theirs).not.toBe(project);
    });
  });
});

/**
 * Each tool that takes a project id, with the arguments that name `projectId`: the default
 * project's well-known id, or an unknown one.
 */
const PROJECT_TOOLS: [string, (projectId: string) => Record<string, unknown>][] = [
  ['get_project', (projectId) => ({ project_id: projectId })],
  ['list_artifacts', (projectId) => ({ project_id: projectId })],
  ['list_artifacts', (projectId) => ({ query: 'Default', project_id: projectId })],
  ['create_publish_session', (projectId) => ({ project_id: projectId })],
  [
    'publish_inline',
    (projectId) => ({
      project_id: projectId,
      files: [{ path: 'index.html', content: '<p>x</p>' }],
    }),
  ],
];

describe.each(dialects)("MCP tools on someone else's default project on %s", (dialect) => {
  describe.each(MODES)('in %s mode', (mode) => {
    let ctx: TestContext;
    let fx: SpacesFixture;
    let clients: Client[];
    beforeAll(async () => {
      ctx = await spacesContext(dialect, mode);
      fx = await spacesFixture(ctx);
      // The default of a fresh instance; A's first publish without a project lands there, which
      // in personal mode makes it A's.
      await ensureDefaultProject(ctx.deps);
      const { artifact } = await publishFiles(ctx, fx.people.A.user, {
        'index.html': '<!doctype html><h1>Default</h1>',
      });
      expect(artifact.project_id).toBe(DEFAULT_PROJECT_ID);
    });
    beforeEach(() => {
      clients = [];
    });
    afterEach(() => Promise.all(clients.map((client) => client.close())));
    afterAll(() => ctx?.close());

    /** A call of `name` by `who`'s agent, signed in with their API token. */
    async function callAs(who: Who, name: string, args: Record<string, unknown>) {
      const client = await connectMcp(ctx, { bearer: fx.people[who].token });
      clients.push(client);
      return callText(client, name, args);
    }

    test('A reads it as its owner in personal mode, as everyone does in team mode', async () => {
      const r = await callAs('A', 'get_project', { project_id: DEFAULT_PROJECT_ID });
      expect(r.isError, r.text).toBe(false);
      expect(projectIdOf(r.text)).toBe(DEFAULT_PROJECT_ID);
    });

    describe.each(['S', 'X'] as const)('%s naming it', (who) => {
      test.each(PROJECT_TOOLS)(
        '%s: personal answers as for an unknown project; team as 1.0',
        async (name, argsOf) => {
          const r = await callAs(who, name, argsOf(DEFAULT_PROJECT_ID));
          if (mode === 'team') {
            expect(r.isError, r.text).toBe(false);
            return;
          }
          const missing = await callAs(who, name, argsOf(UNKNOWN_IDS.P));
          expect(r.isError, r.text).toBe(true);
          expect(r.text).toBe(missing.text);
        },
      );
    });
  });
});
