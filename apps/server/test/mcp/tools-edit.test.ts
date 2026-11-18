import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { RATE_RULES } from '../../src/auth/rate-limits.ts';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { usageOf } from '../../src/domain/usage.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { DESCRIPTIONS } from '../../src/mcp/descriptions.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { callText, connectMcp } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { exhaustRate, setQuota } from '../moderation/helpers.ts';
import { spacesContext, spacesFixture, UNKNOWN_IDS } from '../spaces/fixture.ts';

const T = Date.UTC(2026, 10, 18);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

/** Path to sha256 of every file of the artifact's current version. */
async function filesOfCurrent(ctx: TestContext, artifactId: string): Promise<Map<string, string>> {
  const rows = await ctx.deps.db.db
    .selectFrom('version_files')
    .innerJoin('artifacts', 'artifacts.current_version_id', 'version_files.version_id')
    .select(['version_files.path as path', 'version_files.sha256 as sha256'])
    .where('artifacts.id', '=', artifactId)
    .execute();
  return new Map(rows.map((row) => [row.path, row.sha256]));
}

/** The artifact's current version row. */
async function currentOf(ctx: TestContext, artifactId: string): Promise<VersionRow> {
  return ctx.deps.db.db
    .selectFrom('versions')
    .innerJoin('artifacts', 'artifacts.current_version_id', 'versions.id')
    .selectAll('versions')
    .where('artifacts.id', '=', artifactId)
    .executeTakeFirstOrThrow();
}

/** The text of `path` in the artifact's current version. */
async function textOf(ctx: TestContext, artifactId: string, path: string): Promise<string> {
  const sha256 = (await filesOfCurrent(ctx, artifactId)).get(path);
  if (sha256 === undefined) throw new Error(`no ${path}`);
  return Buffer.concat(await (await ctx.deps.blobs.get(sha256)).toArray()).toString('utf8');
}

describe.each(dialects)('MCP edit_artifact on %s', (dialect) => {
  let ctx: TestContext;
  let ada: { user: UserRow; cookie: string };
  let client: Client;
  let id: string;
  let v1: VersionRow;
  let v1Files: Map<string, string>;

  async function start(env: Record<string, string> = {}): Promise<void> {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T), env });
    ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
    client = await connectMcp(ctx, { bearer: await createUserToken(ctx, ada.user.id) });
    const first = await publishFiles(ctx, ada.user, {
      'index.html': '<h1>Một</h1>',
      'img/a.png': PNG,
      'notes.md': '# Ghi chú\n\nMột\nHai\nMột\n',
    });
    id = first.artifact.id;
    v1 = first.version;
    v1Files = await filesOfCurrent(ctx, id);
  }

  afterEach(async () => {
    await client.close();
    await ctx.close();
  });

  const edit = (edits: unknown[], more: Record<string, unknown> = {}) =>
    callText(client, 'edit_artifact', {
      artifact_id: id,
      expected_version_id: v1.id,
      edits,
      ...more,
    });

  /** An edit that must succeed: the text it answers with. */
  async function ok(edits: unknown[], more: Record<string, unknown> = {}): Promise<string> {
    const r = await edit(edits, more);
    expect(r.isError, r.text).toBe(false);
    return r.text;
  }

  const versions = () =>
    ctx.deps.db.db.selectFrom('versions').selectAll().orderBy('number').execute();
  const blobRows = () =>
    ctx.deps.db.db.selectFrom('blobs').select('sha256').orderBy('sha256').execute();

  async function storedBlobs(): Promise<string[]> {
    const keys: string[] = [];
    for await (const key of ctx.deps.blobs.list()) keys.push(key);
    return keys.sort();
  }

  test('a replace makes v2 that carries the other files by hash', async () => {
    await start();
    const { text } = await callText(client, 'edit_artifact', {
      artifact_id: id,
      expected_version_id: v1.id,
      edits: [{ op: 'replace', path: 'index.html', old_string: 'Một', new_string: 'Hai' }],
    });
    expect(text).toMatch(/^Review link: /);
    expect(text).toContain('index.html: 1 replacements, now lines 1–1');
    const files = await filesOfCurrent(ctx, id);
    expect(files.get('img/a.png')).toBe(v1Files.get('img/a.png'));
    expect(files.get('notes.md')).toBe(v1Files.get('notes.md'));
    expect(files.get('index.html')).not.toBe(v1Files.get('index.html'));
    const currentVersion = await currentOf(ctx, id);
    expect(JSON.parse(currentVersion.meta).server_edits).toEqual(['index.html']);

    expect(currentVersion).toMatchObject({
      number: 2,
      parent_version_id: v1.id,
      source: 'mcp',
      created_by: ada.user.id,
      file_count: 3,
    });
    expect(await textOf(ctx, id, 'index.html')).toBe('<h1>Hai</h1>');
    expect(text.split('\n')).toEqual([
      `Review link: http://localhost:8080/a/${id}`,
      `Published v2 (version_id ${currentVersion.id}, artifact_id ${id}).`,
      'index.html: 1 replacements, now lines 1–1',
    ]);
  });

  test('write and delete, with a message, one line per file in the order first touched', async () => {
    await start();
    const text = await ok(
      [
        { op: 'write', path: 'docs/a.md', content: '# A\n' },
        { op: 'delete', path: 'img/a.png' },
        { op: 'replace', path: 'notes.md', old_string: 'Một', new_string: 'Ba', replace_all: true },
      ],
      { message: 'Fix the notes' },
    );
    expect(text.split('\n').slice(2)).toEqual([
      'docs/a.md: written',
      'img/a.png: deleted',
      'notes.md: 2 replacements, now lines 3–5',
    ]);
    expect([...(await filesOfCurrent(ctx, id)).keys()].sort()).toEqual([
      'docs/a.md',
      'index.html',
      'notes.md',
    ]);
    expect(await textOf(ctx, id, 'notes.md')).toBe('# Ghi chú\n\nBa\nHai\nBa\n');
    const current = await currentOf(ctx, id);
    expect(current.message).toBe('Fix the notes');
    expect(JSON.parse(current.meta).server_edits).toEqual(['docs/a.md', 'img/a.png', 'notes.md']);
  });

  test('a written page gets its title, and its warnings follow the file lines', async () => {
    await start();
    const text = await ok([
      { op: 'write', path: 'index.html', content: '<title>Mới</title><img src="/logo.png">' },
    ]);
    expect(text.split('\n').slice(2)).toEqual([
      'index.html: written',
      t('mcp.publish.warning', {
        message: t('publish.warning.rootAbsolute', { file: 'index.html', url: '/logo.png' }),
      }),
    ]);
    expect((await currentOf(ctx, id)).title).toBe('Mới');
  });

  test('a failed operation makes no version and stores no blob', async () => {
    await start();
    const blobsBefore = await blobRows();
    const storedBefore = await storedBlobs();
    const r = await edit([
      { op: 'write', path: 'new.css', content: 'p { color: red; }' },
      { op: 'replace', path: 'index.html', old_string: 'Không có', new_string: 'x' },
    ]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(
      'edits[1] (replace index.html) failed: old_string is not in the file.',
    );
    expect(r.text).toContain(t('mcp.hint.bad_request.edit_failed'));
    expect(r.text).toContain('"reason":"edit_failed","index":1,"path":"index.html"');
    expect(r.text).toContain('"problem":"not_found"');
    expect(await versions()).toHaveLength(1);
    expect(await blobRows()).toEqual(blobsBefore);
    expect(await storedBlobs()).toEqual(storedBefore);
  });

  test('a file over the limit fails after staging, and leaves no blob either', async () => {
    await start({ PINWALL_MAX_FILE_BYTES: '100' });
    const blobsBefore = await blobRows();
    const storedBefore = await storedBlobs();
    const r = await edit([
      { op: 'write', path: 'a.css', content: 'a{}' },
      // 40 characters, 120 bytes: only the stored bytes are over the limit.
      { op: 'write', path: 'b.css', content: 'ệ'.repeat(40) },
    ]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"limit":"max_file_bytes"');
    expect(r.text).toContain('b.css');
    expect(await versions()).toHaveLength(1);
    expect(await blobRows()).toEqual(blobsBefore);
    expect(await storedBlobs()).toEqual(storedBefore);
  });

  test('not_found names the lines that match with whitespace or in another Unicode form', async () => {
    await start();
    const spaced = await edit([
      { op: 'replace', path: 'notes.md', old_string: 'Một  \nHai', new_string: 'x' },
    ]);
    expect(spaced.isError).toBe(true);
    expect(spaced.text).toContain('It would match on lines 3 with whitespace collapsed');
    expect(spaced.text).toContain('"whitespace_lines":[3],"unicode_lines":[]');

    const decomposed = await edit([
      { op: 'replace', path: 'index.html', old_string: 'Một'.normalize('NFD'), new_string: 'x' },
    ]);
    expect(decomposed.isError).toBe(true);
    expect(decomposed.text).toContain('in another Unicode form');
    expect(decomposed.text).toContain('"whitespace_lines":[],"unicode_lines":[1]');
  });

  test('a multi-line replace on a CRLF file keeps CRLF on every line, byte for byte', async () => {
    await start();
    const page = '﻿<!doctype html>\r\n<ul>\r\n  <li>Một</li>\r\n  <li>Hai</li>\r\n</ul>\r\n';
    const v2 = await publishFiles(
      ctx,
      ada.user,
      { 'index.html': page },
      { kind: 'new_version', artifactId: id, expectedVersionId: v1.id },
    );
    // As read_file shows the lines: no \r anywhere.
    const text = await ok(
      [
        {
          op: 'replace',
          path: 'index.html',
          old_string: '  <li>Một</li>\n  <li>Hai</li>',
          new_string: '  <li>Một</li>\n  <li>Hai</li>\n  <li>Ba</li>',
        },
      ],
      { expected_version_id: v2.version.id },
    );
    expect(text).toContain('index.html: 1 replacements, now lines 3–5');
    const sha256 = (await filesOfCurrent(ctx, id)).get('index.html') ?? '';
    const bytes = Buffer.concat(await (await ctx.deps.blobs.get(sha256)).toArray());
    expect(
      bytes.equals(Buffer.from(page.replace('</li>\r\n</ul>', '</li>\r\n  <li>Ba</li>\r\n</ul>'))),
    ).toBe(true);
  });

  test('an edit reads at most 20,000,000 bytes of stored files, checked before any is read', async () => {
    await start();
    const pages = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [i === 0 ? 'index.html' : `p${i}.html`, `<p>${i}</p>`]),
    );
    const many = await publishFiles(
      ctx,
      ada.user,
      { ...pages, 'big.css': 'x{}' },
      { kind: 'new_version', artifactId: id, expectedVersionId: v1.id },
    );
    /** Makes the stored size of `path` in that version `size`, as if it were that large. */
    const sizeAs = (path: string, size: number) =>
      ctx.deps.db.db
        .updateTable('version_files')
        .set({ size })
        .where('version_id', '=', many.version.id)
        .where('path', '=', path)
        .execute();
    for (const path of Object.keys(pages)) await sizeAs(path, 4_000_000);
    // Deleted, so never read: it does not count.
    await sizeAs('big.css', 30_000_000);
    const edits = [
      ...Object.keys(pages).map((path) => ({
        op: 'replace',
        path,
        old_string: '<p>',
        new_string: '<p class="x">',
      })),
      { op: 'delete', path: 'big.css' },
    ];

    await sizeAs('p4.html', 4_000_001);
    const get = vi.spyOn(ctx.deps.blobs, 'get');
    const over = await edit(edits, { expected_version_id: many.version.id });
    expect(over.isError).toBe(true);
    expect(over.text).toContain('"reason":"edit_too_large","read_bytes":20000001,"max":20000000');
    expect(over.text).toContain(t('mcp.hint.payload_too_large.edit_too_large'));
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    expect(await versions()).toHaveLength(2);

    await sizeAs('p4.html', 4_000_000);
    const atLimit = await edit(edits, { expected_version_id: many.version.id });
    expect(atLimit.isError, atLimit.text).toBe(false);
    expect(await textOf(ctx, id, 'p4.html')).toBe('<p class="x">4</p>');
  });

  test('several matches need replace_all', async () => {
    await start();
    const r = await edit([{ op: 'replace', path: 'notes.md', old_string: 'Một', new_string: 'x' }]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('old_string occurs 2 times (lines 3, 5)');
    expect(r.text).toContain('"problem":"ambiguous","count":2,"lines":[3,5]');
  });

  test('missing fields, the entry, binary files and path rules are refused', async () => {
    await start();
    const refused = async (edits: unknown[], ...parts: string[]) => {
      const r = await edit(edits);
      expect(r.isError, JSON.stringify(edits)).toBe(true);
      for (const part of parts) expect(r.text, JSON.stringify(edits)).toContain(part);
    };
    await refused(
      [{ op: 'replace', path: 'index.html', new_string: 'x' }],
      '"problem":"missing_fields","fields":["old_string"]',
      'replace needs old_string.',
    );
    await refused([{ op: 'write', path: 'a.css' }], '"fields":["content"]');
    await refused(
      [{ op: 'delete', path: 'index.html' }],
      '"problem":"entry_delete"',
      'the entry page cannot be deleted.',
    );
    await refused(
      [{ op: 'replace', path: 'img/a.png', old_string: 'PNG', new_string: 'x' }],
      '"reason":"not_text"',
    );
    await refused([{ op: 'write', path: 'b.png', content: 'x' }], '"problem":"not_text"');
    await refused(
      [{ op: 'write', path: '../evil.html', content: 'x' }],
      t('publish.path.dot_segment', { path: '../evil.html' }),
    );
    await refused([{ op: 'delete', path: 'nope.css' }], '"problem":"no_file"');
    // The schema: 1 to 100 operations, each with a known op.
    expect((await edit([])).isError).toBe(true);
    const many = Array.from({ length: 101 }, () => ({ op: 'delete', path: 'nope.css' }));
    expect((await edit(many)).isError).toBe(true);
    expect((await edit([{ op: 'rename', path: 'a.css' }])).isError).toBe(true);
    expect(await versions()).toHaveLength(1);
  });

  test('a stale expected_version_id is version_conflict', async () => {
    await start();
    const v2 = await publishFiles(
      ctx,
      ada.user,
      { 'index.html': '<h1>Hai</h1>' },
      { kind: 'new_version', artifactId: id, expectedVersionId: v1.id },
    );
    const r = await edit([
      { op: 'replace', path: 'index.html', old_string: 'Một', new_string: 'Ba' },
    ]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(t('publish.versionConflict', { number: 2 }));
    expect(r.text).toContain(`"current_version_id":"${v2.version.id}"`);
    expect(r.text).toContain(t('mcp.hint.version_conflict'));
    expect(await versions()).toHaveLength(2);
  });

  test('an unknown artifact answers not_found', async () => {
    await start();
    const r = await callText(client, 'edit_artifact', {
      artifact_id: 'art_zzzzzzzzzzzzzzzzzzzz',
      expected_version_id: v1.id,
      edits: [{ op: 'delete', path: 'notes.md' }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(t('artifact.notFound'));
  });

  test('operation text over max_inline_bytes is payload_too_large', async () => {
    await start({ PINWALL_MAX_INLINE_BYTES: '1000' });
    // 'a.css' is 5 bytes; 331 'ệ' are 993, and 2 more ASCII make 1,000.
    const atLimit = await edit([{ op: 'write', path: 'a.css', content: `${'ệ'.repeat(331)}xx` }]);
    expect(atLimit.isError, atLimit.text).toBe(false);

    const v2 = await currentOf(ctx, id);
    const over = await edit(
      [
        { op: 'write', path: 'a.css', content: 'ệ'.repeat(331) },
        { op: 'replace', path: 'index.html', old_string: 'Một', new_string: 'xx' },
      ],
      { expected_version_id: v2.id },
    );
    expect(over.isError).toBe(true);
    expect(over.text).toContain('"limit":"max_inline_bytes","max":1000');
    expect(over.text).toContain(t('mcp.hint.payload_too_large'));
    expect(await versions()).toHaveLength(2);
  });

  test('two edits on the same base: one wins, the other gets version_conflict', async () => {
    await start();
    const [a, b] = await Promise.all([
      edit([{ op: 'replace', path: 'index.html', old_string: 'Một', new_string: 'A' }]),
      edit([{ op: 'replace', path: 'index.html', old_string: 'Một', new_string: 'B' }]),
    ]);
    const results = [a, b].map((r) => r?.isError);
    expect(results.sort()).toEqual([false, true]);
    const loser = [a, b].find((r) => r?.isError);
    expect(loser?.text).toContain(t('publish.versionConflict', { number: 2 }));
    expect(await versions()).toHaveLength(2);
  });

  test('it writes, is described in at most 350 characters, and points to the disk first', async () => {
    await start();
    const { tools } = await client.listTools();
    const tool = tools.find((x) => x.name === 'edit_artifact');
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tool?.outputSchema).toBeUndefined();
    const d = DESCRIPTIONS.edit_artifact.description;
    expect(tool?.description).toBe(d);
    expect(d.length).toBeLessThanOrEqual(350);
    expect(d).toContain('create_publish_session');
    expect(d).toMatch(/on disk/);
  });

  test('editing shares the publish rate limit', async () => {
    await start();
    await exhaustRate(ctx, RATE_RULES.publish, ada.user.id, RATE_RULES.publish.limit);
    const r = await edit([{ op: 'delete', path: 'notes.md' }]);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Too many requests');
    expect(await versions()).toHaveLength(1);
  });
});

describe.each(dialects)('MCP edit_artifact in personal spaces on %s', (dialect) => {
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

  async function editAs(token: string, artifactId: string, versionId: string, edits?: unknown[]) {
    const client = await connectMcp(ctx, { bearer: token });
    clients.push(client);
    return callText(client, 'edit_artifact', {
      artifact_id: artifactId,
      expected_version_id: versionId,
      edits: edits ?? [
        { op: 'replace', path: 'index.html', old_string: 'Version 2', new_string: 'Bản 2' },
      ],
    });
  }

  test('a viewer cannot edit (forbidden, reason role); another space answers not_found', async () => {
    const fx = await spacesFixture(ctx);
    const { V, S, E } = fx.people;
    const { p, pV2 } = fx.ids;

    const viewed = await editAs(V.token, p, pV2);
    expect(viewed.isError).toBe(true);
    expect(viewed.text).toContain(t('spaces.role.publish'));
    expect(viewed.text).toContain('"reason":"role"');

    const outsider = await editAs(S.token, p, pV2);
    const missing = await editAs(S.token, UNKNOWN_IDS.p, UNKNOWN_IDS.pV2);
    expect(outsider.isError).toBe(true);
    expect(outsider.text).toBe(missing.text);
    expect(outsider.text).toContain(t('artifact.notFound'));

    // A viewer is refused before any operation is tried: a bad one reads the same.
    const viewedBad = await editAs(V.token, p, pV2, [{ op: 'delete', path: 'index.html' }]);
    expect(viewedBad.text).toBe(viewed.text);

    const edited = await editAs(E.token, p, pV2);
    expect(edited.isError, edited.text).toBe(false);
    expect(edited.text).toContain('Published v3 ');
  });

  test('the carried files count in full toward the quota', async () => {
    const fx = await spacesFixture(ctx);
    const { A } = fx.people;
    const { p, pV2 } = fx.ids;
    const size = (
      await ctx.deps.db.db
        .selectFrom('versions')
        .select('total_bytes')
        .where('id', '=', pV2)
        .executeTakeFirstOrThrow()
    ).total_bytes;
    const used = (await usageOf(ctx.deps.db.db, ctx.deps.config, A.user.id)).bytes;
    // The replacement keeps the size: the new version is as large as v2.
    const same = [
      { op: 'replace', path: 'index.html', old_string: 'Version 2', new_string: 'Version 3' },
    ];

    await setQuota(ctx, A.user.id, { bytes: used + size - 1 });
    const refused = await editAs(A.token, p, pV2, same);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`"limit_bytes":${used + size - 1}`);
    expect(refused.text).toContain(t('mcp.hint.quota_exceeded'));

    await setQuota(ctx, A.user.id, { bytes: used + size });
    const passed = await editAs(A.token, p, pV2, same);
    expect(passed.isError, passed.text).toBe(false);
    expect((await usageOf(ctx.deps.db.db, ctx.deps.config, A.user.id)).bytes).toBe(used + size);
  });
});
