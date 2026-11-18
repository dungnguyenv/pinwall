import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { blobRegistry } from '../../src/domain/blobs.ts';
import { deleteVersion } from '../../src/domain/deletion.ts';
import type { PublishTarget } from '../../src/domain/versions.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { applyEdits, type EditOp, parseEdits } from '../../src/publish/edits.ts';
import { ingestEdit, type PublishOptions } from '../../src/publish/ingest.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { blobState, sha } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 18);
const KEPT = { row: true, object: true };
const GONE = { row: false, object: false };

/** `applyEdits` on one file whose text is `text`, entry `index.html`. */
function edit(text: string | null, ops: EditOp[], path = 'i.html') {
  return applyEdits(ops, (p) => (p === path ? text : null), 'index.html');
}

/** What `applyEdits` throws for `ops`, as the AppError's details. */
function failure(text: string | null, ops: EditOp[]): Record<string, unknown> {
  try {
    edit(text, ops);
  } catch (error) {
    return (error as { details: Record<string, unknown> }).details;
  }
  throw new Error('applyEdits did not fail');
}

const replace = (old_string: string, new_string: string, more: Partial<EditOp> = {}): EditOp =>
  ({ op: 'replace', path: 'i.html', old_string, new_string, ...more }) as EditOp;

describe('applyEdits', () => {
  test('replace keeps CRLF and the BOM', () => {
    const src = '﻿<p>a</p>\r\n<p>b</p>\r\n';
    const { texts } = applyEdits(
      [{ op: 'replace', path: 'i.html', old_string: '<p>b</p>', new_string: '<p>c</p>' }],
      () => src,
      'i.html',
    );
    expect(texts.get('i.html')).toBe('﻿<p>a</p>\r\n<p>c</p>\r\n');
  });

  test('an indentation mistake names the whitespace match line', () => {
    const read = () => 'x\n    <td>Agent</td>\n';
    expect(() =>
      applyEdits(
        [{ op: 'replace', path: 'i.html', old_string: '<td>Agent</td>  ', new_string: '' }],
        read,
        'i.html',
      ),
    ).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ problem: 'not_found', whitespace_lines: [2] }),
      }),
    );
  });

  test('NFC old_string against NFD text names the unicode match line', () => {
    const text = '<h1>Bảng giá</h1>\n<p>x</p>\n'.normalize('NFD');
    expect(failure(text, [replace('Bảng giá'.normalize('NFC'), 'Giá')])).toEqual({
      reason: 'edit_failed',
      index: 0,
      path: 'i.html',
      problem: 'not_found',
      whitespace_lines: [],
      unicode_lines: [1],
    });
  });

  test('two matches without replace_all are ambiguous with their lines', () => {
    const text = '<b>x</b>\n<i>y</i>\n<b>x</b>\n';
    expect(failure(text, [replace('<b>x</b>', '<b>z</b>')])).toEqual({
      reason: 'edit_failed',
      index: 0,
      path: 'i.html',
      problem: 'ambiguous',
      count: 2,
      lines: [1, 3],
    });
  });

  test('deleting the entry is refused', () => {
    const ops: EditOp[] = [{ op: 'delete', path: 'index.html' }];
    expect(() => applyEdits(ops, () => '<p>x</p>', 'index.html')).toThrow(
      expect.objectContaining({
        status: 400,
        details: expect.objectContaining({ problem: 'entry_delete', index: 0, path: 'index.html' }),
      }),
    );
  });

  test('later operations see earlier ones', () => {
    const { texts, summary } = applyEdits(
      [
        { op: 'write', path: 'new.css', content: 'a { color: red; }\n' },
        { op: 'replace', path: 'new.css', old_string: 'red', new_string: 'blue' },
      ],
      () => null,
      'index.html',
    );
    expect(texts.get('new.css')).toBe('a { color: blue; }\n');
    expect(summary).toEqual([{ path: 'new.css', result: 'written', count: 1, lines: null }]);
  });

  test('replace_all replaces every match and spans their lines', () => {
    const text = 'a\nx\nb\nx\nc\n';
    const { texts, summary } = edit(text, [replace('x', 'y', { replace_all: true })]);
    expect(texts.get('i.html')).toBe('a\ny\nb\ny\nc\n');
    expect(summary).toEqual([{ path: 'i.html', result: 'replaced', count: 2, lines: [2, 4] }]);
  });

  test('the lines are those of the text after the replacement', () => {
    const { texts, summary } = edit('a\nb\nc\n', [replace('b', 'x\ny\nz')]);
    expect(texts.get('i.html')).toBe('a\nx\ny\nz\nc\n');
    expect(summary).toEqual([{ path: 'i.html', result: 'replaced', count: 1, lines: [2, 4] }]);

    // A replacement that ends with a line break ends on the line that break closes.
    expect(edit('a\nb\n', [replace('b\n', 'b\nc\n')]).summary[0]?.lines).toEqual([2, 3]);
    // Removing the last line leaves the span on the last line there is.
    expect(edit('a\nb\n', [replace('b\n', '')]).summary[0]?.lines).toEqual([1, 1]);
    // CRLF counts as one break, a lone CR as one too.
    expect(edit('a\r\nb\rc', [replace('c', 'C')]).summary[0]?.lines).toEqual([3, 3]);
  });

  test('several replaces in one file make one line that spans all of them', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `row ${i + 1}`);
    const { summary } = edit(lines.join('\n'), [
      replace('row 3', 'row three'),
      // Two lines become one above the first change: it moves up a line.
      replace('row 1\nrow 2', 'rows 1 and 2'),
      replace('row 8', 'row 8\nrow 8b'),
    ]);
    expect(summary).toEqual([{ path: 'i.html', result: 'replaced', count: 3, lines: [1, 8] }]);
  });

  test('new_string is inserted as written, $ patterns included', () => {
    const { texts } = edit('<p>price</p>', [replace('price', "$& $1 $$ $' $`")]);
    expect(texts.get('i.html')).toBe("<p>$& $1 $$ $' $`</p>");
  });

  test('write creates or overwrites, delete removes, in the order first touched', () => {
    const files: Record<string, string> = { 'index.html': '<p>x</p>', 'old.css': 'p{}' };
    const { texts, summary } = applyEdits(
      [
        { op: 'delete', path: 'old.css' },
        { op: 'write', path: 'docs/a.md', content: '# A\n' },
        { op: 'write', path: 'index.html', content: '<p>y</p>' },
      ],
      (p) => files[p] ?? null,
      'index.html',
    );
    expect([...texts]).toEqual([
      ['old.css', null],
      ['docs/a.md', '# A\n'],
      ['index.html', '<p>y</p>'],
    ]);
    expect(summary).toEqual([
      { path: 'old.css', result: 'deleted', count: 0, lines: null },
      { path: 'docs/a.md', result: 'written', count: 0, lines: null },
      { path: 'index.html', result: 'written', count: 0, lines: null },
    ]);
  });

  test('a replace or delete on a missing file names the operation', () => {
    const ops: EditOp[] = [
      { op: 'write', path: 'a.css', content: 'x' },
      { op: 'delete', path: 'b.css' },
    ];
    expect(failure(null, ops)).toEqual({
      reason: 'edit_failed',
      index: 1,
      path: 'b.css',
      problem: 'no_file',
    });
    expect(failure(null, [replace('a', 'b')])).toMatchObject({ index: 0, problem: 'no_file' });
    // A file deleted by an earlier operation is missing for the later ones.
    expect(
      failure('<p>a</p>', [{ op: 'delete', path: 'i.html' }, replace('a', 'b')]),
    ).toMatchObject({ index: 1, problem: 'no_file' });
  });

  test('a text with no near match has empty lists', () => {
    expect(failure('<p>a</p>', [replace('zzz', 'y')])).toMatchObject({
      problem: 'not_found',
      whitespace_lines: [],
      unicode_lines: [],
    });
  });

  test('the near-match lists and the ambiguous lines stop at 10', () => {
    const text = Array.from({ length: 30 }, () => '  <td>a</td>').join('\n');
    expect(failure(text, [replace('<td>a</td>', 'b')])).toMatchObject({
      problem: 'ambiguous',
      count: 30,
      lines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    expect(failure(text, [replace('<td>a</td>   \n <td>a', 'b')])).toMatchObject({
      problem: 'not_found',
      whitespace_lines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
  });

  test('the message names the operation, the path and the lines', () => {
    expect(() => edit('x\n    <td>A</td>\n', [replace('<td>A</td>  ', '')])).toThrow(
      /^edits\[0\] \(replace i\.html\) failed: old_string is not in the file\. It would match on lines 2 /,
    );
  });

  test('a result over the per-file limit is refused before it is built', () => {
    const ops = [replace('a', 'b'.repeat(10), { replace_all: true })];
    expect(() =>
      applyEdits(ops, () => 'a'.repeat(100), 'index.html', {
        maxFileBytes: 999,
        maxVersionBytes: 10_000,
      }),
    ).toThrow(
      expect.objectContaining({
        status: 413,
        details: { limit: 'max_file_bytes', max: 999, path: 'i.html' },
      }),
    );
    expect(() =>
      applyEdits(
        [
          { op: 'write', path: 'a.css', content: 'x'.repeat(600) },
          { op: 'write', path: 'b.css', content: 'x'.repeat(600) },
        ],
        () => null,
        'index.html',
        { maxFileBytes: 1000, maxVersionBytes: 1000 },
      ),
    ).toThrow(
      expect.objectContaining({
        status: 413,
        details: { limit: 'max_version_bytes', max: 1000 },
      }),
    );
  });
});

describe('parseEdits', () => {
  test('each operation needs its fields', () => {
    expect(() =>
      parseEdits(
        [
          { op: 'delete', path: 'a.css' },
          { op: 'replace', path: 'index.html', new_string: 'x' },
        ],
        1000,
      ),
    ).toThrow(
      expect.objectContaining({
        details: {
          reason: 'edit_failed',
          index: 1,
          path: 'index.html',
          problem: 'missing_fields',
          fields: ['old_string'],
        },
      }),
    );
    expect(() => parseEdits([{ op: 'replace', path: 'a', old_string: '' }], 1000)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ fields: ['old_string', 'new_string'] }),
      }),
    );
    expect(() => parseEdits([{ op: 'write', path: 'a.css' }], 1000)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ fields: ['content'] }) }),
    );
  });

  test('the strings of all operations count toward max_inline_bytes', () => {
    // 'a.css' is 5 bytes, each 'ệ' 3.
    const ops = (n: number) => [{ op: 'write' as const, path: 'a.css', content: 'ệ'.repeat(n) }];
    expect(parseEdits(ops(5), 20)).toHaveLength(1);
    expect(() => parseEdits(ops(6), 20)).toThrow(
      expect.objectContaining({
        status: 413,
        code: 'payload_too_large',
        details: { limit: 'max_inline_bytes', max: 20 },
      }),
    );
  });

  test('paths are normalized as a publish normalizes them, and must name a text file to write', () => {
    expect(
      parseEdits(
        [
          {
            op: 'replace',
            path: './tài liệu.md'.normalize('NFD'),
            old_string: 'a',
            new_string: 'b',
          },
        ],
        1000,
      ),
    ).toEqual([{ op: 'replace', path: 'tài liệu.md', old_string: 'a', new_string: 'b' }]);
    expect(() => parseEdits([{ op: 'delete', path: '../x.html' }], 1000)).toThrow(
      expect.objectContaining({ details: { reason: 'dot_segment', path: '../x.html', index: 0 } }),
    );
    expect(() => parseEdits([{ op: 'write', path: 'docs/.DS_Store', content: '' }], 1000)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ problem: 'bad_path' }) }),
    );
    expect(() => parseEdits([{ op: 'write', path: 'logo.png', content: 'x' }], 1000)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ problem: 'not_text' }) }),
    );
  });
});

describe.each(dialects)('ingestEdit on %s', (dialect) => {
  let ctx: TestContext;
  let actor: UserRow;
  let opts: PublishOptions;

  beforeEach(async () => {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T) });
    actor = (await createSignedInUser(ctx)).user;
    opts = { actor, source: 'mcp', message: null };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    return ctx.close();
  });

  const versions = () =>
    ctx.deps.db.db.selectFrom('versions').select(['id', 'number']).orderBy('number').execute();

  async function filesOf(versionId: string): Promise<Map<string, string>> {
    const rows = await ctx.deps.db.db
      .selectFrom('version_files')
      .select(['path', 'sha256'])
      .where('version_id', '=', versionId)
      .execute();
    return new Map(rows.map((row) => [row.path, row.sha256]));
  }

  /** v1 with a page and a binary file, then v2 of the page alone changed. */
  async function twoVersions() {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const v1 = await publishFiles(ctx, actor, { 'index.html': '<p>one</p>', 'img/a.png': png });
    const page2 = '<title>Two</title><p>two</p>';
    const target: PublishTarget = {
      kind: 'new_version',
      artifactId: v1.artifact.id,
      expectedVersionId: v1.version.id,
    };
    const v2 = await publishFiles(
      ctx,
      actor,
      { 'index.html': page2, 'img/a.png': png, 'b.css': 'b{}' },
      target,
    );
    return { v1, v2, page2, png };
  }

  test('changed files are stored, the others carried by hash without being read or stored', async () => {
    const { v2, png } = await twoVersions();
    const put = vi.spyOn(ctx.deps.blobs, 'put');
    const get = vi.spyOn(ctx.deps.blobs, 'get');

    const { version } = await ingestEdit(
      ctx.deps,
      {
        artifactId: v2.artifact.id,
        expectedVersionId: v2.version.id,
        changed: new Map([
          ['b.css', null],
          ['docs/new.md', Buffer.from('# New\n')],
        ]),
      },
      { ...opts, serverEdits: ['b.css', 'docs/new.md'] },
    );

    expect(version).toMatchObject({ number: 3, parent_version_id: v2.version.id, source: 'mcp' });
    expect(version.title).toBe('Two');
    expect(JSON.parse(version.meta)).toEqual({
      warnings: [],
      server_edits: ['b.css', 'docs/new.md'],
    });
    const files = await filesOf(version.id);
    expect([...files.keys()].sort()).toEqual(['docs/new.md', 'img/a.png', 'index.html']);
    expect(files.get('img/a.png')).toBe((await filesOf(v2.version.id)).get('img/a.png'));
    expect(version.total_bytes).toBe(png.length + '<title>Two</title><p>two</p>'.length + 6);
    // Only the new file is stored; the image is never read, the page only for its metadata.
    expect(put.mock.calls.map((call) => call[0])).toEqual([sha('# New\n')]);
    expect(get.mock.calls.map((call) => call[0])).not.toContain(files.get('img/a.png'));
  });

  test('a version without server edits keeps the meta it had', async () => {
    const { v2 } = await twoVersions();
    const { version } = await ingestEdit(
      ctx.deps,
      { artifactId: v2.artifact.id, expectedVersionId: v2.version.id, changed: new Map() },
      { ...opts, serverEdits: [] },
    );
    expect(JSON.parse(version.meta)).toEqual({ warnings: [] });
  });

  test('a stale base is version_conflict, and nothing is stored', async () => {
    const { v1, v2 } = await twoVersions();
    await expect(
      ingestEdit(
        ctx.deps,
        {
          artifactId: v1.artifact.id,
          expectedVersionId: v1.version.id,
          changed: new Map([['index.html', Buffer.from('<p>three</p>')]]),
        },
        { ...opts, serverEdits: ['index.html'] },
      ),
    ).rejects.toMatchObject({
      code: 'version_conflict',
      details: { current_version_id: v2.version.id, current_version_number: 2 },
    });
    expect(await versions()).toHaveLength(2);
    expect(await blobState(ctx.deps, sha('<p>three</p>'))).toEqual(GONE);
  });

  test('a failure while staging removes what was staged and keeps the carried blobs', async () => {
    await ctx.close();
    ctx = await createTestContext({
      dialect,
      clock: new FixedClock(T),
      env: { PINWALL_MAX_FILE_BYTES: '100' },
    });
    actor = (await createSignedInUser(ctx)).user;
    opts = { actor, source: 'mcp', message: null };
    const { v2, page2 } = await twoVersions();
    await expect(
      ingestEdit(
        ctx.deps,
        {
          artifactId: v2.artifact.id,
          expectedVersionId: v2.version.id,
          changed: new Map([
            ['a.css', Buffer.from('a{}')],
            ['big.css', Buffer.from('x'.repeat(101))],
          ]),
        },
        { ...opts, serverEdits: ['a.css', 'big.css'] },
      ),
    ).rejects.toMatchObject({ status: 413, details: { limit: 'max_file_bytes', path: 'big.css' } });
    expect(await versions()).toHaveLength(2);
    expect(await blobState(ctx.deps, sha('a{}'))).toEqual(GONE);
    expect(await blobState(ctx.deps, sha(page2))).toEqual(KEPT);
    expect(await blobState(ctx.deps, sha('b{}'))).toEqual(KEPT);
  });

  test('the base deleted before the commit: its carried blobs stay pinned until the version_conflict', async () => {
    const { v1, v2, page2 } = await twoVersions();
    const get = ctx.deps.blobs.get.bind(ctx.deps.blobs);
    let deleted = false;
    // Metadata extraction reads the head of the carried page: delete v2 first. v2 alone uses
    // that page, so its deletion collects the blob unless the edit pins it.
    vi.spyOn(ctx.deps.blobs, 'get').mockImplementation(async (sha256, range) => {
      if (!deleted && sha256 === sha(page2)) {
        deleted = true;
        await deleteVersion(ctx.deps, { user: actor, via: 'session' }, v2.artifact.id, 2);
        expect(await blobState(ctx.deps, sha(page2))).toEqual(KEPT);
      }
      return get(sha256, range);
    });

    await expect(
      ingestEdit(
        ctx.deps,
        {
          artifactId: v2.artifact.id,
          expectedVersionId: v2.version.id,
          changed: new Map([['b.css', Buffer.from('c{}')]]),
        },
        { ...opts, serverEdits: ['b.css'] },
      ),
    ).rejects.toMatchObject({
      code: 'version_conflict',
      details: { current_version_id: v1.version.id },
    });
    expect(deleted).toBe(true);
    expect(await versions()).toEqual([{ id: v1.version.id, number: 1 }]);
    // The abort drops the pins and collects what no version uses any more.
    expect(await blobState(ctx.deps, sha(page2))).toEqual(GONE);
    expect(await blobState(ctx.deps, sha('c{}'))).toEqual(GONE);
    expect(await blobState(ctx.deps, sha('<p>one</p>'))).toEqual(KEPT);
  });

  test('the base deleted while its rows are read: refused before a missing blob is read', async () => {
    const { v1, v2, page2 } = await twoVersions();
    const registry = blobRegistry(ctx.deps);
    const withLock = registry.withLock.bind(registry);
    let deleted = false;
    // The first carry takes the page's lock to pin it: delete v2 just before, so the deletion
    // collects the page before the pin can keep it.
    vi.spyOn(registry, 'withLock').mockImplementation(async (sha256, fn) => {
      if (!deleted && sha256 === sha(page2)) {
        deleted = true;
        await deleteVersion(ctx.deps, { user: actor, via: 'session' }, v2.artifact.id, 2);
        expect(await blobState(ctx.deps, sha(page2))).toEqual(GONE);
      }
      return withLock(sha256, fn);
    });
    const get = vi.spyOn(ctx.deps.blobs, 'get');

    await expect(
      ingestEdit(
        ctx.deps,
        {
          artifactId: v2.artifact.id,
          expectedVersionId: v2.version.id,
          changed: new Map([['b.css', Buffer.from('c{}')]]),
        },
        { ...opts, serverEdits: ['b.css'] },
      ),
    ).rejects.toMatchObject({
      code: 'version_conflict',
      details: { current_version_id: v1.version.id },
    });
    expect(deleted).toBe(true);
    expect(get.mock.calls.map((call) => call[0])).not.toContain(sha(page2));
    expect(await blobState(ctx.deps, sha('c{}'))).toEqual(GONE);
  });
});
