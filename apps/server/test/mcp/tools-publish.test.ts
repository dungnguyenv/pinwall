import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { createProject } from '../../src/domain/projects.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import type { CreatePublishSessionOut, PublishInlineOut } from '../../src/mcp/schemas.ts';
import { makeTar } from '../helpers/archives.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 10);

/** What each tool's `structuredContent` holds. */
interface Outputs {
  create_publish_session: CreatePublishSessionOut;
  publish_inline: PublishInlineOut;
}
type Ok<N extends keyof Outputs> = CallToolResult & { structuredContent: Outputs[N] };

const inlineHtml = (content: string, extra: Record<string, unknown> = {}) => ({
  files: [{ path: 'index.html', content }],
  ...extra,
});

describe.each(dialects)('MCP publish tools on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let ada: { user: UserRow; cookie: string };
  let bearer: string;
  let client: Client;

  async function start(env: Record<string, string> = {}): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
    bearer = await createUserToken(ctx, ada.user.id);
    client = await connectMcp(ctx, { bearer });
  }

  async function restart(env: Record<string, string>): Promise<void> {
    await client.close();
    await ctx.close();
    await start(env);
  }

  afterEach(async () => {
    await client.close();
    await ctx.close();
  });

  /** A call as the client sees it, errors included. */
  async function call(
    name: string,
    args: Record<string, unknown> = {},
    on: Client = client,
  ): Promise<CallToolResult> {
    return (await on.callTool({ name, arguments: args })) as CallToolResult;
  }

  /** A call that must succeed. */
  async function ok<N extends keyof Outputs>(
    name: N,
    args: Record<string, unknown> = {},
    on: Client = client,
  ): Promise<Ok<N>> {
    const r = await call(name, args, on);
    expect(r.isError, toolText(r)).toBeFalsy();
    return r as Ok<N>;
  }

  const versions = () =>
    ctx.deps.db.db.selectFrom('versions').selectAll().orderBy('number').execute();

  /** An artifact with one published version, made outside MCP. */
  async function existing(files: Record<string, string> = { 'index.html': '<h1>Một</h1>' }) {
    const { artifact, version } = await publishFiles(ctx, ada.user, files);
    return { artifact, version };
  }

  test('create_publish_session returns the upload URL and ready commands', async () => {
    await start();
    const r = await ok('create_publish_session', { directory: './site' });
    const s = r.structuredContent;
    expect(s.upload_url).toMatch(/^http:\/\/localhost:8080\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(s.commands.archive).toBe(
      `tar -czf - -C ./site . | curl --fail-with-body --data-binary @- "${s.upload_url}"`,
    );
    expect(s.commands.single_file).toBe(
      `curl --fail-with-body -H 'Content-Type: text/html' --data-binary @./index.html "${s.upload_url}"`,
    );
    expect(s).toMatchObject({
      expires_at: clock.now() + 600_000,
      expires_in_seconds: 600,
      max_upload_bytes: 95_000_000,
      target: { kind: 'new_artifact', artifact_id: null },
    });
    expect(toolText(r)).toBe(
      t('mcp.publish.session', {
        minutes: 10,
        url: s.upload_url,
        archive: s.commands.archive,
        single: s.commands.single_file,
      }),
    );
  });

  test('the commands follow the directory and file the agent names', async () => {
    await start();
    const r = await ok('create_publish_session', { directory: 'my site', file: 'notes/plan.md' });
    const { upload_url: url, commands } = r.structuredContent;
    expect(commands.archive).toBe(
      `tar -czf - -C 'my site' . | curl --fail-with-body --data-binary @- "${url}"`,
    );
    expect(commands.single_file).toBe(
      `curl --fail-with-body -H 'Content-Type: text/markdown' --data-binary @notes/plan.md "${url}"`,
    );
    // Control characters would reach the agent's shell and terminal.
    expect((await call('create_publish_session', { directory: 'a\nb' })).isError).toBe(true);
    expect((await call('create_publish_session', { file: 'x\u001b[2J.html' })).isError).toBe(true);
    expect((await call('create_publish_session', { directory: '' })).isError).toBe(true);
  });

  test("posting a tar to the upload URL publishes as the agent's user", async () => {
    await start();
    const r = await ok('create_publish_session', { message: 'First cut' });
    const body = await makeTar([{ name: 'index.html', body: '<h1>Hi</h1>' }], { gzip: true });
    const up = await ctx.app.request(r.structuredContent.upload_url, { method: 'POST', body });
    expect(up.status, await up.clone().text()).toBe(201);
    const result = (await up.json()) as { version_number: number; review_url: string };
    expect(result.version_number).toBe(1);
    expect(result.review_url).toMatch(/^http:\/\/localhost:8080\/a\/art_/);

    const [version] = await versions();
    expect(version).toMatchObject({
      number: 1,
      source: 'mcp',
      created_by: ada.user.id,
      message: 'First cut',
    });
  });

  test('a new version needs expected_version_id', async () => {
    await start();
    const { artifact, version: v1 } = await existing();
    const v2 = await publishFiles(
      ctx,
      ada.user,
      { 'index.html': '<h1>Hai</h1>' },
      {
        kind: 'new_version',
        artifactId: artifact.id,
        expectedVersionId: v1.id,
      },
    );

    const bare = await call('create_publish_session', { artifact_id: artifact.id });
    expect(bare.isError).toBe(true);
    expect(toolText(bare)).toBe(t('mcp.publish.needExpected'));

    const stale = await call('create_publish_session', {
      artifact_id: artifact.id,
      expected_version_id: v1.id,
    });
    expect(stale.isError).toBe(true);
    const text = toolText(stale);
    expect(text).toContain(t('publish.versionConflict', { number: 2 }));
    expect(text).toContain(t('mcp.hint.version_conflict'));
    expect(text).toContain(`"current_version_id":"${v2.version.id}"`);

    const fresh = await ok('create_publish_session', {
      artifact_id: artifact.id,
      expected_version_id: v2.version.id,
    });
    expect(fresh.structuredContent.target).toEqual({
      kind: 'new_version',
      artifact_id: artifact.id,
    });
  });

  test('an upload from a new-version session lands on top of that version', async () => {
    await start();
    const { artifact, version: v1 } = await existing();
    const r = await ok('create_publish_session', {
      artifact_id: artifact.id,
      expected_version_id: v1.id,
    });
    const up = await ctx.app.request(r.structuredContent.upload_url, {
      method: 'POST',
      headers: { 'content-type': 'text/html' },
      body: '<h1>Hai</h1>',
    });
    expect(up.status, await up.clone().text()).toBe(201);
    const rows = await versions();
    expect(rows.map((v) => [v.number, v.source, v.parent_version_id])).toEqual([
      [1, 'api', null],
      [2, 'mcp', v1.id],
    ]);
  });

  test('artifact_id cannot be combined with new-artifact fields', async () => {
    await start();
    const { artifact, version } = await existing();
    const target = { artifact_id: artifact.id, expected_version_id: version.id };
    for (const extra of [{ name: 'Mới' }, { project_id: 'prj_x' }, { tags: ['a'] }]) {
      for (const tool of ['create_publish_session', 'publish_inline'] as const) {
        const args = tool === 'publish_inline' ? inlineHtml('<p>x</p>', target) : { ...target };
        const r = await call(tool, { ...args, ...extra });
        expect(r.isError, `${tool} ${JSON.stringify(extra)}`).toBe(true);
        expect(toolText(r)).toBe(t('mcp.publish.mixedTarget'));
      }
    }
    // The same holds when expected_version_id is missing too.
    const bare = await call('create_publish_session', { artifact_id: artifact.id, name: 'Mới' });
    expect(toolText(bare)).toBe(t('mcp.publish.mixedTarget'));
    expect(await versions()).toHaveLength(1);
  });

  test('expected_version_id without artifact_id is refused, not published as a new artifact', async () => {
    await start();
    const { version } = await existing();
    const r = await call(
      'publish_inline',
      inlineHtml('<p>x</p>', { expected_version_id: version.id }),
    );
    expect(r.isError).toBe(true);
    expect(toolText(r)).toBe(t('mcp.publish.mixedTarget'));
    expect(await versions()).toHaveLength(1);
  });

  test('an unknown artifact or project is refused before any upload', async () => {
    await start();
    const artifact = await call('create_publish_session', {
      artifact_id: 'art_nope',
      expected_version_id: 'ver_nope',
    });
    expect(artifact.isError).toBe(true);
    expect(toolText(artifact)).toContain(t('mcp.hint.not_found'));
    const project = await call('create_publish_session', { project_id: 'prj_nope' });
    expect(project.isError).toBe(true);
    expect(toolText(project)).toContain(t('mcp.hint.not_found'));
  });

  test('publish_inline publishes text files and leads with the review link', async () => {
    await start();
    const r = await ok('publish_inline', {
      files: [
        {
          path: 'index.html',
          content: '<h1>Bảng giá</h1><link rel="stylesheet" href="css/a.css">',
        },
        { path: 'css/a.css', content: 'h1{color:#0a7}' },
      ],
      message: 'Bản đầu',
    });
    const s = r.structuredContent;
    expect(s).toMatchObject({
      version_number: 1,
      kind: 'html',
      entry_path: 'index.html',
      file_count: 2,
      warnings: [],
    });
    expect(s.review_url).toBe(`http://localhost:8080/a/${s.artifact_id}`);
    expect(s.raw_url).toBe(`http://localhost:8080/a/${s.artifact_id}/v/1/raw`);
    expect(toolText(r)).toBe(
      t('mcp.publish.done', {
        review_url: s.review_url,
        number: 1,
        version_id: s.version_id,
        artifact_id: s.artifact_id,
      }),
    );

    const [version] = await versions();
    expect(version).toMatchObject({
      id: s.version_id,
      source: 'inline',
      created_by: ada.user.id,
      message: 'Bản đầu',
    });
  });

  test('publish_inline puts a new artifact in the named project with its name and tags', async () => {
    await start();
    const project = await createProject(ctx.deps, ada.user, { name: 'Site' });
    const r = await ok(
      'publish_inline',
      inlineHtml('<h1>Hi</h1>', {
        project_id: project.id,
        name: 'Bảng giá',
        tags: ['pricing', 'q4'],
      }),
    );
    const row = await ctx.deps.db.db
      .selectFrom('artifacts')
      .selectAll()
      .where('id', '=', r.structuredContent.artifact_id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ project_id: project.id, name: 'Bảng giá' });
    const tags = await ctx.deps.db.db
      .selectFrom('artifact_tags')
      .select('tag')
      .where('artifact_id', '=', row.id)
      .orderBy('tag')
      .execute();
    expect(tags.map((x) => x.tag)).toEqual(['pricing', 'q4']);
  });

  test('publish_inline adds a version on top of the one named, and refuses a stale one', async () => {
    await start();
    const { artifact, version: v1 } = await existing();
    const r = await ok(
      'publish_inline',
      inlineHtml('<h1>Hai</h1>', { artifact_id: artifact.id, expected_version_id: v1.id }),
    );
    expect(r.structuredContent).toMatchObject({ artifact_id: artifact.id, version_number: 2 });

    const stale = await call(
      'publish_inline',
      inlineHtml('<h1>Ba</h1>', { artifact_id: artifact.id, expected_version_id: v1.id }),
    );
    expect(stale.isError).toBe(true);
    expect(toolText(stale)).toContain(t('publish.versionConflict', { number: 2 }));
    expect(toolText(stale)).toContain(`"current_version_id":"${r.structuredContent.version_id}"`);
    expect(await versions()).toHaveLength(2);
  });

  test('publish_inline adds one line per warning', async () => {
    await start();
    const r = await ok(
      'publish_inline',
      inlineHtml('<h1>Hi</h1><link rel="stylesheet" href="/css/site.css"><img src="/logo.png">'),
    );
    const { warnings } = r.structuredContent;
    expect(warnings).toHaveLength(2);
    const lines = toolText(r).split('\n');
    expect(lines).toHaveLength(2 + warnings.length);
    for (const [i, w] of warnings.entries()) {
      expect(lines[2 + i]).toBe(t('mcp.publish.warning', { message: w.message }));
    }
  });

  test('inline content is validated like an HTTP upload', async () => {
    await start();
    const refused = async (files: { path: string; content: string }[], message: string) => {
      const r = await call('publish_inline', { files });
      expect(r.isError, JSON.stringify(files)).toBe(true);
      expect(toolText(r)).toContain(message);
    };
    await refused(
      [{ path: '../evil.html', content: '<p>x</p>' }],
      t('publish.path.dot_segment', { path: '../evil.html' }),
    );
    await refused(
      [{ path: '/abs.html', content: '<p>x</p>' }],
      t('publish.path.absolute', { path: '/abs.html' }),
    );
    await refused(
      [
        { path: 'index.html', content: '<p>x</p>' },
        { path: './index.html', content: '<p>y</p>' },
      ],
      t('publish.path.duplicate', { path: 'index.html' }),
    );
    await refused(
      [
        { path: 'a.css', content: 'p{}' },
        { path: 'b.css', content: 'p{}' },
      ],
      t('publish.entry.none'),
    );
    // Nothing to publish, or too many files, never reaches the services.
    expect((await call('publish_inline', { files: [] })).isError).toBe(true);
    const many = Array.from({ length: 1001 }, (_, i) => ({ path: `p${i}.html`, content: 'x' }));
    expect((await call('publish_inline', { files: many })).isError).toBe(true);
    expect(await versions()).toEqual([]);
  });

  test('publish_inline refuses non-text files', async () => {
    await start();
    const r = await call('publish_inline', {
      files: [
        { path: 'index.html', content: '<img src="a.png">' },
        { path: 'a.png', content: 'not really a png' },
      ],
    });
    expect(r.isError).toBe(true);
    expect(toolText(r)).toContain(t('publish.inline.textOnly', { path: 'a.png' }));
    expect(await versions()).toEqual([]);
  });

  test("an inline payload at the limit passes even when every '<' is escaped", async () => {
    await start();
    const esc = await connectMcp(ctx, { bearer, rewriteBody: (b) => b.replaceAll('<', '\\u003c') });
    try {
      // About 12 MB of JSON on the wire, three times the SDK's own default cap.
      const atLimit = await call('publish_inline', inlineHtml('<'.repeat(1_999_000)), esc);
      expect(atLimit.isError, toolText(atLimit)).toBeFalsy();
      const over = await call('publish_inline', inlineHtml('<'.repeat(2_000_001)), esc);
      expect(over.isError).toBe(true);
      expect(toolText(over)).toContain('max_inline_bytes');
      expect(toolText(over)).toContain('create_publish_session');
      expect(await versions()).toHaveLength(1);
    } finally {
      await esc.close();
    }
  });

  test('the descriptions state the configured limit and lifetime', async () => {
    await start();
    const described = async () => {
      const { tools } = await client.listTools();
      const byName = (name: string) => tools.find((x) => x.name === name);
      return {
        session: byName('create_publish_session')?.description ?? '',
        inline: byName('publish_inline')?.description ?? '',
      };
    };
    let d = await described();
    expect(d.inline).toContain('at most 2 MB in total');
    expect(d.session).toContain('(valid 10 minutes)');
    expect(`${d.inline}${d.session}`).not.toContain('{{');

    await restart({ PINWALL_MAX_INLINE_BYTES: '500000', PINWALL_UPLOAD_SESSION_TTL: '30m' });
    d = await described();
    expect(d.inline).toContain('at most 500 KB in total');
    expect(d.session).toContain('(valid 30 minutes)');
    const s = await ok('create_publish_session');
    expect(s.structuredContent.expires_in_seconds).toBe(1800);
    expect(toolText(s)).toContain('expires in 30 minutes');
  });

  test('the tools say what they change', async () => {
    await start();
    const { tools } = await client.listTools();
    for (const name of ['create_publish_session', 'publish_inline']) {
      expect(tools.find((x) => x.name === name)).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        outputSchema: { type: 'object' },
      });
    }
  });

  test('publishing shares the REST rate limit', async () => {
    await start();
    // Thirty upload URLs asked over REST count against the same allowance of sixty.
    for (let i = 0; i < 30; i += 1) {
      const r = await ctx.request(
        '/api/v1/publish-sessions',
        apiInit(ctx, { bearer, body: { target: {} } }),
      );
      expect(r.status).toBe(201);
    }
    for (let i = 0; i < 30; i += 1) await ok('create_publish_session');
    const limited = await call('create_publish_session');
    expect(limited.isError).toBe(true);
    expect(toolText(limited)).toContain('Too many requests');
    expect(toolText(limited)).toContain('retry_after_seconds');
    // An inline publish is counted too, and so refused.
    const inline = await call('publish_inline', inlineHtml('<p>x</p>'));
    expect(inline.isError).toBe(true);
    expect(toolText(inline)).toContain('Too many requests');
    expect(await versions()).toEqual([]);
  });
});
