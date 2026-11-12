import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { createProject, DEFAULT_PROJECT_ID } from '../../src/domain/projects.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import type {
  GetArtifactOut,
  ListArtifactsOut,
  ListProjectsOut,
  ProjectDetailOut,
  SearchArtifactsOut,
} from '../../src/mcp/schemas.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { postThread } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 10);
const PAGE = { 'index.html': '<h1>Trang</h1>' };

/** What each tool's `structuredContent` holds. */
interface Outputs {
  list_projects: ListProjectsOut;
  get_project: ProjectDetailOut;
  create_project: ProjectDetailOut;
  list_artifacts: ListArtifactsOut;
  search_artifacts: SearchArtifactsOut;
  get_artifact: GetArtifactOut;
}
type Ok<N extends keyof Outputs> = CallToolResult & { structuredContent: Outputs[N] };
const idsOf = (r: { structuredContent: { artifacts: { id: string }[] } }): string[] =>
  r.structuredContent.artifacts.map((a) => a.id);

describe.each(dialects)('MCP library tools on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let ada: { user: UserRow; cookie: string };
  let client: Client;

  async function start(env: Record<string, string> = {}): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
    client = await connectMcp(ctx, { bearer: await createUserToken(ctx, ada.user.id) });
  }

  beforeEach(() => start());
  afterEach(async () => {
    await client.close();
    await ctx.close();
  });

  /** A call as the client sees it, errors included. */
  async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  /** A call that must succeed. */
  async function ok<N extends keyof Outputs>(
    name: N,
    args: Record<string, unknown> = {},
  ): Promise<Ok<N>> {
    const r = await call(name, args);
    expect(r.isError, toolText(r)).toBeFalsy();
    return r as Ok<N>;
  }

  const site = (instructions?: string) =>
    createProject(ctx.deps, ada.user, {
      name: 'Site',
      ...(instructions === undefined ? {} : { instructions }),
    });

  test('get_project returns the instructions and says to follow them', async () => {
    const p = await site('Dùng tiếng Việt. Màu chính #0a7.');
    const r = await ok('get_project', { project_id: p.id });
    expect(r.structuredContent.project).toEqual({
      id: p.id,
      name: 'Site',
      is_default: false,
      archived: false,
      has_instructions: true,
      instructions: 'Dùng tiếng Việt. Màu chính #0a7.',
    });
    expect(toolText(r)).toContain(t('mcp.project.followInstructions'));
    expect(toolText(r)).toContain('Dùng tiếng Việt. Màu chính #0a7.');
    // The id a publish names comes with the text, not only with the structured data.
    expect(toolText(r)).toContain(p.id);
  });

  test('get_project without an id is the default project', async () => {
    const r = await ok('get_project');
    expect(r.structuredContent.project).toEqual({
      id: DEFAULT_PROJECT_ID,
      name: t('project.defaultName'),
      is_default: true,
      archived: false,
      has_instructions: false,
      instructions: '',
    });
    expect(toolText(r)).toContain(t('mcp.project.noInstructions'));
    expect(toolText(r)).not.toContain(t('mcp.project.followInstructions'));
    expect(toolText(r)).toContain(DEFAULT_PROJECT_ID);
  });

  test('instructions of blank space are no instructions', async () => {
    const p = await site(' \n ');
    const r = await ok('get_project', { project_id: p.id });
    expect(r.structuredContent.project).toMatchObject({ has_instructions: false });
    expect(toolText(r)).toContain(t('mcp.project.noInstructions'));
  });

  test('list_projects puts the default first with counts', async () => {
    const p = await site();
    clock.advance(1000);
    await publishFiles(ctx, ada.user, PAGE, {
      kind: 'new_artifact',
      projectId: p.id,
      name: null,
      tags: [],
    });
    const r = await ok('list_projects');
    expect(r.structuredContent).toEqual({
      projects: [
        {
          id: DEFAULT_PROJECT_ID,
          name: t('project.defaultName'),
          is_default: true,
          archived: false,
          has_instructions: false,
          artifact_count: 0,
        },
        {
          id: p.id,
          name: 'Site',
          is_default: false,
          archived: false,
          has_instructions: false,
          artifact_count: 1,
        },
      ],
      next_cursor: null,
    });
    const text = toolText(r);
    expect(text).toContain(DEFAULT_PROJECT_ID);
    expect(text).toContain(p.id);
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
  });

  test('list_projects hides archived projects unless asked, and pages', async () => {
    const a = await site();
    clock.advance(1000);
    const b = await createProject(ctx.deps, ada.user, { name: 'Docs' });
    await ctx.deps.db.db
      .updateTable('projects')
      .set({ archived_at: T })
      .where('id', '=', b.id)
      .execute();

    const active = await ok('list_projects', { limit: 1 });
    expect(active.structuredContent.projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID]);
    const cursor = active.structuredContent.next_cursor as string;
    expect(cursor).toEqual(expect.any(String));
    expect(toolText(active)).toContain(cursor);

    const second = await ok('list_projects', { limit: 1, cursor });
    expect(second.structuredContent.projects.map((p) => p.id)).toEqual([a.id]);
    expect(second.structuredContent.next_cursor).toBeNull();

    const archived = await ok('list_projects', { archived: true });
    expect(archived.structuredContent.projects).toEqual([
      expect.objectContaining({ id: b.id, archived: true, artifact_count: 0 }),
    ]);
  });

  test('create_project creates a project', async () => {
    const r = await ok('create_project', { name: '  Báo cáo  ', instructions: 'Ngắn gọn.' });
    const { project } = r.structuredContent;
    expect(project).toEqual({
      id: expect.stringMatching(/^prj_/),
      name: 'Báo cáo',
      is_default: false,
      archived: false,
      has_instructions: true,
      instructions: 'Ngắn gọn.',
    });
    expect(toolText(r)).toContain(project.id);
    const row = await ctx.deps.db.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: 'Báo cáo',
      instructions: 'Ngắn gọn.',
      created_by: ada.user.id,
    });

    const bare = await ok('create_project', { name: 'Bare' });
    expect(bare.structuredContent.project).toMatchObject({
      instructions: '',
      has_instructions: false,
    });

    const empty = await call('create_project', { name: '' });
    expect(empty.isError).toBe(true);
    const blank = await call('create_project', { name: '   ' });
    expect(blank.isError).toBe(true);
    const long = await call('create_project', { name: 'x'.repeat(101) });
    expect(long.isError).toBe(true);
    const wordy = await call('create_project', { name: 'ok', instructions: 'x'.repeat(20_001) });
    expect(wordy.isError).toBe(true);
    const count = await ctx.deps.db.db
      .selectFrom('projects')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('created_by', '=', ada.user.id)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(2);
  });

  test('search_artifacts finds Vietnamese without diacritics', async () => {
    const { artifact } = await publishFiles(ctx, ada.user, { 'index.html': '<p>chụp ảnh</p>' });
    await publishFiles(ctx, ada.user, { 'index.html': '<p>bảng giá</p>' });
    const r = await ok('search_artifacts', { query: 'chup anh' });
    expect(r.structuredContent.artifacts.map((a) => a.id)).toEqual([artifact.id]);
    expect(r.structuredContent.artifacts[0]?.review_url).toBe(
      `http://localhost:8080/a/${artifact.id}`,
    );
    expect(toolText(r)).toContain(artifact.id);

    const none = await ok('search_artifacts', { query: 'khong co gi' });
    expect(none.structuredContent.artifacts).toEqual([]);
  });

  test('search_artifacts can stay inside one project', async () => {
    const p = await site();
    await publishFiles(ctx, ada.user, { 'index.html': '<p>báo giá</p>' });
    const inSite = await publishFiles(
      ctx,
      ada.user,
      { 'index.html': '<p>báo giá</p>' },
      {
        kind: 'new_artifact',
        projectId: p.id,
        name: null,
        tags: [],
      },
    );
    const r = await ok('search_artifacts', { query: 'bao gia', project_id: p.id });
    expect(r.structuredContent.artifacts.map((a) => a.id)).toEqual([inSite.artifact.id]);
    const both = await ok('search_artifacts', { query: 'bao gia' });
    expect(both.structuredContent.artifacts).toHaveLength(2);
    const limited = await ok('search_artifacts', { query: 'bao gia', limit: 1 });
    expect(limited.structuredContent.artifacts).toHaveLength(1);
  });

  test('list_artifacts filters by project and tag, with open thread counts', async () => {
    const p = await site();
    const target = (projectId: string | null, tags: string[]) => ({
      kind: 'new_artifact' as const,
      projectId,
      name: null,
      tags,
    });
    const a = await publishFiles(ctx, ada.user, PAGE, target(null, ['blog']));
    clock.advance(1000);
    const b = await publishFiles(ctx, ada.user, PAGE, target(p.id, ['blog', 'draft']));
    clock.advance(1000);
    const c = await publishFiles(ctx, ada.user, PAGE, target(p.id, []));
    await postThread(ctx, ada.cookie, b.artifact.id);
    const all = await ok('list_artifacts');
    expect(idsOf(all)).toEqual([c.artifact.id, b.artifact.id, a.artifact.id]);
    expect(all.structuredContent.next_cursor).toBeNull();

    const inSite = await ok('list_artifacts', { project_id: p.id });
    expect(idsOf(inSite)).toEqual([c.artifact.id, b.artifact.id]);
    const blog = await ok('list_artifacts', { tag: 'blog' });
    expect(idsOf(blog)).toEqual([b.artifact.id, a.artifact.id]);
    const both = await ok('list_artifacts', { project_id: p.id, tag: 'blog' });
    expect(idsOf(both)).toEqual([b.artifact.id]);

    expect(both.structuredContent.artifacts[0]).toEqual({
      id: b.artifact.id,
      name: b.artifact.name,
      kind: 'html',
      project_id: p.id,
      tags: ['blog', 'draft'],
      current_version: { id: b.version.id, number: 1 },
      latest_number: 1,
      open_thread_count: 1,
      updated_at: T + 1000,
      review_url: `http://localhost:8080/a/${b.artifact.id}`,
    });
    const quiet = all.structuredContent.artifacts.find((x) => x.id === c.artifact.id);
    expect(quiet?.open_thread_count).toBe(0);

    const text = toolText(both);
    expect(text).toContain(b.artifact.id);
    expect(text).toContain(`http://localhost:8080/a/${b.artifact.id}`);

    const paged = await ok('list_artifacts', { limit: 2 });
    expect(idsOf(paged)).toEqual([c.artifact.id, b.artifact.id]);
    expect(toolText(paged)).toContain(paged.structuredContent.next_cursor);
    const rest = await ok('list_artifacts', {
      limit: 2,
      cursor: paged.structuredContent.next_cursor,
    });
    expect(idsOf(rest)).toEqual([a.artifact.id]);
  });

  test('a name with line breaks stays on one line of the text', async () => {
    const { artifact } = await publishFiles(ctx, ada.user, PAGE, {
      kind: 'new_artifact',
      projectId: null,
      name: 'Bảng\n  giá',
      tags: [],
    });
    expect(artifact.name).toContain('\n');
    const r = await ok('list_artifacts');
    expect(r.structuredContent.artifacts[0]?.name).toBe(artifact.name);
    const lines = toolText(r)
      .split('\n')
      .filter((line) => line.includes(artifact.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(': Bảng giá (');
  });

  test('list_artifacts leaves out archived projects unless one is named', async () => {
    const p = await site();
    const kept = await publishFiles(ctx, ada.user, PAGE);
    const shelved = await publishFiles(ctx, ada.user, PAGE, {
      kind: 'new_artifact',
      projectId: p.id,
      name: null,
      tags: [],
    });
    await ctx.deps.db.db
      .updateTable('projects')
      .set({ archived_at: T })
      .where('id', '=', p.id)
      .execute();
    expect(idsOf(await ok('list_artifacts'))).toEqual([kept.artifact.id]);
    expect(idsOf(await ok('list_artifacts', { project_id: p.id }))).toEqual([shelved.artifact.id]);
    expect(idsOf(await ok('search_artifacts', { query: 'trang' }))).toEqual([kept.artifact.id]);
  });

  test('list_artifacts with an unknown project is a tool error', async () => {
    const r = await call('list_artifacts', { project_id: 'prj_nope' });
    expect(r.isError).toBe(true);
    expect(toolText(r)).toContain(t('project.notFound'));
    expect(toolText(r)).toContain(t('mcp.hint.not_found'));
    const p = await call('get_project', { project_id: 'prj_nope' });
    expect(p.isError).toBe(true);
    expect(toolText(p)).toContain(t('project.notFound'));
  });

  test('get_artifact lists versions newest first with links and the next step', async () => {
    const first = await publishFiles(ctx, ada.user, PAGE, {
      kind: 'new_artifact',
      projectId: null,
      name: 'Bảng giá',
      tags: ['pricing'],
    });
    clock.advance(1000);
    const second = await publishFiles(
      ctx,
      ada.user,
      { 'index.html': '<h1>Trang 2</h1>' },
      {
        kind: 'new_version',
        artifactId: first.artifact.id,
        expectedVersionId: first.version.id,
      },
    );
    const id = first.artifact.id;
    const r = await ok('get_artifact', { artifact_id: id });
    const { artifact, versions } = r.structuredContent;
    expect(artifact).toEqual({
      id,
      name: 'Bảng giá',
      kind: 'html',
      project_id: DEFAULT_PROJECT_ID,
      tags: ['pricing'],
      current_version: { id: second.version.id, number: 2 },
      latest_number: 2,
      open_thread_count: 0,
      updated_at: T + 1000,
      review_url: `http://localhost:8080/a/${id}`,
      raw_url: `http://localhost:8080/a/${id}/raw`,
    });
    expect(versions.map((v) => v.number)).toEqual([2, 1]);
    expect(versions[0]).toEqual({
      id: second.version.id,
      number: 2,
      title: 'Trang 2',
      entry_path: 'index.html',
      file_count: 1,
      total_bytes: Buffer.byteLength('<h1>Trang 2</h1>'),
      message: null,
      source: 'api',
      created_at: T + 1000,
      is_current: true,
      review_url: `http://localhost:8080/a/${id}/v/2`,
      raw_url: `http://localhost:8080/a/${id}/v/2/raw`,
    });
    expect(versions[1]).toMatchObject({
      id: first.version.id,
      number: 1,
      is_current: false,
      review_url: `http://localhost:8080/a/${id}/v/1`,
      raw_url: `http://localhost:8080/a/${id}/v/1/raw`,
    });

    const text = toolText(r);
    expect(text).toContain(id);
    expect(text).toContain(second.version.id);
    expect(text).toContain(first.version.id);
    expect(
      text.endsWith(t('mcp.artifact.next', { artifact_id: id, version_id: second.version.id })),
    ).toBe(true);
  });

  test('get_artifact shows only versions_limit versions', async () => {
    let outcome = await publishFiles(ctx, ada.user, PAGE);
    const id = outcome.artifact.id;
    for (let n = 2; n <= 3; n++) {
      clock.advance(1000);
      outcome = await publishFiles(ctx, ada.user, PAGE, {
        kind: 'new_version',
        artifactId: id,
        expectedVersionId: outcome.version.id,
      });
    }
    const r = await ok('get_artifact', { artifact_id: id, versions_limit: 2 });
    expect(r.structuredContent.versions.map((v) => v.number)).toEqual([3, 2]);
    expect(toolText(r)).toContain(
      t('mcp.artifact.next', { artifact_id: id, version_id: outcome.version.id }),
    );
    const bad = await call('get_artifact', { artifact_id: id, versions_limit: 51 });
    expect(bad.isError).toBe(true);
  });

  test('unknown and deleted ids are tool errors that say what to do', async () => {
    const unknown = await call('get_artifact', { artifact_id: 'art_nope' });
    expect(unknown.isError).toBe(true);
    expect(toolText(unknown)).toContain(t('artifact.notFound'));
    expect(toolText(unknown)).toContain(t('mcp.hint.not_found'));

    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'artifact', key: 'art_gone', expiresAt: null }],
      clock.now(),
    );
    const gone = await call('get_artifact', { artifact_id: 'art_gone' });
    expect(gone.isError).toBe(true);
    expect(toolText(gone)).toContain(t('artifact.gone'));
    expect(toolText(gone)).toContain(t('mcp.hint.gone'));
  });

  test('bad input and a bad cursor are tool errors, not protocol errors', async () => {
    for (const [name, args] of [
      ['list_projects', { limit: 0 }],
      ['list_projects', { limit: 101 }],
      ['list_artifacts', { limit: 101 }],
      ['search_artifacts', { query: '' }],
      ['search_artifacts', { query: '   ' }],
      ['search_artifacts', { query: 'x'.repeat(257) }],
      ['search_artifacts', { query: 'x', limit: 51 }],
      ['get_artifact', {}],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    const r = await call('list_artifacts', { cursor: 'not-a-cursor' });
    expect(r.isError).toBe(true);
    expect(toolText(r)).toContain(t('error.cursor'));
  });

  test('the tools are listed as reads, except create_project', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      'list_projects',
      'get_project',
      'list_artifacts',
      'search_artifacts',
      'get_artifact',
    ]) {
      const tool = byName.get(name);
      expect(tool?.annotations, name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool?.outputSchema, name).toMatchObject({ type: 'object' });
      expect(tool?.description?.length ?? 0, name).toBeGreaterThan(40);
    }
    expect(byName.get('get_project')?.description).toMatch(/before you publish/i);
    expect(byName.get('create_project')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });
});

describe.each(dialects)('MCP library tool links on %s', (dialect) => {
  test('review and raw links use the public origin, not the request host', async () => {
    const ctx = await createTestContext({
      dialect,
      clock: new FixedClock(T),
      env: { PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test', PINWALL_TRUST_PROXY: 'true' },
    });
    const ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
    const client = await connectMcp(ctx, { bearer: await createUserToken(ctx, ada.user.id) });
    try {
      const { artifact } = await publishFiles(ctx, ada.user, PAGE);
      const r = (await client.callTool({
        name: 'get_artifact',
        arguments: { artifact_id: artifact.id },
      })) as Ok<'get_artifact'>;
      expect(r.structuredContent.artifact.review_url).toBe(`https://pinwall.test/a/${artifact.id}`);
      expect(r.structuredContent.versions[0]?.raw_url).toBe(
        `https://pinwall.test/a/${artifact.id}/v/1/raw`,
      );
      expect(toolText(r)).not.toContain('localhost');
    } finally {
      await client.close();
      await ctx.close();
    }
  });
});
