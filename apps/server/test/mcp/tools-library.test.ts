import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { createProject, DEFAULT_PROJECT_ID } from '../../src/domain/projects.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { formatBytes } from '../../src/mcp/format.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { callText, connectMcp, nextCursor } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { postThread } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 10);
const PAGE = { 'index.html': '<h1>Trang</h1>' };

/** The ids of the artifacts a list or search text shows, in the order it shows them. */
const idsOf = (text: string): string[] =>
  [...text.matchAll(/^- (art_[^:\s]+):/gm)].flatMap((m) => m[1] ?? []);

/** The numbers of the versions `get_artifact` lists, in the order it lists them. */
const versionNumbersOf = (text: string): number[] =>
  [...text.matchAll(/^- ver_[^:\s]+: version (\d+)/gm)].map((m) => Number(m[1]));

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

  /** A call as the agent reads it, errors included. */
  const call = (name: string, args: Record<string, unknown> = {}) => callText(client, name, args);

  /** A call that must succeed: the text it answers with. */
  async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await call(name, args);
    expect(r.isError, r.text).toBe(false);
    return r.text;
  }

  const site = (instructions?: string) =>
    createProject(ctx.deps, ada.user, {
      name: 'Site',
      ...(instructions === undefined ? {} : { instructions }),
    });

  test('get_project returns the instructions and says to follow them', async () => {
    const p = await site('Dùng tiếng Việt. Màu chính #0a7.');
    const text = await ok('get_project', { project_id: p.id });
    // The id a publish names is in the heading.
    expect(text).toBe(
      [
        t('mcp.project.heading', { id: p.id, name: 'Site' }),
        `${t('mcp.project.followInstructions')}\n\nDùng tiếng Việt. Màu chính #0a7.`,
      ].join('\n'),
    );
  });

  test('get_project without an id is the default project', async () => {
    const text = await ok('get_project');
    expect(text).toBe(
      [
        t('mcp.project.heading', { id: DEFAULT_PROJECT_ID, name: t('project.defaultName') }),
        t('mcp.project.noInstructions'),
      ].join('\n'),
    );
  });

  test('instructions of blank space are no instructions', async () => {
    const p = await site(' \n ');
    const text = await ok('get_project', { project_id: p.id });
    expect(text).toContain(t('mcp.project.noInstructions'));
    expect(text).not.toContain(t('mcp.project.followInstructions'));
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
    const text = await ok('list_projects');
    const details = (count: number, ...flags: string[]) =>
      [t('mcp.project.artifacts', { count }), ...flags].join('; ');
    expect(text).toBe(
      [
        t('mcp.projects.summary', { count: 2 }),
        t('mcp.project.item', {
          id: DEFAULT_PROJECT_ID,
          name: t('project.defaultName'),
          details: details(0, t('mcp.project.flagDefault')),
        }),
        t('mcp.project.item', { id: p.id, name: 'Site', details: details(1) }),
      ].join('\n'),
    );
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
    expect(active).toContain(`- ${DEFAULT_PROJECT_ID}:`);
    expect(active).not.toContain(a.id);
    const cursor = nextCursor(active);
    expect(cursor).toEqual(expect.any(String));
    expect(
      active.endsWith(t('mcp.list.more', { tool: 'list_projects', cursor: cursor ?? '' })),
    ).toBe(true);

    const second = await ok('list_projects', { limit: 1, cursor: cursor ?? '' });
    expect(second).toContain(`- ${a.id}:`);
    expect(second).not.toContain(DEFAULT_PROJECT_ID);
    expect(nextCursor(second)).toBeNull();

    const archived = await ok('list_projects', { archived: true });
    expect(archived).toContain(
      t('mcp.project.item', {
        id: b.id,
        name: 'Docs',
        details: `${t('mcp.project.artifacts', { count: 0 })}; ${t('mcp.project.flagArchived')}`,
      }),
    );
    expect(archived).not.toContain(a.id);
  });

  test('create_project creates a project', async () => {
    const text = await ok('create_project', { name: '  Báo cáo  ', instructions: 'Ngắn gọn.' });
    const id = /prj_[^:\s]+/.exec(text)?.[0] ?? '';
    expect(id).not.toBe('');
    expect(text).toBe(t('mcp.project.created', { id, name: 'Báo cáo' }));
    const row = await ctx.deps.db.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      name: 'Báo cáo',
      instructions: 'Ngắn gọn.',
      created_by: ada.user.id,
    });

    const bare = await ok('create_project', { name: 'Bare' });
    const bareId = /prj_[^:\s]+/.exec(bare)?.[0] ?? '';
    expect(await ok('get_project', { project_id: bareId })).toContain(
      t('mcp.project.noInstructions'),
    );

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
    const text = await ok('search_artifacts', { query: 'chup anh' });
    expect(idsOf(text)).toEqual([artifact.id]);
    expect(text).toContain(t('mcp.artifacts.found', { count: 1 }));
    expect(text.endsWith(`http://localhost:8080/a/${artifact.id}`)).toBe(true);

    const none = await ok('search_artifacts', { query: 'khong co gi' });
    expect(none).toBe(t('mcp.artifacts.found', { count: 0 }));
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
    expect(idsOf(r)).toEqual([inSite.artifact.id]);
    const both = await ok('search_artifacts', { query: 'bao gia' });
    expect(idsOf(both)).toHaveLength(2);
    const limited = await ok('search_artifacts', { query: 'bao gia', limit: 1 });
    expect(idsOf(limited)).toHaveLength(1);
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
    expect(nextCursor(all)).toBeNull();

    const inSite = await ok('list_artifacts', { project_id: p.id });
    expect(idsOf(inSite)).toEqual([c.artifact.id, b.artifact.id]);
    const blog = await ok('list_artifacts', { tag: 'blog' });
    expect(idsOf(blog)).toEqual([b.artifact.id, a.artifact.id]);
    const both = await ok('list_artifacts', { project_id: p.id, tag: 'blog' });
    expect(idsOf(both)).toEqual([b.artifact.id]);

    const detail = [
      'html',
      t('mcp.artifact.version', { number: 1 }),
      t('mcp.artifact.openThreads', { count: 1 }),
      t('mcp.artifact.tags', { tags: 'blog, draft' }),
    ].join('; ');
    expect(both).toBe(
      [
        t('mcp.artifacts.summary', { count: 1 }),
        t('mcp.artifact.item', {
          id: b.artifact.id,
          name: b.artifact.name,
          details: detail,
          url: `http://localhost:8080/a/${b.artifact.id}`,
        }),
      ].join('\n'),
    );
    const quiet = all.split('\n').find((line) => line.startsWith(`- ${c.artifact.id}:`));
    expect(quiet).toContain(t('mcp.artifact.openThreads', { count: 0 }));

    const paged = await ok('list_artifacts', { limit: 2 });
    expect(idsOf(paged)).toEqual([c.artifact.id, b.artifact.id]);
    const cursor = nextCursor(paged);
    expect(cursor).toEqual(expect.any(String));
    expect(
      paged.endsWith(t('mcp.list.more', { tool: 'list_artifacts', cursor: cursor ?? '' })),
    ).toBe(true);
    const rest = await ok('list_artifacts', { limit: 2, cursor: cursor ?? '' });
    expect(idsOf(rest)).toEqual([a.artifact.id]);
    expect(nextCursor(rest)).toBeNull();
  });

  test('a name with line breaks stays on one line of the text', async () => {
    const { artifact } = await publishFiles(ctx, ada.user, PAGE, {
      kind: 'new_artifact',
      projectId: null,
      name: 'Bảng\n  giá',
      tags: [],
    });
    expect(artifact.name).toContain('\n');
    const text = await ok('list_artifacts');
    const lines = text.split('\n').filter((line) => line.includes(artifact.id));
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
    expect(r.text).toContain(t('project.notFound'));
    expect(r.text).toContain(t('mcp.hint.not_found'));
    const p = await call('get_project', { project_id: 'prj_nope' });
    expect(p.isError).toBe(true);
    expect(p.text).toContain(t('project.notFound'));
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
    const text = await ok('get_artifact', { artifact_id: id });
    const version = (v: typeof first.version, number: number, current: boolean, bytes: number) =>
      t('mcp.version.item', {
        id: v.id,
        number,
        current: current ? t('mcp.version.current') : '',
        files: 1,
        size: formatBytes(bytes),
        source: 'api',
        created: new Date(T + (number - 1) * 1000).toISOString(),
        review: `http://localhost:8080/a/${id}/v/${number}`,
        raw: `http://localhost:8080/a/${id}/v/${number}/raw`,
      });
    expect(text).toBe(
      [
        t('mcp.artifact.heading', {
          id,
          name: 'Bảng giá',
          details: [
            'html',
            t('mcp.artifact.version', { number: 2 }),
            t('mcp.artifact.openThreads', { count: 0 }),
            t('mcp.artifact.tags', { tags: 'pricing' }),
          ].join('; '),
        }),
        t('mcp.artifact.links', {
          review: `http://localhost:8080/a/${id}`,
          raw: `http://localhost:8080/a/${id}/raw`,
        }),
        t('mcp.artifact.versions'),
        version(second.version, 2, true, Buffer.byteLength('<h1>Trang 2</h1>')),
        version(first.version, 1, false, Buffer.byteLength(PAGE['index.html'])),
        t('mcp.artifact.next', { artifact_id: id, version_id: second.version.id }),
      ].join('\n'),
    );
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
    const text = await ok('get_artifact', { artifact_id: id, versions_limit: 2 });
    expect(versionNumbersOf(text)).toEqual([3, 2]);
    expect(text).toContain(t('mcp.artifact.olderVersions'));
    expect(text).toContain(
      t('mcp.artifact.next', { artifact_id: id, version_id: outcome.version.id }),
    );
    const bad = await call('get_artifact', { artifact_id: id, versions_limit: 51 });
    expect(bad.isError).toBe(true);
  });

  test('unknown and deleted ids are tool errors that say what to do', async () => {
    const unknown = await call('get_artifact', { artifact_id: 'art_nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain(t('artifact.notFound'));
    expect(unknown.text).toContain(t('mcp.hint.not_found'));

    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'artifact', key: 'art_gone', expiresAt: null }],
      clock.now(),
    );
    const gone = await call('get_artifact', { artifact_id: 'art_gone' });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain(t('artifact.gone'));
    expect(gone.text).toContain(t('mcp.hint.gone'));
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
    expect(r.text).toContain(t('error.cursor'));
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
      expect(tool?.outputSchema, name).toBeUndefined();
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
      const { text } = await callText(client, 'get_artifact', { artifact_id: artifact.id });
      expect(text).toContain(`Review page: https://pinwall.test/a/${artifact.id}\n`);
      expect(text).toContain(`raw: https://pinwall.test/a/${artifact.id}/v/1/raw`);
      expect(text).not.toContain('localhost');
    } finally {
      await client.close();
      await ctx.close();
    }
  });
});
