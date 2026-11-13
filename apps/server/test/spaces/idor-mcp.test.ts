import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_PROJECT_ID } from '../../src/domain/projects.ts';
import { t } from '../../src/lib/i18n.ts';
import type {
  ListArtifactsOut,
  ListProjectsOut,
  ProjectDetailOut,
  SearchArtifactsOut,
} from '../../src/mcp/schemas.ts';
import type { TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
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
      const call = async (name: string, args: Record<string, unknown> = {}) =>
        (await client.callTool({ name, arguments: args })) as CallToolResult;
      return {
        call,
        /** A call that must succeed, with its structured result. */
        ok: async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
          const r = await call(name, args);
          expect(r.isError, toolText(r)).toBeFalsy();
          return r.structuredContent as T;
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
            expect(r.isError === true, toolText(r)).toBe(refused !== undefined);
            if (refused !== undefined) expect(toolText(r)).toContain(refused);
            return;
          }
          const missing = await me.call(name, argsOf(UNKNOWN_IDS));
          expect(r.isError, toolText(r)).toBe(true);
          expect(toolText(r)).toBe(toolText(missing));
          expect(r.structuredContent).toEqual(missing.structuredContent);
        },
      );
    });

    test('list_artifacts and search_artifacts leave out other spaces', async () => {
      const { P, Q, p, q, e } = fx.ids;
      const idsOf = (out: ListArtifactsOut | SearchArtifactsOut) =>
        out.artifacts.map((a) => a.id).sort();
      const stranger = await agent('S');

      if (mode === 'team') {
        // Everyone sees everything, in every project: what personal mode leaves out is there.
        const inP = [p, e].sort();
        expect(
          idsOf(await stranger.ok<ListArtifactsOut>('list_artifacts', { project_id: P })),
        ).toEqual(inP);
        expect(
          idsOf(await stranger.ok<ListArtifactsOut>('list_artifacts', { project_id: Q })),
        ).toEqual([q]);
        const search = await stranger.ok<SearchArtifactsOut>('search_artifacts', {
          query: 'Version',
          project_id: Q,
        });
        expect(idsOf(search)).toEqual([q]);
        return;
      }

      // S is in no project: nothing of A's or E's, however it is asked for.
      expect(await stranger.ok<ListArtifactsOut>('list_artifacts')).toMatchObject({
        artifacts: [],
      });
      expect(
        await stranger.ok<SearchArtifactsOut>('search_artifacts', { query: 'Version' }),
      ).toMatchObject({ artifacts: [] });

      // E is in P: p and e, never q.
      const editor = await agent('E');
      expect(idsOf(await editor.ok<ListArtifactsOut>('list_artifacts'))).toEqual([p, e].sort());
      expect(
        idsOf(await editor.ok<SearchArtifactsOut>('search_artifacts', { query: 'Version' })),
      ).toEqual([p, e].sort());
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
        for (const r of [publish, session, share]) expect(r.isError, toolText(r)).toBeFalsy();
        return;
      }
      expect(publish.isError).toBe(true);
      expect(toolText(publish)).toContain(t('spaces.role.publish'));
      expect(session.isError).toBe(true);
      expect(toolText(session)).toContain(t('spaces.role.publish'));
      expect(share.isError).toBe(true);
      expect(toolText(share)).toContain(t('spaces.role.createShareLink'));
    });

    describe('role and owner of a project', () => {
      const A = () => ({ id: fx.people.A.user.id, name: 'A' });

      test('list_projects and get_project show role and owner in personal mode only', async () => {
        const editor = await agent('E');
        const { projects } = await editor.ok<ListProjectsOut>('list_projects');
        const listed = projects.find((p) => p.id === fx.ids.P);
        const { project } = await editor.ok<ProjectDetailOut>('get_project', {
          project_id: fx.ids.P,
        });

        if (mode === 'team') {
          for (const shown of [listed, project]) {
            expect(shown).toBeDefined();
            expect(shown).not.toHaveProperty('role');
            expect(shown).not.toHaveProperty('owner');
          }
          return;
        }
        expect(listed).toMatchObject({ id: fx.ids.P, role: 'editor', owner: A() });
        expect(project).toMatchObject({ id: fx.ids.P, role: 'editor', owner: A() });
        // E's own default project, made by the listing, is E's.
        expect(projects.filter((p) => p.is_default)).toEqual([
          expect.objectContaining({
            role: 'owner',
            owner: { id: fx.people.E.user.id, name: 'E' },
          }),
        ]);

        const viewer = await agent('V');
        const asViewer = await viewer.ok<ProjectDetailOut>('get_project', { project_id: fx.ids.P });
        expect(asViewer.project).toMatchObject({ role: 'viewer', owner: A() });
      });

      test('create_project shows the same two fields, in personal mode only', async () => {
        const stranger = await agent('S');
        const { project } = await stranger.ok<ProjectDetailOut>('create_project', { name: 'Mine' });
        if (mode === 'team') {
          expect(project).not.toHaveProperty('role');
          expect(project).not.toHaveProperty('owner');
          return;
        }
        expect(project).toMatchObject({
          role: 'owner',
          owner: { id: fx.people.S.user.id, name: 'S' },
        });
      });
    });

    test("get_project without an id is the caller's own default project", async () => {
      const stranger = await agent('S');
      const { project } = await stranger.ok<ProjectDetailOut>('get_project');
      expect(project.is_default).toBe(true);
      if (mode === 'team') {
        expect(project.id).toBe(DEFAULT_PROJECT_ID);
        return;
      }
      const own = await ctx.deps.db.db
        .selectFrom('projects')
        .select('id')
        .where('owner_id', '=', fx.people.S.user.id)
        .where('is_default', '=', 1)
        .execute();
      expect(own.map((row) => row.id)).toEqual([project.id]);
      expect(project).toMatchObject({ role: 'owner', owner: { id: fx.people.S.user.id } });

      // A's default is another project.
      const owner = await agent('A');
      const { project: theirs } = await owner.ok<ProjectDetailOut>('get_project');
      expect(theirs.is_default).toBe(true);
      expect(theirs.id).not.toBe(project.id);
    });
  });
});
