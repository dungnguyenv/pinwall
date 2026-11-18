import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
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

/** A text of `count` lines, each `width` characters wide and numbered, the ones in `changed` reworded. */
function longText(count: number, word: string, changed: ReadonlySet<number>, width = 200): string {
  const line = (n: number) => {
    const text = `<p>${changed.has(n) ? word : 'same'} ${String(n).padStart(3, '0')} `;
    return `${text}${'.'.repeat(Math.max(0, width - text.length - 4))}</p>`;
  };
  return `${Array.from({ length: count }, (_, n) => line(n)).join('\n')}\n`;
}

/** A merge diff's lines after its heading, grouped: the file headers, each hunk, and the rest. */
interface Shown {
  headers: string[];
  hunks: string[][];
  rest: string[];
}

/**
 * The lines of one file's patch: its `---`/`+++` headers, each hunk (a `@@` line and the lines
 * under it, which start with a space, `+`, `-` or a backslash), and whatever follows the last.
 */
function shownOf(lines: string[]): Shown {
  const first = lines.findIndex((line) => line.startsWith('@@ '));
  const end = first < 0 ? lines.length : first;
  const hunks: string[][] = [];
  let at = end;
  for (; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.startsWith('@@ ')) hunks.push([line]);
    else if (/^[ +\\-]/.test(line)) hunks.at(-1)?.push(line);
    else break;
  }
  return { headers: lines.slice(0, end), hunks, rest: lines.slice(at) };
}

/** Whether a hunk is whole: its header counts match the lines under it. */
function isWhole(hunk: string[]): boolean {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(hunk[0] ?? '');
  if (m === null) return false;
  const body = hunk.slice(1).filter((line) => !line.startsWith('\\'));
  const old = body.filter((line) => line[0] === ' ' || line[0] === '-').length;
  const now = body.filter((line) => line[0] === ' ' || line[0] === '+').length;
  return old === Number(m[2] ?? 1) && now === Number(m[4] ?? 1);
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

  test('the whole text, heading and name lines included, stays within the cap', async () => {
    await start({ 'index.html': '<p>x</p>\n', 'z.html': '<p>x</p>\n' });
    await next({ 'index.html': '<p>y</p>\n', 'z.html': '<p>y</p>\n' });
    const diff = (only: string[] | null, max: number) =>
      mergeDiff(ctx.deps, scope(), id, 1, 2, only, max);
    const more = (count: number) => t('mcp.merge.moreFiles', { count });
    // One patch each, without the heading line before it.
    const a = (await diff(['index.html'], 10_000)).slice(HEADING.length + 1);
    const b = (await diff(['z.html'], 10_000)).slice(HEADING.length + 1);
    expect(a).toContain('+<p>y</p>');
    const full = await diff(null, 10_000);
    expect(full).toBe([HEADING, a, b].join('\n'));
    const nameA = notShown('index.html');
    const nameB = notShown('z.html');
    expect(nameB.length).toBeLessThan(b.length);

    // Room for both, with no room to spare.
    expect(await diff(null, full.length)).toBe(full);
    // One character short: the second file is named instead.
    expect(await diff(null, full.length - 1)).toBe([HEADING, a, nameB].join('\n'));
    // The first patch leaves no room to say that a file follows: it is named, and the next one,
    // which is shorter, is shown if it fits.
    const withReserve = HEADING.length + 1 + a.length + 1 + more(1).length;
    expect(await diff(null, withReserve - 1)).toBe([HEADING, nameA, nameB].join('\n'));
    // Not even the second name fits: the text says how many files it leaves out.
    const stop = HEADING.length + 1 + nameA.length + 1 + more(1).length;
    expect(await diff(null, stop)).toBe([HEADING, nameA, more(1)].join('\n'));
    // Room for one line only: the count of every file.
    const least = HEADING.length + 1 + more(2).length;
    expect(await diff(null, least)).toBe([HEADING, more(2)].join('\n'));
    expect(MERGE_DIFF_MAX_CHARS).toBe(4_000);
  });

  test('whatever the cap, the text fits and counts every file once', async () => {
    const names = Array.from({ length: 6 }, (_, i) => `f${i}.html`);
    await start({
      'index.html': '<h1>x</h1>',
      ...Object.fromEntries(names.map((name) => [name, '<p>x</p>'])),
    });
    await next({
      'index.html': '<h1>y</h1>',
      ...Object.fromEntries(names.map((name, i) => [name, i % 2 === 0 ? '<p>y</p>' : PNG])),
    });
    const more = /^and (\d+) more changed files?$/;
    const least = HEADING.length + 1 + t('mcp.merge.moreFiles', { count: 7 }).length;
    for (let max = least; max < 1_100; max += 11) {
      const text = await mergeDiff(ctx.deps, scope(), id, 1, 2, null, max);
      expect(text.length, `cap ${max}`).toBeLessThanOrEqual(max);
      const lines = text.split('\n').slice(1);
      const last = more.exec(lines.at(-1) ?? '');
      const listed = lines.filter((line) => line.startsWith('--- ') || line.endsWith(')')).length;
      const left = last === null ? 0 : Number(last[1]);
      expect(listed + left, `cap ${max}`).toBe(7);
    }
  });

  /** v1 and v2 of a 500-line page with four changes far apart: the whole patch is over the cap. */
  const FAR_APART = new Set([20, 150, 300, 450]);
  async function farApart(): Promise<void> {
    await start({ 'index.html': longText(500, 'old', FAR_APART) });
    await next({ 'index.html': longText(500, 'new', FAR_APART) });
  }

  test('a patch over the cap shows its headers, the hunks that fit whole, and how many are left', async () => {
    await farApart();
    const full = (await mergeDiff(ctx.deps, scope(), id, 1, 2, null, 100_000)).split('\n');
    expect(shownOf(full.slice(1)).hunks).toHaveLength(4);
    expect(full.join('\n').length).toBeGreaterThan(MERGE_DIFF_MAX_CHARS);

    const r = await staleInline();
    expect(r.isError).toBe(true);
    const diff = r.text.slice(r.text.indexOf(HEADING));
    expect(diff.length).toBeLessThanOrEqual(MERGE_DIFF_MAX_CHARS);
    const { headers, hunks, rest } = shownOf(diff.split('\n').slice(1));
    expect(headers).toEqual(['--- index.html\tv1', '+++ index.html\tv2']);
    // Some, not all; the first ones, in order; none of them cut.
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    expect(hunks.length).toBeLessThan(4);
    for (const [k, hunk] of hunks.entries()) {
      expect(isWhole(hunk), hunk.join('\n')).toBe(true);
      expect(hunk).toEqual(shownOf(full.slice(1)).hunks[k]);
      const [line] = [...FAR_APART].sort((a, b) => a - b).slice(k, k + 1);
      expect(hunk.some((l) => l.startsWith(`-<p>same ${String(line).padStart(3, '0')} `))).toBe(
        false,
      );
      expect(hunk.some((l) => l.startsWith(`-<p>old ${String(line).padStart(3, '0')} `))).toBe(
        true,
      );
    }
    // The count is what was left out, and it is the last line.
    const left = 4 - hunks.length;
    expect(rest).toEqual([t('mcp.merge.moreHunks', { path: 'index.html', count: left })]);
    expect(t('mcp.merge.moreHunks', { path: 'index.html', count: 2 })).toBe(
      'index.html: 2 more changes not shown (use read_file)',
    );
    expect(t('mcp.merge.moreHunks', { path: 'index.html', count: 1 })).toBe(
      'index.html: 1 more change not shown (use read_file)',
    );
    expect(t('mcp.merge.moreFiles', { count: 1 })).toBe('and 1 more changed file');
    expect(t('mcp.merge.moreFiles', { count: 2 })).toBe('and 2 more changed files');
    expect(diff).not.toContain('diff not shown');
    // As many as fit: one more hunk would not have.
    const next = shownOf(full.slice(1)).hunks[hunks.length] ?? [];
    const moreLine = t('mcp.merge.moreHunks', { path: 'index.html', count: left - 1 });
    const withNext = [HEADING, ...headers, ...hunks.flat(), ...next, moreLine].join('\n');
    expect(withNext.length).toBeGreaterThan(MERGE_DIFF_MAX_CHARS);
  });

  test('a patch is cut hunk by hunk, to the character: the headers and the first hunk, or the name', async () => {
    await farApart();
    const diff = (max: number) => mergeDiff(ctx.deps, scope(), id, 1, 2, null, max);
    const { headers, hunks } = shownOf((await diff(100_000)).split('\n').slice(1));
    const more = (count: number) => t('mcp.merge.moreHunks', { path: 'index.html', count });
    const upTo = (n: number) =>
      [HEADING, ...headers, ...hunks.slice(0, n).flat(), more(4 - n)].join('\n');

    for (const n of [1, 2, 3]) {
      expect(await diff(upTo(n).length), `${n} hunks`).toBe(upTo(n));
      // One character less, and it is the one before.
      const fewer = await diff(upTo(n).length - 1);
      expect(fewer, `${n} hunks, one short`).toBe(
        n === 1 ? [HEADING, notShown('index.html')].join('\n') : upTo(n - 1),
      );
    }
    // All four, with no line for the rest, fits only whole.
    const whole = [HEADING, ...headers, ...hunks.flat()].join('\n');
    expect(await diff(whole.length)).toBe(whole);
    expect(await diff(whole.length - 1)).toBe(upTo(3));
  });

  test('every file and every hunk is accounted for once, whatever the cap', async () => {
    const spread = new Set([10, 60, 110, 160]);
    const pair = new Set([5, 90]);
    const v1Files = {
      'a.html': '<p>x</p>\n',
      'b.png': PNG,
      'c.html': '<p>x</p>\n',
      'd.html': longText(100, 'old', pair, 80),
      'e.png': PNG,
      'spread.html': longText(200, 'old', spread, 80),
      'index.html': '<h1>x</h1>\n',
    };
    await start(v1Files);
    await next({
      'a.html': '<p>y</p>\n',
      'b.png': PNG_EDITED,
      'c.html': '<p>y</p>\n',
      'd.html': longText(100, 'new', pair, 80),
      'e.png': PNG_EDITED,
      'spread.html': longText(200, 'new', spread, 80),
      'index.html': '<h1>y</h1>\n',
    });
    const run = (max: number) => mergeDiff(ctx.deps, scope(), id, 1, 2, null, max);
    const everything = 7;
    const hunkCounts = new Map([
      ['a.html', 1],
      ['c.html', 1],
      ['d.html', 2],
      ['index.html', 1],
      ['spread.html', 4],
    ]);
    const whole = await run(100_000);
    expect([...whole.matchAll(/^@@ /gm)]).toHaveLength(9);

    const fileStart = /^--- (.+)\tv1$/;
    const named = /^(.+) \(diff not shown: use read_file\)$/;
    const hunksLeft = /^(.+): (\d+) more changes? not shown \(use read_file\)$/;
    const filesLeft = /^and (\d+) more changed files?$/;
    const least = HEADING.length + 1 + t('mcp.merge.moreFiles', { count: everything }).length;
    const order = ['a.html', 'b.png', 'c.html', 'd.html', 'e.png', 'index.html', 'spread.html'];
    let partial = 0;
    for (let max = least; max <= whole.length + 20; max += 13) {
      const text = await run(max);
      expect(text.length, `cap ${max}`).toBeLessThanOrEqual(max);
      const seen: string[] = [];
      const shown = new Map<string, number>();
      let current = '';
      let left = 0;
      for (const line of text.split('\n').slice(1)) {
        const start = fileStart.exec(line);
        if (start !== null) {
          current = start[1] ?? '';
          seen.push(current);
          shown.set(current, 0);
        } else if (line.startsWith('@@ ')) {
          shown.set(current, (shown.get(current) ?? 0) + 1);
        } else if (hunksLeft.test(line)) {
          const [, path, count] = hunksLeft.exec(line) ?? [];
          expect(path, `cap ${max}`).toBe(current);
          partial += 1;
          shown.set(current, (shown.get(current) ?? 0) + Number(count));
        } else if (named.test(line)) {
          seen.push(named.exec(line)?.[1] ?? '');
        } else if (filesLeft.test(line)) {
          left = Number(filesLeft.exec(line)?.[1]);
        }
      }
      // Each file once, in path order, none skipped; the closing line counts the rest.
      expect(seen, `cap ${max}`).toEqual(order.slice(0, seen.length));
      expect(seen.length + left, `cap ${max}`).toBe(everything);
      // Each hunk of a patch is shown or counted in its file's line.
      for (const [path, count] of shown)
        expect(count, `cap ${max}: ${path}`).toBe(hunkCounts.get(path));
    }
    // The caps went through patches whole, patches cut after a hunk, names and the closing line.
    expect(partial).toBeGreaterThan(5);
  });

  test('a file that cannot be compared is named, and the others are still shown', async () => {
    // Each file has its own text, so its own blob.
    const pages = (word: string) => ({
      'index.html': '<h1>x</h1>\n',
      'a.html': `<p>a ${word}</p>\n`,
      'b.html': `<p>b ${word}</p>\n`,
      'c.html': `<p>c ${word}</p>\n`,
    });
    await start(pages('old'));
    await next(pages('new'));
    const sha = (
      await ctx.deps.db.db
        .selectFrom('version_files')
        .select('sha256')
        .where('version_id', '=', v1.id)
        .where('path', '=', 'b.html')
        .executeTakeFirstOrThrow()
    ).sha256;
    const get = ctx.deps.blobs.get.bind(ctx.deps.blobs);
    const unreadable = vi.spyOn(ctx.deps.blobs, 'get').mockImplementation((key, range) => {
      if (key === sha) return Promise.reject(new Error('the disk lost it'));
      return get(key, range);
    });
    const logged = vi.spyOn(ctx.deps.logger, 'error').mockImplementation(() => {});
    try {
      const text = await mergeDiff(
        ctx.deps,
        scope(),
        id,
        1,
        2,
        null,
        MERGE_DIFF_MAX_CHARS,
        'req_1',
      );
      expect(text.split('\n')).toEqual([
        HEADING,
        '--- a.html\tv1',
        '+++ a.html\tv2',
        '@@ -1,1 +1,1 @@',
        '-<p>a old</p>',
        '+<p>a new</p>',
        notShown('b.html'),
        '--- c.html\tv1',
        '+++ c.html\tv2',
        '@@ -1,1 +1,1 @@',
        '-<p>c old</p>',
        '+<p>c new</p>',
      ]);
      expect(unreadable).toHaveBeenCalled();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ request_id: 'req_1', path: 'b.html', err: expect.any(Error) }),
        expect.any(String),
      );

      // Through the tool, the refusal keeps the rest of the diff and the request's own id.
      logged.mockClear();
      const r = await staleInline();
      expect(r.isError).toBe(true);
      expect(r.text).toContain(notShown('b.html'));
      expect(r.text).toContain('--- a.html\tv1');
      expect(r.text).toContain('--- c.html\tv1');
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ request_id: expect.stringMatching(/\S/), path: 'b.html' }),
        expect.any(String),
      );
    } finally {
      unreadable.mockRestore();
      logged.mockRestore();
    }
  });

  test('300 changed files give a text of at most 4,000 characters, and a count of the rest', async () => {
    const paths = Array.from(
      { length: 300 },
      (_, i) => `pages/page-${String(i).padStart(3, '0')}.html`,
    );
    const page = (path: string, word: string) => `<p>${word} ${path}</p>\n`;
    await start({
      'index.html': '<h1>Một</h1>',
      ...Object.fromEntries(paths.map((path) => [path, page(path, 'cũ')])),
    });
    await next({
      'index.html': '<h1>Hai</h1>',
      ...Object.fromEntries(paths.map((path) => [path, page(path, 'mới')])),
    });
    const read = vi.spyOn(ctx.deps.blobs, 'get');
    try {
      const r = await staleInline();
      expect(r.isError).toBe(true);
      const text = r.text.slice(r.text.indexOf(HEADING));
      expect(text.length).toBeLessThanOrEqual(MERGE_DIFF_MAX_CHARS);
      expect(text.length).toBeGreaterThan(MERGE_DIFF_MAX_CHARS - 300);

      const lines = text.split('\n');
      const left = /^and (\d+) more changed files?$/.exec(lines.at(-1) ?? '');
      expect(left, lines.at(-1)).not.toBeNull();
      // 301 files changed; every one is in a patch, a name line, or the count at the end.
      const patches = lines.filter((line) => line.startsWith('--- ')).length;
      const named = lines.filter((line) => line.endsWith('(diff not shown: use read_file)')).length;
      expect(patches).toBeGreaterThan(10);
      expect(Number(left?.[1])).toBeGreaterThan(200);
      expect(patches + named + Number(left?.[1])).toBe(301);
      expect(lines.at(-1)).toBe(t('mcp.merge.moreFiles', { count: Number(left?.[1]) }));
      // The files left out were not compared, and neither was one whose patch could not fit:
      // every file the text shows was read once, two sides each, and no other.
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(read.mock.calls.length).toBeLessThanOrEqual(2 * (patches + named));
    } finally {
      read.mockRestore();
    }
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
    // Those two changed too, so the diff of everything does show them: the filter is what hides them.
    const everything = await mergeDiff(ctx.deps, scope(), id, 1, 2, null);
    for (const name of names.slice(20)) expect(everything, name).toContain(`--- ${name}\tv1`);
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
    const v2 = await next({ 'index.html': '<h1>Hai</h1>', 'notes.md': '# Ghi chú mới\n' });
    const args = { artifact_id: id, expected_version_id: v1.id };
    const appendix = refusalAppendix(ctx.deps, scope(), args);

    const stale = await appendix(versionConflict({ id: v2.version.id, number: 2 }));
    expect(stale).toContain(HEADING);
    expect(stale).toContain('+<h1>Hai</h1>');
    // notes.md changed as well: the edited paths are what leaves it out below.
    expect(stale).toContain('+# Ghi chú mới');

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
