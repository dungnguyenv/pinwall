import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { createProject } from '../../src/domain/projects.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { makeTar } from '../helpers/archives.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { callText, connectMcp, uploadUrlOf } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { spacesContext, spacesFixture, UNKNOWN_IDS } from '../spaces/fixture.ts';

const T = Date.UTC(2026, 10, 10);

/** The version and artifact ids a `publish_inline` text names. */
function publishedIds(text: string): { versionId: string; artifactId: string } {
  const m = /\(version_id (\S+), artifact_id (\S+)\)/.exec(text);
  return { versionId: m?.[1] ?? '', artifactId: m?.[2] ?? '' };
}

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

  /** A call as the agent reads it, errors included. */
  const call = (name: string, args: Record<string, unknown> = {}, on: Client = client) =>
    callText(on, name, args);

  /** A call that must succeed: the text it answers with. */
  async function ok(
    name: string,
    args: Record<string, unknown> = {},
    on: Client = client,
  ): Promise<string> {
    const r = await call(name, args, on);
    expect(r.isError, r.text).toBe(false);
    return r.text;
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
    const text = await ok('create_publish_session', { directory: './site' });
    const url = uploadUrlOf(text);
    expect(url).toMatch(/^http:\/\/localhost:8080\/upload\/[A-Za-z0-9_-]{43}$/);
    expect(text).toBe(
      t('mcp.publish.session', {
        minutes: 10,
        url,
        archive: `tar -czf - -C ./site . | curl --fail-with-body --data-binary @- "${url}"`,
        single: `curl --fail-with-body -H 'Content-Type: text/html' --data-binary @./index.html "${url}"`,
      }),
    );
  });

  test('the commands follow the directory and file the agent names', async () => {
    await start();
    const text = await ok('create_publish_session', {
      directory: 'my site',
      file: 'notes/plan.md',
    });
    const url = uploadUrlOf(text);
    expect(text).toBe(
      t('mcp.publish.session', {
        minutes: 10,
        url,
        archive: `tar -czf - -C 'my site' . | curl --fail-with-body --data-binary @- "${url}"`,
        single: `curl --fail-with-body -H 'Content-Type: text/markdown' --data-binary @notes/plan.md "${url}"`,
      }),
    );
    // Control characters would reach the agent's shell and terminal.
    expect((await call('create_publish_session', { directory: 'a\nb' })).isError).toBe(true);
    expect((await call('create_publish_session', { file: 'x\u001b[2J.html' })).isError).toBe(true);
    expect((await call('create_publish_session', { directory: '' })).isError).toBe(true);
  });

  test("posting a tar to the upload URL publishes as the agent's user", async () => {
    await start();
    const text = await ok('create_publish_session', { message: 'First cut' });
    const body = await makeTar([{ name: 'index.html', body: '<h1>Hi</h1>' }], { gzip: true });
    const up = await ctx.app.request(uploadUrlOf(text), { method: 'POST', body });
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
    expect(bare.text).toBe(t('mcp.publish.needExpected'));

    const stale = await call('create_publish_session', {
      artifact_id: artifact.id,
      expected_version_id: v1.id,
    });
    expect(stale.isError).toBe(true);
    const text = stale.text;
    expect(text).toContain(t('publish.versionConflict', { number: 2 }));
    expect(text).toContain(t('mcp.hint.version_conflict'));
    expect(text).toContain(`"current_version_id":"${v2.version.id}"`);

    const fresh = await ok('create_publish_session', {
      artifact_id: artifact.id,
      expected_version_id: v2.version.id,
    });
    expect(uploadUrlOf(fresh)).not.toBe('');
  });

  test('an upload from a new-version session lands on top of that version', async () => {
    await start();
    const { artifact, version: v1 } = await existing();
    const text = await ok('create_publish_session', {
      artifact_id: artifact.id,
      expected_version_id: v1.id,
    });
    const up = await ctx.app.request(uploadUrlOf(text), {
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
        expect(r.text).toBe(t('mcp.publish.mixedTarget'));
      }
    }
    // The same holds when expected_version_id is missing too.
    const bare = await call('create_publish_session', { artifact_id: artifact.id, name: 'Mới' });
    expect(bare.text).toBe(t('mcp.publish.mixedTarget'));
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
    expect(r.text).toBe(t('mcp.publish.mixedTarget'));
    expect(await versions()).toHaveLength(1);
  });

  test('an unknown artifact or project is refused before any upload', async () => {
    await start();
    const artifact = await call('create_publish_session', {
      artifact_id: 'art_nope',
      expected_version_id: 'ver_nope',
    });
    expect(artifact.isError).toBe(true);
    expect(artifact.text).toContain(t('mcp.hint.not_found'));
    const project = await call('create_publish_session', { project_id: 'prj_nope' });
    expect(project.isError).toBe(true);
    expect(project.text).toContain(t('mcp.hint.not_found'));
  });

  test('publish_inline publishes text files and leads with the review link', async () => {
    await start();
    const text = await ok('publish_inline', {
      files: [
        {
          path: 'index.html',
          content: '<h1>Bảng giá</h1><link rel="stylesheet" href="css/a.css">',
        },
        { path: 'css/a.css', content: 'h1{color:#0a7}' },
      ],
      message: 'Bản đầu',
    });
    const { versionId, artifactId } = publishedIds(text);
    expect(text).toBe(
      t('mcp.publish.done', {
        review_url: `http://localhost:8080/a/${artifactId}`,
        number: 1,
        version_id: versionId,
        artifact_id: artifactId,
      }),
    );

    const [version] = await versions();
    expect(version).toMatchObject({
      id: versionId,
      artifact_id: artifactId,
      source: 'inline',
      created_by: ada.user.id,
      message: 'Bản đầu',
      entry_path: 'index.html',
      file_count: 2,
    });
  });

  test('publish_inline puts a new artifact in the named project with its name and tags', async () => {
    await start();
    const project = await createProject(ctx.deps, ada.user, { name: 'Site' });
    const text = await ok(
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
      .where('id', '=', publishedIds(text).artifactId)
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
    const text = await ok(
      'publish_inline',
      inlineHtml('<h1>Hai</h1>', { artifact_id: artifact.id, expected_version_id: v1.id }),
    );
    const published = publishedIds(text);
    expect(published.artifactId).toBe(artifact.id);
    expect(text).toContain('Published v2 ');

    const stale = await call(
      'publish_inline',
      inlineHtml('<h1>Ba</h1>', { artifact_id: artifact.id, expected_version_id: v1.id }),
    );
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain(t('publish.versionConflict', { number: 2 }));
    expect(stale.text).toContain(`"current_version_id":"${published.versionId}"`);
    expect(await versions()).toHaveLength(2);
  });

  test('publish_inline adds one line per warning', async () => {
    await start();
    const text = await ok(
      'publish_inline',
      inlineHtml('<h1>Hi</h1><link rel="stylesheet" href="/css/site.css"><img src="/logo.png">'),
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    for (const [i, url] of ['/css/site.css', '/logo.png'].entries()) {
      expect(lines[2 + i]).toBe(
        t('mcp.publish.warning', {
          message: t('publish.warning.rootAbsolute', { file: 'index.html', url }),
        }),
      );
    }
  });

  test('a warning is one line of text, whatever the page holds', async () => {
    await start();
    // The URL is the page's own: no escape sequence or line break of it reaches the agent.
    const text = await ok('publish_inline', inlineHtml('<img src="/a\u001b[2J\u0007b.png">'));
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      t('mcp.publish.warning', {
        message: t('publish.warning.rootAbsolute', { file: 'index.html', url: '/a [2J b.png' }),
      }),
    );
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
  });

  test('inline content is validated like an HTTP upload', async () => {
    await start();
    const refused = async (files: { path: string; content: string }[], message: string) => {
      const r = await call('publish_inline', { files });
      expect(r.isError, JSON.stringify(files)).toBe(true);
      expect(r.text).toContain(message);
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
    expect(r.text).toContain(t('publish.inline.textOnly', { path: 'a.png' }));
    expect(await versions()).toEqual([]);
  });

  test("an inline payload at the limit passes even when every '<' is escaped", async () => {
    await start();
    const esc = await connectMcp(ctx, { bearer, rewriteBody: (b) => b.replaceAll('<', '\\u003c') });
    try {
      // About 12 MB of JSON on the wire, three times the SDK's own default cap.
      const atLimit = await call('publish_inline', inlineHtml('<'.repeat(1_999_000)), esc);
      expect(atLimit.isError, atLimit.text).toBe(false);
      const over = await call('publish_inline', inlineHtml('<'.repeat(2_000_001)), esc);
      expect(over.isError).toBe(true);
      expect(over.text).toContain('max_inline_bytes');
      expect(over.text).toContain('create_publish_session');
      expect(await versions()).toHaveLength(1);
    } finally {
      await esc.close();
    }
  });

  /**
   * An artifact whose version 2 was made by `edit_artifact` on top of a full publish: the ids of
   * the artifact and of both versions.
   */
  async function edited(
    files: Record<string, string> = { 'index.html': '<h1>Một</h1>', 'notes.md': '# Ghi chú\n' },
  ) {
    const { artifact, version: v1 } = await existing(files);
    const text = await ok('edit_artifact', {
      artifact_id: artifact.id,
      expected_version_id: v1.id,
      edits: [{ op: 'replace', path: 'index.html', old_string: 'Một', new_string: 'Hai' }],
    });
    return { id: artifact.id, v1: v1.id, v2: publishedIds(text).versionId };
  }

  const stale = [{ path: 'index.html', content: '<h1>Một</h1>' }];

  test('publish_inline over an edited version is refused, then allowed with replace_server_edits', async () => {
    await start();
    const { id, v2 } = await edited();
    const refused = await call('publish_inline', {
      artifact_id: id,
      expected_version_id: v2,
      files: stale,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('"reason":"edited_on_server"');
    expect(refused.text).toContain('index.html');
    expect(refused.text).toContain(t('mcp.hint.conflict.edited_on_server'));
    expect(refused.text).toContain(
      '"paths":["index.html"],"more":0,"versions":[2],"base_version_number":1',
    );
    expect(await versions()).toHaveLength(2);

    const done = await call('publish_inline', {
      artifact_id: id,
      expected_version_id: v2,
      files: stale,
      replace_server_edits: true,
    });
    expect(done.isError, done.text).toBe(false);
    expect(await versions()).toHaveLength(3);
  });

  test('create_publish_session is refused the same way before any URL is made', async () => {
    await start();
    const { id, v2 } = await edited();
    const put = vi.spyOn(ctx.deps.oneTime, 'put');
    const refused = await call('create_publish_session', {
      artifact_id: id,
      expected_version_id: v2,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('"reason":"edited_on_server"');
    expect(refused.text).toContain('index.html');
    expect(refused.text).toContain(t('mcp.hint.conflict.edited_on_server'));
    expect(uploadUrlOf(refused.text)).toBe('');
    expect(put).not.toHaveBeenCalled();

    const allowed = await ok('create_publish_session', {
      artifact_id: id,
      expected_version_id: v2,
      replace_server_edits: true,
    });
    expect(uploadUrlOf(allowed)).not.toBe('');
    expect(put).toHaveBeenCalled();
  });

  test('a full publish on top of a full publish is not checked', async () => {
    await start();
    const { artifact, version: v1 } = await existing();
    const text = await ok('publish_inline', {
      artifact_id: artifact.id,
      expected_version_id: v1.id,
      files: stale,
    });
    // The flag is harmless where there is nothing to discard.
    await ok('publish_inline', {
      artifact_id: artifact.id,
      expected_version_id: publishedIds(text).versionId,
      files: stale,
      replace_server_edits: true,
    });
    const session = await ok('create_publish_session', {
      artifact_id: artifact.id,
      expected_version_id: (await versions()).at(-1)?.id,
    });
    expect(uploadUrlOf(session)).not.toBe('');

    // Once a full publish has replaced the edits, the next one is not checked either.
    const { id, v2 } = await edited();
    const replaced = await ok('publish_inline', {
      artifact_id: id,
      expected_version_id: v2,
      files: stale,
      replace_server_edits: true,
    });
    await ok('publish_inline', {
      artifact_id: id,
      expected_version_id: publishedIds(replaced).versionId,
      files: stale,
    });
  });

  test('a new artifact is never checked', async () => {
    await start();
    await edited();
    await ok('publish_inline', inlineHtml('<p>x</p>', { name: 'Mới' }));
    expect(uploadUrlOf(await ok('create_publish_session', { name: 'Mới nữa' }))).not.toBe('');
  });

  test('a stale expected_version_id is a version conflict, even over edits', async () => {
    await start();
    const { id, v1 } = await edited();
    const r = await call('publish_inline', {
      artifact_id: id,
      expected_version_id: v1,
      files: stale,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(t('mcp.hint.version_conflict'));
    expect(r.text).not.toContain('edited_on_server');
  });

  test('edits on top of edits are listed once each, the newest version first', async () => {
    await start();
    const { id, v2 } = await edited();
    const more = await ok('edit_artifact', {
      artifact_id: id,
      expected_version_id: v2,
      edits: [
        { op: 'replace', path: 'notes.md', old_string: 'Ghi chú', new_string: 'Ghi chú mới' },
        { op: 'replace', path: 'index.html', old_string: 'Hai', new_string: 'Ba' },
      ],
    });
    const refused = await call('publish_inline', {
      artifact_id: id,
      expected_version_id: publishedIds(more).versionId,
      files: stale,
    });
    expect(refused.text).toContain(
      '"paths":["index.html","notes.md"],"more":0,"versions":[3,2],"base_version_number":1',
    );
  });

  test('both publish tools take replace_server_edits, off by default, for discarding on purpose', async () => {
    await start();
    const { tools } = await client.listTools();
    for (const name of ['create_publish_session', 'publish_inline']) {
      const field = tools.find((x) => x.name === name)?.inputSchema.properties
        ?.replace_server_edits;
      expect(field, name).toMatchObject({ type: 'boolean', default: false });
      expect(JSON.stringify(field), name).toContain('discard');
    }
  });

  test('list_artifacts and get_artifact mark edited versions', async () => {
    await start();
    const plain = await existing();
    const { id, v1, v2 } = await edited();
    const list = await ok('list_artifacts');
    const lineOf = (artifactId: string) =>
      list.split('\n').find((line) => line.startsWith(`- ${artifactId}:`)) ?? '';
    expect(lineOf(id)).toContain(
      `${t('mcp.artifact.openThreads', { count: 0 })}; ${t('mcp.artifact.editedOnServer')}) `,
    );
    expect(lineOf(plain.artifact.id)).not.toContain(t('mcp.artifact.editedOnServer'));

    const got = await ok('get_artifact', { artifact_id: id });
    const versionLine = (versionId: string) =>
      got.split('\n').find((line) => line.startsWith('- v') && line.includes(versionId)) ?? '';
    expect(versionLine(v2)).toContain(t('mcp.version.editedOnServer', { paths: 'index.html' }));
    expect(versionLine(v1)).not.toContain('edited on server');
    expect(versionLine(v2)).toContain(' (current): ');

    // A full publish over the edits takes the marks off the current version, not off the history.
    await ok('publish_inline', {
      artifact_id: id,
      expected_version_id: v2,
      files: stale,
      replace_server_edits: true,
    });
    const after = await ok('list_artifacts');
    expect(after.split('\n').find((line) => line.startsWith(`- ${id}:`))).not.toContain(
      t('mcp.artifact.editedOnServer'),
    );
    const history = await ok('get_artifact', { artifact_id: id });
    expect(history.match(/edited on server/g)).toHaveLength(1);
  });

  test('a version line names at most 5 paths and how many more', async () => {
    await start();
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `${n}.html`);
    const files = { 'index.html': '<h1>x</h1>', ...Object.fromEntries(names.map((n) => [n, n])) };
    const { artifact, version: v1 } = await existing(files);
    await ok('edit_artifact', {
      artifact_id: artifact.id,
      expected_version_id: v1.id,
      edits: names.map((path) => ({ op: 'write', path, content: `<p>${path}</p>` })),
    });
    const got = await ok('get_artifact', { artifact_id: artifact.id });
    const line = got.split('\n').find((l) => l.startsWith('- v2 ')) ?? '';
    expect(line).toContain(
      t('mcp.version.editedOnServer', {
        paths: `a.html, b.html, c.html, d.html, e.html ${t('mcp.version.editedMore', { count: 2 })}`,
      }),
    );
    expect(line).not.toContain('f.html');
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
    expect(await ok('create_publish_session')).toContain('expires in 30 minutes');
  });

  test('the tools say what they change', async () => {
    await start();
    const { tools } = await client.listTools();
    for (const name of ['create_publish_session', 'publish_inline']) {
      expect(tools.find((x) => x.name === name)).toMatchObject({
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      });
      expect(tools.find((x) => x.name === name)?.outputSchema, name).toBeUndefined();
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
    expect(limited.text).toContain('Too many requests');
    expect(limited.text).toContain('retry_after_seconds');
    // An inline publish is counted too, and so refused.
    const inline = await call('publish_inline', inlineHtml('<p>x</p>'));
    expect(inline.isError).toBe(true);
    expect(inline.text).toContain('Too many requests');
    expect(await versions()).toEqual([]);
  });
});

describe.each(dialects)(
  'MCP publish tools over server edits in personal spaces on %s',
  (dialect) => {
    let ctx: TestContext;
    let clients: Client[];
    beforeAll(async () => {
      ctx = await spacesContext(dialect, 'personal');
    });
    beforeEach(() => {
      clients = [];
    });
    afterEach(() => Promise.all(clients.map((client) => client.close())));
    afterAll(() => ctx?.close());

    async function as(token: string): Promise<Client> {
      const client = await connectMcp(ctx, { bearer: token });
      clients.push(client);
      return client;
    }

    test('only a caller who may publish there hears of the edits; another space answers not_found', async () => {
      const fx = await spacesFixture(ctx);
      const { A, E, V, S } = fx.people;
      const { p, pV2 } = fx.ids;
      const edit = await callText(await as(E.token), 'edit_artifact', {
        artifact_id: p,
        expected_version_id: pV2,
        edits: [
          { op: 'replace', path: 'index.html', old_string: 'Version 2', new_string: 'Bản 2' },
        ],
      });
      expect(edit.isError, edit.text).toBe(false);
      const v3 = publishedIds(edit.text).versionId;
      const files = [{ path: 'index.html', content: '<h1>Cũ</h1>' }];
      const publishAs = async (token: string, artifactId: string, versionId: string) => {
        const client = await as(token);
        return [
          await callText(client, 'publish_inline', {
            artifact_id: artifactId,
            expected_version_id: versionId,
            files,
          }),
          await callText(client, 'create_publish_session', {
            artifact_id: artifactId,
            expected_version_id: versionId,
          }),
        ];
      };

      for (const viewed of await publishAs(V.token, p, v3)) {
        expect(viewed.isError).toBe(true);
        expect(viewed.text).toContain('"reason":"role"');
        expect(viewed.text).not.toContain('edited_on_server');
      }
      const missing = await publishAs(S.token, UNKNOWN_IDS.p, UNKNOWN_IDS.pV2);
      for (const [i, outsider] of (await publishAs(S.token, p, v3)).entries()) {
        expect(outsider.isError).toBe(true);
        expect(outsider.text).toBe(missing[i]?.text);
        expect(outsider.text).not.toContain('edited_on_server');
      }
      for (const owner of await publishAs(A.token, p, v3)) {
        expect(owner.isError).toBe(true);
        expect(owner.text).toContain('"reason":"edited_on_server"');
      }
    });

    test('replace_server_edits does not open the door for a viewer or a stranger', async () => {
      const fx = await spacesFixture(ctx);
      const { E, V, S } = fx.people;
      const { p, pV2 } = fx.ids;
      const edit = await callText(await as(E.token), 'edit_artifact', {
        artifact_id: p,
        expected_version_id: pV2,
        edits: [
          { op: 'replace', path: 'index.html', old_string: 'Version 2', new_string: 'Bản 2' },
        ],
      });
      const v3 = publishedIds(edit.text).versionId;
      const count = async () =>
        (await ctx.deps.db.db.selectFrom('versions').select('id').execute()).length;
      const before = await count();
      const files = [{ path: 'index.html', content: '<h1>Cũ</h1>' }];
      const put = vi.spyOn(ctx.deps.oneTime, 'put');
      const publishAs = async (token: string, artifactId: string, versionId: string) => {
        const client = await as(token);
        const target = {
          artifact_id: artifactId,
          expected_version_id: versionId,
          replace_server_edits: true,
        };
        return [
          await callText(client, 'publish_inline', { ...target, files }),
          await callText(client, 'create_publish_session', target),
        ];
      };

      try {
        // A viewer is forbidden, with the role reason, and gets neither a version nor a URL.
        const [viewedInline, viewedSession] = await publishAs(V.token, p, v3);
        for (const viewed of [viewedInline, viewedSession]) {
          expect(viewed?.isError).toBe(true);
          expect(viewed?.text).toContain(t('spaces.role.publish'));
          expect(viewed?.text).toContain('"reason":"role"');
          expect(uploadUrlOf(viewed?.text ?? '')).toBe('');
        }
        // Another person's artifact answers as a missing one does.
        const missing = await publishAs(S.token, UNKNOWN_IDS.p, UNKNOWN_IDS.pV2);
        const outsiders = await publishAs(S.token, p, v3);
        for (const [i, outsider] of outsiders.entries()) {
          expect(outsider.isError).toBe(true);
          expect(outsider.text).toBe(missing[i]?.text);
          expect(outsider.text).toContain(t('artifact.notFound'));
          expect(uploadUrlOf(outsider.text)).toBe('');
        }
        expect(await count()).toBe(before);
        expect(put).not.toHaveBeenCalled();
      } finally {
        put.mockRestore();
      }
    });
  },
);
