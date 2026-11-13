import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MARKDOWN_RENDER_MAX_BYTES } from '../../src/content/markdown.ts';
import type { UserRow } from '../../src/db/schema.ts';
import {
  diffMarkdownBlocks,
  diffMarkdownFile,
  diffTextFile,
  diffVersionFiles,
  MARKDOWN_DIFF_MAX_EDITS,
  TEXT_DIFF_MAX_BYTES,
  TEXT_DIFF_MAX_LINES,
} from '../../src/domain/diff.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { sha } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 11);
const INDEX = '<!doctype html><p>x</p>';

/** Lines of random hex: no two alike, so two such files share nothing. */
const randomLines = (count: number) =>
  `${Array.from({ length: count }, () => randomBytes(8).toString('hex')).join('\n')}\n`;

/** What the promise rejects with, as an `AppError`. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('rendered Markdown diff', () => {
  const ops = (a: string, b: string) => diffMarkdownBlocks(a, b).map((o) => o.op);

  test('marks blocks', () => {
    const blocks = diffMarkdownBlocks('# T\n\nA\n\nB\n\nC\n', '# T\n\nA\n\nB2\n\nD\n\nC\n');
    expect(blocks.map((o) => o.op)).toEqual([
      'unchanged',
      'unchanged',
      'changed',
      'added',
      'unchanged',
    ]);
    expect(blocks[2]).toMatchObject({ old_html: '<p>B</p>\n', new_html: '<p>B2</p>\n' });
    expect(blocks[3]).toEqual({ op: 'added', old_html: null, new_html: '<p>D</p>\n' });
    expect(blocks[1]).toEqual({ op: 'unchanged', old_html: '<p>A</p>\n', new_html: '<p>A</p>\n' });
  });

  test('marks removed blocks and pairs a replaced run block by block', () => {
    expect(diffMarkdownBlocks('A\n\nB\n\nC\n', 'A\n\nC\n')[1]).toEqual({
      op: 'removed',
      old_html: '<p>B</p>\n',
      new_html: null,
    });
    // One block became three: a pair and two leftovers.
    expect(ops('A\n\nB\n\nC\n', 'A\n\nX\n\nY\n\nZ\n\nC\n')).toEqual([
      'unchanged',
      'changed',
      'added',
      'added',
      'unchanged',
    ]);
    // Two blocks became two others: two pairs.
    expect(ops('A\n\nB\n\nC\n\nD\n', 'A\n\nX\n\nY\n\nD\n')).toEqual([
      'unchanged',
      'changed',
      'changed',
      'unchanged',
    ]);
    // Two blocks became one: a pair and a leftover.
    expect(ops('A\n\nB\n\nC\n\nD\n', 'A\n\nX\n\nD\n')).toEqual([
      'unchanged',
      'changed',
      'removed',
      'unchanged',
    ]);
  });

  test('lists, fences and tables are single blocks', () => {
    const list = (second: string) => `Intro\n\n- one\n- ${second}\n- three\n\nOutro\n`;
    expect(ops(list('two'), list('2'))).toEqual(['unchanged', 'changed', 'unchanged']);

    const fence = (body: string) => `Intro\n\n\`\`\`ts\nlet a = 1;\n\n\n${body}\n\`\`\`\n`;
    expect(ops(fence('b'), fence('c'))).toEqual(['unchanged', 'changed']);

    const table = (cell: string) => `| h | i |\n| - | - |\n| 1 | ${cell} |\n\nAfter\n`;
    expect(ops(table('2'), table('3'))).toEqual(['changed', 'unchanged']);
  });

  test('a document and nothing', () => {
    expect(diffMarkdownBlocks('', '')).toEqual([]);
    expect(ops('', '# T\n\nA\n')).toEqual(['added', 'added']);
    expect(ops('# T\n\nA\n', '')).toEqual(['removed', 'removed']);
    expect(ops('A\n', 'A\n')).toEqual(['unchanged']);
  });

  test('whitespace between blocks and line endings are not changes', () => {
    expect(ops('# T\n\nA\n\nB\n', '# T\r\n\r\n\r\nA\r\n\r\n\r\n\r\nB')).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  test('a block whose references changed is changed though its source is not', () => {
    const doc = (url: string) => `See [d].\n\n[d]: ${url}\n`;
    const blocks = diffMarkdownBlocks(doc('https://a.example/'), doc('https://b.example/'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      op: 'changed',
      old_html: '<p>See <a href="https://a.example/">d</a>.</p>\n',
      new_html: '<p>See <a href="https://b.example/">d</a>.</p>\n',
    });
  });

  test('the blocks of each side add up to the whole document', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `para ${i}`);
    const before = paragraphs.join('\n\n');
    // Drop every 5th, change every 7th, add after every 11th.
    const after = paragraphs
      .flatMap((p, i) => [
        i % 5 === 0 ? null : i % 7 === 0 ? `${p} edited` : p,
        i % 11 === 0 ? `new ${i}` : null,
      ])
      .filter((p) => p !== null)
      .join('\n\n');
    const result = diffMarkdownBlocks(before, after);
    const side = (src: string) => src.split('\n\n').map((p) => `<p>${p}</p>\n`);
    expect(result.flatMap((o) => (o.old_html === null ? [] : [o.old_html]))).toEqual(side(before));
    expect(result.flatMap((o) => (o.new_html === null ? [] : [o.new_html]))).toEqual(side(after));
    expect(new Set(result.map((o) => o.op))).toEqual(
      new Set(['unchanged', 'changed', 'added', 'removed']),
    );
  });

  test('raw HTML in a block is returned as data, untouched', () => {
    const [block] = diffMarkdownBlocks('', '<script>alert(1)</script>\n');
    expect(block).toEqual({ op: 'added', old_html: null, new_html: '<script>alert(1)</script>\n' });
  });

  describe('bounds', () => {
    const paragraphs = (count: number) =>
      Array.from({ length: count }, () => randomBytes(6).toString('hex')).join('\n\n');

    test('two documents with nothing in common are paired, not diffed', () => {
      const count = MARKDOWN_DIFF_MAX_EDITS; // 2 × count edits: over the limit
      const started = performance.now();
      const blocks = diffMarkdownBlocks(paragraphs(count), paragraphs(count));
      expect(performance.now() - started).toBeLessThan(3000);
      expect(blocks).toHaveLength(count);
      expect(blocks.every((o) => o.op === 'changed')).toBe(true);
    });

    test('big documents with nothing in common are quick', () => {
      // ~20,000 blocks each, under the render cap: an unbounded diff would need ~40,000 edits.
      const doc = (prefix: string) =>
        Array.from({ length: 20_000 }, (_, i) => `${prefix}${i}`).join('\n\n');
      const [a, b] = [doc('a'), doc('b')];
      expect(Buffer.byteLength(a)).toBeLessThan(MARKDOWN_RENDER_MAX_BYTES);
      const started = performance.now();
      const blocks = diffMarkdownBlocks(a, b);
      expect(performance.now() - started).toBeLessThan(3000);
      expect(blocks).toHaveLength(20_000);
      expect(blocks.every((o) => o.op === 'changed')).toBe(true);
    });

    test('the fallback still keeps a shared start and end', () => {
      const count = MARKDOWN_DIFF_MAX_EDITS;
      const head = 'Head\n\nIntro';
      const tail = 'Tail\n\nEnd';
      const blocks = diffMarkdownBlocks(
        `${head}\n\n${paragraphs(count)}\n\n${tail}`,
        `${head}\n\n${paragraphs(count + 3)}\n\n${tail}`,
      );
      expect(blocks.slice(0, 2).map((o) => o.op)).toEqual(['unchanged', 'unchanged']);
      expect(blocks.slice(-2).map((o) => o.op)).toEqual(['unchanged', 'unchanged']);
      expect(blocks.filter((o) => o.op === 'added')).toHaveLength(3);
      expect(blocks.filter((o) => o.op === 'changed')).toHaveLength(count);
    });

    test('a document of tiny blocks with one edit is quick', () => {
      const body = 'a\n\n'.repeat(60_000);
      const started = performance.now();
      const blocks = diffMarkdownBlocks(`${body}x\n`, `${body}y\n`);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(blocks.at(-1)?.op).toBe('changed');
      expect(blocks.filter((o) => o.op === 'unchanged')).toHaveLength(60_000);
    });

    test('a source over the render cap is one block holding the notice', () => {
      const big = `# Big\n\n${'a'.repeat(MARKDOWN_RENDER_MAX_BYTES)}`;
      const blocks = diffMarkdownBlocks(big, `${big}b`);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.op).toBe('changed');
      expect(blocks[0]?.old_html).toContain('pw-md-notice');
    });

    test('hostile input at the cap is rendered within a bounded time', () => {
      const cap = MARKDOWN_RENDER_MAX_BYTES;
      const started = performance.now();
      diffMarkdownBlocks('['.repeat(cap), '*a '.repeat(Math.floor(cap / 3)));
      expect(performance.now() - started).toBeLessThan(8000);
    });
  });
});

describe.each(dialects)('version diffs on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let member: { user: UserRow; cookie: string };

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    member = await createSignedInUser(ctx);
  });
  afterEach(() => ctx.close());

  /** Publishes `versions[0]` as a new artifact and each later file set on top of it. */
  async function history(...versions: Record<string, string | Buffer>[]) {
    const [first, ...rest] = versions as [
      Record<string, string | Buffer>,
      ...Record<string, string | Buffer>[],
    ];
    const { artifact, version } = await publishFiles(ctx, member.user, first);
    let current = version;
    for (const files of rest) {
      clock.advance(1000);
      const next = await publishFiles(ctx, member.user, files, {
        kind: 'new_version',
        artifactId: artifact.id,
        expectedVersionId: current.id,
      });
      current = next.version;
    }
    return artifact.id;
  }

  describe('files', () => {
    test('lists changed files by sha256', async () => {
      const id = await history(
        { 'index.html': INDEX, a: '1', b: '2', c: '3' },
        { 'index.html': INDEX, a: '1', b: '22', d: '4' },
      );
      const changes = await diffVersionFiles(ctx.deps, SYSTEM_SCOPE, id, 1, 2);
      expect(changes).toEqual([
        {
          path: 'b',
          status: 'modified',
          old: { sha256: sha('2'), size: 1, content_type: 'application/octet-stream' },
          new: { sha256: sha('22'), size: 2, content_type: 'application/octet-stream' },
        },
        {
          path: 'c',
          status: 'removed',
          old: { sha256: sha('3'), size: 1, content_type: 'application/octet-stream' },
          new: null,
        },
        {
          path: 'd',
          status: 'added',
          old: null,
          new: { sha256: sha('4'), size: 1, content_type: 'application/octet-stream' },
        },
      ]);
      // The other way round, added and removed swap.
      const back = await diffVersionFiles(ctx.deps, SYSTEM_SCOPE, id, 2, 1);
      expect(back.map((c) => [c.path, c.status])).toEqual([
        ['b', 'modified'],
        ['c', 'added'],
        ['d', 'removed'],
      ]);
    });

    test('identical versions have no changes, and a file that only moved hash is modified', async () => {
      const id = await history(
        { 'index.html': INDEX, 'css/a.css': 'a{}' },
        { 'index.html': INDEX, 'css/a.css': 'a{}' },
        { 'index.html': INDEX, 'css/a.css': 'a{color:red}' },
      );
      expect(await diffVersionFiles(ctx.deps, SYSTEM_SCOPE, id, 1, 2)).toEqual([]);
      expect(await diffVersionFiles(ctx.deps, SYSTEM_SCOPE, id, 1, 1)).toEqual([]);
      const [change] = await diffVersionFiles(ctx.deps, SYSTEM_SCOPE, id, 2, 3);
      expect(change).toMatchObject({ path: 'css/a.css', status: 'modified' });
      expect(change?.old?.content_type).toBe('text/css; charset=utf-8');
    });

    test('files are sorted by path, byte by byte', async () => {
      const id = await history(
        { 'index.html': INDEX },
        { 'index.html': INDEX, z: '1', 'b/c': '1', B: '1', a: '1' },
      );
      expect((await diffVersionFiles(ctx.deps, SYSTEM_SCOPE, id, 1, 2)).map((c) => c.path)).toEqual(
        ['B', 'a', 'b/c', 'z'],
      );
    });

    test('a version that is missing is 404, or 410 once deleted', async () => {
      const id = await history({ 'index.html': INDEX }, { 'index.html': `${INDEX}2` });
      for (const [from, to] of [
        [1, 9],
        [9, 1],
        [0, 1],
      ] as const) {
        const error = await failure(diffVersionFiles(ctx.deps, SYSTEM_SCOPE, id, from, to));
        expect([from, to, error.status]).toEqual([from, to, 404]);
      }
      expect(
        (await failure(diffVersionFiles(ctx.deps, SYSTEM_SCOPE, 'art_unknown', 1, 2))).status,
      ).toBe(404);
      await ctx.deps.db.db
        .deleteFrom('versions')
        .where('artifact_id', '=', id)
        .where('number', '=', 1)
        .execute();
      const gone = await failure(diffVersionFiles(ctx.deps, SYSTEM_SCOPE, id, 1, 2));
      expect(gone.status).toBe(410);
      expect(gone.message).toBe(t('version.gone'));
    });
  });

  describe('text', () => {
    test('unified diff of a text file', async () => {
      const id = await history(
        { 'index.html': INDEX, 'b.txt': '1\n2\n3\n', 'same.txt': 'one\ntwo\n' },
        { 'index.html': INDEX, 'b.txt': '1\n22\n3\n', 'd.txt': 'new\n', 'same.txt': 'one\ntwo\n' },
      );
      const diff = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'b.txt');
      expect(diff).toMatchObject({ path: 'b.txt', binary: false, too_large: false });
      expect(diff.patch).toContain('--- b.txt\tv1');
      expect(diff.patch).toContain('+++ b.txt\tv2');
      expect(diff.patch).toContain('\n-2');
      expect(diff.patch).toContain('\n+22');
      expect(diff.patch).toContain('@@ -1,3 +1,3 @@');
      expect(diff.old).toEqual({
        sha256: sha('1\n2\n3\n'),
        size: 6,
        content_type: 'text/plain; charset=utf-8',
      });
      expect(diff.new?.sha256).toBe(sha('1\n22\n3\n'));

      // An added file has an empty old side; a removed one an empty new side.
      const added = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'd.txt');
      expect(added.old).toBeNull();
      expect(added.patch).toContain('--- d.txt\tv1');
      expect(added.patch).toContain('@@ -0,0 +1,1 @@\n+new\n');
      const removed = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 2, 1, 'd.txt');
      expect(removed.new).toBeNull();
      expect(removed.patch).toContain('@@ -1,1 +0,0 @@\n-new\n');

      // An untouched file has a patch without hunks.
      const same = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'same.txt');
      expect(same).toMatchObject({ binary: false, too_large: false });
      expect(same.patch).not.toContain('@@');
    });

    test('context is three lines and non-ASCII text survives', async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `dòng ${i + 1}`);
      const edited = lines.map((l, i) => (i === 14 ? 'đã sửa' : l));
      const id = await history(
        { 'index.html': INDEX, 'v.txt': `${lines.join('\n')}\n` },
        { 'index.html': INDEX, 'v.txt': `${edited.join('\n')}\n` },
      );
      const { patch } = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'v.txt');
      expect(patch).toContain('@@ -12,7 +12,7 @@');
      expect(patch).toContain('-dòng 15\n+đã sửa\n');
      expect(patch).not.toContain('dòng 11');
    });

    test('a path in neither version is 404, an NFD path finds the NFC file', async () => {
      const id = await history(
        { 'index.html': INDEX, 'tệp.txt': 'a\n' },
        { 'index.html': INDEX, 'tệp.txt': 'b\n' },
      );
      const missing = await failure(diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'nope.txt'));
      expect(missing.status).toBe(404);
      expect(missing.message).toBe(t('diff.noFile'));
      const nfd = 'tệp.txt'.normalize('NFD');
      expect(nfd).not.toBe('tệp.txt');
      const diff = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, nfd);
      expect(diff.path).toBe('tệp.txt');
      expect(diff.patch).toContain('+b');
      expect(
        (await failure(diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 9, 'tệp.txt'))).status,
      ).toBe(404);
    });

    test('binary files are not diffed', async () => {
      const png = (extra: number) =>
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
          randomBytes(extra),
        ]);
      const nul = Buffer.concat([
        Buffer.from('looks like text\n'),
        Buffer.from([0]),
        Buffer.from('more\n'),
      ]);
      const id = await history(
        { 'index.html': INDEX, 'a.png': png(100), 'raw.txt': nul },
        {
          'index.html': INDEX,
          'a.png': png(120),
          'raw.txt': Buffer.concat([nul, Buffer.from('x')]),
        },
      );
      const image = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'a.png');
      expect(image).toMatchObject({ path: 'a.png', binary: true, too_large: false, patch: null });
      expect(image.old?.size).toBe(109);
      expect(image.new?.size).toBe(129);
      // A text type with a NUL in its first 8000 bytes is binary too.
      expect(await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'raw.txt')).toMatchObject({
        binary: true,
        patch: null,
      });
    });

    test('a NUL after the first 8000 bytes does not make a file binary', async () => {
      const late = (tail: string) =>
        Buffer.concat([Buffer.from(`${'a'.repeat(7999)}\n`), Buffer.from(tail)]);
      const id = await history(
        { 'index.html': INDEX, 'f.txt': late('one\0\n') },
        { 'index.html': INDEX, 'f.txt': late('two\0\n') },
      );
      expect(await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'f.txt')).toMatchObject({
        binary: false,
        too_large: false,
      });
    });

    test('large files are not diffed', async () => {
      const big = 'x'.repeat(TEXT_DIFF_MAX_BYTES + 1);
      const ok = 'x'.repeat(TEXT_DIFF_MAX_BYTES);
      const id = await history(
        { 'index.html': INDEX, 'big.txt': ok, 'img.png': Buffer.alloc(TEXT_DIFF_MAX_BYTES + 1, 1) },
        {
          'index.html': INDEX,
          'big.txt': big,
          'img.png': Buffer.alloc(TEXT_DIFF_MAX_BYTES + 2, 1),
        },
      );
      expect(big.length).toBe(1_000_001);
      expect(await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'big.txt')).toMatchObject({
        binary: false,
        too_large: true,
        patch: null,
      });
      // A big file that is not text is binary: nothing is read to say so.
      expect(await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'img.png')).toMatchObject({
        binary: true,
        too_large: false,
        patch: null,
      });
      // At the limit, a file is compared.
      expect(
        (await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 1, 'big.txt')).patch,
      ).not.toBeNull();
    });

    test('files with too many lines are not diffed, and quickly', async () => {
      const lines = (n: number, c: string) => `${c}\n`.repeat(n);
      const id = await history(
        { 'index.html': INDEX, 'l.txt': lines(TEXT_DIFF_MAX_LINES, 'a') },
        { 'index.html': INDEX, 'l.txt': lines(TEXT_DIFF_MAX_LINES + 1, 'a') },
      );
      const started = performance.now();
      expect(await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'l.txt')).toMatchObject({
        too_large: true,
        patch: null,
      });
      expect(performance.now() - started).toBeLessThan(2000);
      // A million one-byte lines is under the byte limit and far over the line limit.
      const many = await history(
        { 'index.html': INDEX, 'm.txt': '\n'.repeat(TEXT_DIFF_MAX_BYTES) },
        { 'index.html': INDEX, 'm.txt': '\n'.repeat(TEXT_DIFF_MAX_BYTES - 1) },
      );
      expect(await diffTextFile(ctx.deps, SYSTEM_SCOPE, many, 1, 2, 'm.txt')).toMatchObject({
        too_large: true,
        patch: null,
      });
    });

    test('two files with nothing in common stop at the edit limit', async () => {
      const id = await history(
        { 'index.html': INDEX, 'r.txt': randomLines(TEXT_DIFF_MAX_LINES / 2) },
        { 'index.html': INDEX, 'r.txt': randomLines(TEXT_DIFF_MAX_LINES / 2) },
      );
      const started = performance.now();
      const diff = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'r.txt');
      expect(performance.now() - started).toBeLessThan(3000);
      expect(diff).toMatchObject({ binary: false, too_large: true, patch: null });
    });

    test('a big file with a few edits is diffed', async () => {
      const base = Array.from({ length: 30_000 }, (_, i) => `line ${i}`);
      const edited = base.map((l, i) => (i % 3000 === 0 ? `${l} edited` : l));
      const id = await history(
        { 'index.html': INDEX, 'big.txt': `${base.join('\n')}\n` },
        { 'index.html': INDEX, 'big.txt': `${edited.join('\n')}\n` },
      );
      const started = performance.now();
      const { patch, too_large } = await diffTextFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'big.txt');
      expect(performance.now() - started).toBeLessThan(3000);
      expect(too_large).toBe(false);
      expect(patch?.match(/^@@/gm)).toHaveLength(10);
    });
  });

  describe('markdown', () => {
    test('a rendered diff of the `to` entry by default', async () => {
      const id = await history(
        { 'index.md': '# T\n\nA\n\nB\n', 'other.md': 'x\n' },
        { 'index.md': '# T\n\nA\n\nB2\n\nC\n', 'other.md': 'x\n' },
      );
      const diff = await diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2);
      expect(diff.path).toBe('index.md');
      expect(diff.too_large).toBe(false);
      expect(diff.blocks.map((b) => b.op)).toEqual(['unchanged', 'unchanged', 'changed', 'added']);
      expect(diff.blocks[2]).toEqual({
        op: 'changed',
        old_html: '<p>B</p>\n',
        new_html: '<p>B2</p>\n',
      });

      const other = await diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'other.md');
      expect(other).toEqual({
        path: 'other.md',
        too_large: false,
        blocks: [{ op: 'unchanged', old_html: '<p>x</p>\n', new_html: '<p>x</p>\n' }],
      });
    });

    test('an added or removed file is all added or all removed', async () => {
      const id = await history(
        { 'index.md': '# T\n' },
        { 'index.md': '# T\n', 'new.md': 'A\n\nB\n' },
      );
      expect(
        (await diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'new.md')).blocks.map(
          (b) => b.op,
        ),
      ).toEqual(['added', 'added']);
      expect(
        (await diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 2, 1, 'new.md')).blocks.map(
          (b) => b.op,
        ),
      ).toEqual(['removed', 'removed']);
    });

    test('only Markdown files, and only files that exist', async () => {
      const id = await history(
        { 'index.html': INDEX, 'a.md': 'a\n' },
        { 'index.html': `${INDEX}2`, 'a.md': 'b\n' },
      );
      const notMarkdown = await failure(
        diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'index.html'),
      );
      expect(notMarkdown.status).toBe(400);
      expect(notMarkdown.message).toBe(t('diff.notMarkdown'));
      // The default is the entry of the `to` version, which here is HTML.
      expect((await failure(diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2))).message).toBe(
        t('diff.notMarkdown'),
      );
      const missing = await failure(diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2, 'nope.md'));
      expect(missing.status).toBe(404);
      expect(missing.message).toBe(t('diff.noFile'));
      expect(
        (await failure(diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 1, 9, 'a.md'))).status,
      ).toBe(404);
    });

    test('a side over the render cap is not rendered', async () => {
      const small = '# Small\n';
      const big = `# Big\n\n${'a'.repeat(MARKDOWN_RENDER_MAX_BYTES)}`;
      const id = await history({ 'index.md': small }, { 'index.md': big });
      const started = performance.now();
      const diff = await diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, id, 1, 2);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(diff).toEqual({ path: 'index.md', too_large: true, blocks: [] });
      // At the cap it is.
      const atCap = `# Big\n\n${'a'.repeat(MARKDOWN_RENDER_MAX_BYTES - 7)}`;
      expect(Buffer.byteLength(atCap)).toBe(MARKDOWN_RENDER_MAX_BYTES);
      const ok = await history({ 'index.md': small }, { 'index.md': atCap });
      expect((await diffMarkdownFile(ctx.deps, SYSTEM_SCOPE, ok, 1, 2)).too_large).toBe(false);
    });
  });
});
