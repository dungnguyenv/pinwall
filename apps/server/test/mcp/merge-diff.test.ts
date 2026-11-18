import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { scopeForUser } from '../../src/domain/spaces.ts';
import { versionConflict } from '../../src/domain/versions.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { conflict, notFound } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { MERGE_DIFF_MAX_CHARS, mergeDiff, refusalAppendix } from '../../src/mcp/merge-diff.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { callText, connectMcp } from '../helpers/mcp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { spacesContext, spacesFixture, UNKNOWN_IDS } from '../spaces/fixture.ts';

const T = Date.UTC(2026, 10, 18);

const HEADING = t('mcp.merge.heading');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const PNG_EDITED = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x09, 0x08]);

const notShown = (path: string) => t('mcp.merge.notShown', { path });

/** Whether a character is a control character other than the tab and the newline, or a line separator. */
function isUnsafe(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
  return (control && code !== 0x09 && code !== 0x0a) || code === 0x2028 || code === 0x2029;
}

/** The version id a publish text names. */
function versionIdOf(text: string): string {
  return /\(version_id (\S+), artifact_id/.exec(text)?.[1] ?? '';
}

describe.each(dialects)('merge diffs on refusals on %s', (dialect) => {
  let ctx: TestContext;
  let ada: { user: UserRow; cookie: string };
  let client: Client;
  let id: string;
  let v1: VersionRow;

  /** Version 1 is made outside MCP, as `files`; the default is a page, notes and an image. */
  async function start(
    files: Record<string, string | Buffer> = {
      'index.html': '<h1>Một</h1>',
      'notes.md': '# Ghi chú\n',
      'img/a.png': PNG,
    },
  ): Promise<void> {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T) });
    ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
    client = await connectMcp(ctx, { bearer: await createUserToken(ctx, ada.user.id) });
    const first = await publishFiles(ctx, ada.user, files);
    id = first.artifact.id;
    v1 = first.version;
  }

  afterEach(async () => {
    await client.close();
    await ctx.close();
  });

  /** A version made outside MCP on top of `base`, as another person's publish would. */
  const next = (files: Record<string, string | Buffer>, base: VersionRow = v1) =>
    publishFiles(ctx, ada.user, files, {
      kind: 'new_version',
      artifactId: id,
      expectedVersionId: base.id,
    });

  const staleInline = (more: Record<string, unknown> = {}) =>
    callText(client, 'publish_inline', {
      artifact_id: id,
      expected_version_id: v1.id,
      files: [{ path: 'index.html', content: '<h1>Ba</h1>' }],
      ...more,
    });

  const scope = () => scopeForUser(ctx.deps, ada.user);

  test('version_conflict from publish_inline carries the diff of what changed', async () => {
    await start();
    await next({ 'index.html': '<h1>Hai</h1>', 'notes.md': '# Ghi chú\n', 'img/a.png': PNG });
    const r = await staleInline();
    expect(r.isError).toBe(true);
    expect(r.text).toContain(HEADING);
    expect(r.text).toContain('-<h1>Một</h1>');
    expect(r.text).toContain('+<h1>Hai</h1>');
    // What did not change is not mentioned.
    expect(r.text).not.toContain('notes.md');
    expect(r.text).not.toContain('a.png');
    // It follows the details line, the last line of the error proper.
    const lines = r.text.split('\n');
    expect(lines[lines.indexOf(HEADING) - 1]).toMatch(/^Details: \{"current_version_id":/);
    expect(lines.indexOf('+<h1>Hai</h1>')).toBeGreaterThan(lines.indexOf(HEADING));
  });

  test('the diff shows the changes between the expected and the current version, in path order', async () => {
    await start();
    const v2 = await next({ 'index.html': '<h1>Hai</h1>', 'notes.md': '# Ghi chú\n' });
    await next(
      { 'index.html': '<h1>Hai</h1>', 'notes.md': '# Ghi chú\nThêm\n', 'b.css': 'p{}' },
      v2.version,
    );
    const r = await staleInline();
    expect(r.text).toContain('-<h1>Một</h1>');
    expect(r.text).toContain('+<h1>Hai</h1>');
    expect(r.text).toContain('+Thêm');
    expect(r.text).toContain('+p{}');
    const at = (path: string) => r.text.indexOf(`--- ${path}\t`);
    expect(at('b.css')).toBeGreaterThan(-1);
    expect(at('b.css')).toBeLessThan(at('index.html'));
    expect(at('index.html')).toBeLessThan(at('notes.md'));
    // The headers say what is compared.
    expect(r.text).toContain('--- index.html\tv1');
    expect(r.text).toContain('+++ index.html\tv3');
    // The image that v2 dropped is named, not diffed.
    expect(r.text).toContain(notShown('img/a.png'));
  });

  test('create_publish_session and edit_artifact carry it too', async () => {
    await start();
    await next({ 'index.html': '<h1>Hai</h1>', 'notes.md': '# Ghi chú\n', 'img/a.png': PNG });
    const session = await callText(client, 'create_publish_session', {
      artifact_id: id,
      expected_version_id: v1.id,
    });
    expect(session.isError).toBe(true);
    expect(session.text).toContain(HEADING);
    expect(session.text).toContain('-<h1>Một</h1>');
    expect(session.text).toContain('+<h1>Hai</h1>');

    const edit = await callText(client, 'edit_artifact', {
      artifact_id: id,
      expected_version_id: v1.id,
      edits: [{ op: 'replace', path: 'notes.md', old_string: 'Ghi chú', new_string: 'Notes' }],
    });
    expect(edit.isError).toBe(true);
    expect(edit.text).toContain(HEADING);
    expect(edit.text).toContain('-<h1>Một</h1>');
    expect(edit.text).toContain('+<h1>Hai</h1>');
    expect((await ctx.deps.db.db.selectFrom('versions').select('id').execute()).length).toBe(2);
  });

  test('a diff past 4,000 characters names the file instead', async () => {
    const many = (word: string) => Array.from({ length: 300 }, (_, i) => `${word} ${i}`).join('\n');
    await start({ 'index.html': many('old'), 'notes.md': '# Ghi chú\n' });
    await next({ 'index.html': many('new'), 'notes.md': '# Ghi chú mới\n' });
    const r = await staleInline();
    expect(r.isError).toBe(true);
    expect(r.text).toContain(HEADING);
    expect(r.text).toContain('index.html (diff not shown: use read_file)');
    expect(r.text).not.toContain('old 17');
    // The smaller file still fits.
    expect(r.text).toContain('+# Ghi chú mới');
  });

  test('the patches shown add up to at most the cap, and not one character over', async () => {
    await start({ 'index.html': '<p>x</p>\n', 'z.html': '<p>x</p>\n' });
    await next({ 'index.html': '<p>y</p>\n', 'z.html': '<p>y</p>\n' });
    const diff = (only: string[] | null, max: number) =>
      mergeDiff(ctx.deps, scope(), id, 1, 2, only, max);
    // One patch each, without the heading line before it.
    const a = (await diff(['index.html'], 10_000)).slice(HEADING.length + 1);
    const b = (await diff(['z.html'], 10_000)).slice(HEADING.length + 1);
    expect(a).toContain('+<p>y</p>');
    const full = await diff(null, 10_000);
    expect(full).toBe([HEADING, a, b].join('\n'));

    // Room for both, with no room to spare.
    expect(await diff(null, a.length + b.length)).toBe(full);
    // One character short: the second file is named instead.
    expect(await diff(null, a.length + b.length - 1)).toBe(
      [HEADING, a, notShown('z.html')].join('\n'),
    );
    // The first no longer fits, so it is named; the next, which is shorter, still does.
    expect(await diff(null, a.length - 1)).toBe([HEADING, notShown('index.html'), b].join('\n'));
    // Room for neither: both are named.
    expect(await diff(null, b.length - 1)).toBe(
      [HEADING, notShown('index.html'), notShown('z.html')].join('\n'),
    );
    expect(MERGE_DIFF_MAX_CHARS).toBe(4_000);
  });

  test('edited_on_server shows only the edited paths', async () => {
    const names = Array.from({ length: 22 }, (_, i) => `f${String(i + 1).padStart(2, '0')}.html`);
    await start({
      'index.html': '<h1>x</h1>',
      ...Object.fromEntries(names.map((name) => [name, '<p>x</p>'])),
    });
    const edited = await callText(client, 'edit_artifact', {
      artifact_id: id,
      expected_version_id: v1.id,
      edits: names.map((path) => ({
        op: 'replace',
        path,
        old_string: 'x',
        new_string: 'y',
      })),
    });
    expect(edited.isError, edited.text).toBe(false);
    const v2 = versionIdOf(edited.text);

    const r = await callText(client, 'publish_inline', {
      artifact_id: id,
      expected_version_id: v2,
      files: [{ path: 'index.html', content: '<h1>stale</h1>' }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"reason":"edited_on_server"');
    expect(r.text).toContain('"more":2');
    expect(r.text).toContain(HEADING);
    // The first 20 paths the refusal names are compared with the version they stop at.
    for (const name of names.slice(0, 20)) {
      expect(r.text, name).toContain(`--- ${name}\tv1`);
      expect(r.text, name).toContain(`+++ ${name}\tv2`);
    }
    expect(r.text).toContain('-<p>x</p>');
    expect(r.text).toContain('+<p>y</p>');
    for (const name of names.slice(20)) expect(r.text.split(HEADING)[1]).not.toContain(name);
    expect(r.text.split(HEADING)[1]).not.toContain('index.html');
    expect(r.text).not.toContain(notShown(names[0] ?? ''));
  });

  test('edited_on_server on a session shows the edited paths too', async () => {
    await start();
    const edited = await callText(client, 'edit_artifact', {
      artifact_id: id,
      expected_version_id: v1.id,
      edits: [{ op: 'replace', path: 'index.html', old_string: 'Một', new_string: 'Hai' }],
    });
    const refused = await callText(client, 'create_publish_session', {
      artifact_id: id,
      expected_version_id: versionIdOf(edited.text),
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('"reason":"edited_on_server"');
    expect(refused.text).toContain(HEADING);
    expect(refused.text).toContain('-<h1>Một</h1>');
    expect(refused.text).toContain('+<h1>Hai</h1>');
  });

  test('mergeDiff limits the diff to the paths asked for', async () => {
    await start();
    await next({ 'index.html': '<h1>Hai</h1>', 'notes.md': '# Mới\n', 'img/a.png': PNG });
    const only = await mergeDiff(ctx.deps, scope(), id, 1, 2, ['notes.md']);
    expect(only).toContain('+# Mới');
    expect(only).not.toContain('index.html');
    const all = await mergeDiff(ctx.deps, scope(), id, 1, 2, null);
    expect(all).toContain('+# Mới');
    expect(all).toContain('+<h1>Hai</h1>');
    // Asking for a path that did not change shows nothing of it.
    expect(await mergeDiff(ctx.deps, scope(), id, 1, 2, ['img/a.png'])).toBe(
      `${HEADING}\n${t('mcp.merge.none')}`,
    );
  });

  test('a binary file is named, not diffed', async () => {
    await start();
    await next({
      'index.html': '<h1>Hai</h1>',
      'notes.md': '# Ghi chú\n',
      'img/a.png': PNG_EDITED,
      'img/new.png': PNG,
    });
    const r = await staleInline();
    expect(r.text).toContain(notShown('img/a.png'));
    expect(r.text).toContain(notShown('img/new.png'));
    expect(r.text).toContain('+<h1>Hai</h1>');
    expect(r.text).not.toContain('PNG');
  });

  test('a text file with a NUL, and one too big to compare, are named too', async () => {
    await start({ 'index.html': '<h1>Một</h1>', 'nul.txt': 'a\n', 'big.txt': 'a\n' });
    await next({
      'index.html': '<h1>Hai</h1>',
      'nul.txt': 'a\u0000b\n',
      // More lines than a diff compares.
      'big.txt': 'b\n'.repeat(50_001),
    });
    const r = await staleInline();
    expect(r.text).toContain(notShown('nul.txt'));
    expect(r.text).toContain(notShown('big.txt'));
    expect(r.text).toContain('+<h1>Hai</h1>');
  });

  test('a diff is page source: control characters other than tab are stripped', async () => {
    await start({ 'index.html': '<h1>Một</h1>' });
    await next({
      'index.html': '<h1>\u001b[2J\u0007Hai</h1>\r\n\tindent\u2028tail\r\n\u009b31mA\u0001B\n',
    });
    const r = await staleInline();
    expect(r.text).toContain(HEADING);
    expect(r.text).toContain('+<h1>[2JHai</h1>');
    // The tab stays; nothing else that could end a line or move a cursor does.
    expect(r.text).toContain('+\tindent tail');
    expect(r.text).toContain('+31mAB');
    expect([...r.text].filter(isUnsafe)).toEqual([]);
    // Every line of the diff starts as a diff line does, so none can pass for tool text.
    const diff = r.text.slice(r.text.indexOf(HEADING)).split('\n').slice(1);
    for (const line of diff.filter((l) => l !== '')) {
      expect(line, line).toMatch(/^(--- |\+\+\+ |@@ |[-+ \\])/);
    }
  });

  test('a path is one line, whatever it holds', async () => {
    await start();
    await next({ 'index.html': '<h1>Hai</h1>', 'a\u2028b.png': PNG });
    const r = await mergeDiff(ctx.deps, scope(), id, 1, 2, null);
    expect(r).toContain(notShown('a b.png'));
    expect(r).not.toContain('\u2028');
  });

  test('when no file differs it says so', async () => {
    await start();
    await next({ 'index.html': '<h1>Một</h1>', 'notes.md': '# Ghi chú\n', 'img/a.png': PNG });
    const r = await staleInline();
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${HEADING}\n${t('mcp.merge.none')}`);
  });

  test('no diff when the expected version is unknown, or belongs to another artifact', async () => {
    await start();
    await next({ 'index.html': '<h1>Hai</h1>', 'notes.md': '# Ghi chú\n', 'img/a.png': PNG });
    const other = await publishFiles(ctx, ada.user, { 'index.html': '<h1>Khác</h1>' });
    for (const expected of ['ver_zzzzzzzzzzzzzzzzzzzz', other.version.id]) {
      const r = await staleInline({ expected_version_id: expected });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(t('mcp.hint.version_conflict'));
      expect(r.text, expected).not.toContain(HEADING);
      expect(r.text).not.toContain('Khác');
    }
  });

  test('refusalAppendix answers only for the two stale-base refusals', async () => {
    await start();
    const v2 = await next({ 'index.html': '<h1>Hai</h1>', 'notes.md': '# Ghi chú\n' });
    const args = { artifact_id: id, expected_version_id: v1.id };
    const appendix = refusalAppendix(ctx.deps, scope(), args);

    const stale = await appendix(versionConflict({ id: v2.version.id, number: 2 }));
    expect(stale).toContain(HEADING);
    expect(stale).toContain('+<h1>Hai</h1>');

    // From the version the edits stop at to the expected one, limited to the edited paths.
    const edited = (more: Record<string, unknown>) =>
      conflict('m', { reason: 'edited_on_server', paths: ['index.html'], more: 0, ...more });
    const onServer = refusalAppendix(ctx.deps, scope(), {
      artifact_id: id,
      expected_version_id: v2.version.id,
    });
    expect(await onServer(edited({ base_version_number: 1 }))).toContain('--- index.html\tv1');
    expect(await onServer(edited({ base_version_number: 1 }))).not.toContain('notes.md');
    // The chain broke at a deleted version: nothing to compare with.
    expect(await onServer(edited({ base_version_number: null }))).toBeNull();
    expect(await onServer(edited({}))).toBeNull();

    // Other refusals, other conflicts and other failures carry nothing.
    expect(await appendix(conflict('m', { reason: 'other' }))).toBeNull();
    expect(await appendix(conflict('m'))).toBeNull();
    expect(await appendix(notFound('m'))).toBeNull();
    expect(await appendix(new Error('boom'))).toBeNull();
    expect(await appendix('boom')).toBeNull();
    // No artifact or no version in the arguments: no way to tell what is stale.
    const noArgs = refusalAppendix(ctx.deps, scope(), {});
    expect(await noArgs(versionConflict({ id: v2.version.id, number: 2 }))).toBeNull();
  });
});

describe.each(dialects)('merge diffs on refusals in personal spaces on %s', (dialect) => {
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

  test('only a caller who may publish there is shown the changes; another space answers not_found', async () => {
    const fx = await spacesFixture(ctx);
    const { A, V, S } = fx.people;
    const { p, pV1 } = fx.ids;
    const files = [{ path: 'index.html', content: '<h1>Cũ</h1>' }];
    const publishAs = async (token: string, artifactId: string, versionId: string) => {
      const client = await connectMcp(ctx, { bearer: token });
      clients.push(client);
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
        await callText(client, 'edit_artifact', {
          artifact_id: artifactId,
          expected_version_id: versionId,
          edits: [{ op: 'delete', path: 'notes.md' }],
        }),
      ];
    };

    for (const owner of await publishAs(A.token, p, pV1)) {
      expect(owner.isError).toBe(true);
      expect(owner.text).toContain(HEADING);
      expect(owner.text).toContain('<h1>Version 2</h1>');
    }
    for (const viewed of await publishAs(V.token, p, pV1)) {
      expect(viewed.isError).toBe(true);
      expect(viewed.text).toContain('"reason":"role"');
      expect(viewed.text).not.toContain(HEADING);
      expect(viewed.text).not.toContain('Version 2');
    }
    const missing = await publishAs(S.token, UNKNOWN_IDS.p, UNKNOWN_IDS.pV1);
    for (const [i, outsider] of (await publishAs(S.token, p, pV1)).entries()) {
      expect(outsider.isError).toBe(true);
      expect(outsider.text).toBe(missing[i]?.text);
      expect(outsider.text).not.toContain(HEADING);
      expect(outsider.text).not.toContain('Version 2');
    }
  });
});
