import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import {
  fileOf,
  filesAt,
  pageFilePath,
  READ_TEXT_MAX_BYTES,
  readText,
  versionFor,
} from '../../src/domain/version-files.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { AppError } from '../../src/lib/errors.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 18);

/** What the promise rejects with, as an `AppError`. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('pageFilePath', () => {
  const paths = new Set([
    'index.md',
    'a.html',
    'docs/index.html',
    'docs/index.md',
    'guide/index.md',
    'both/index.html',
    'both/index.md',
    'x',
    'x/index.html',
  ]);
  const at = (page: string, entry = 'index.md') => pageFilePath(page, entry, paths);

  test('the empty page is the entry', () => {
    expect(at('')).toBe('index.md');
    expect(at('', 'a.html')).toBe('a.html');
    // An entry the version does not hold is no page.
    expect(at('', 'gone.html')).toBeNull();
  });

  test('a path with a slash is the index of that folder, HTML first', () => {
    expect(at('docs/')).toBe('docs/index.html');
    expect(at('guide/')).toBe('guide/index.md');
    expect(at('both/')).toBe('both/index.html');
    expect(at('nothing/')).toBeNull();
  });

  test('a path without a slash is the file itself, then the index of that folder', () => {
    expect(at('a.html')).toBe('a.html');
    expect(at('docs')).toBe('docs/index.html');
    expect(at('guide')).toBe('guide/index.md');
    // A file named like a folder wins over the folder's index.
    expect(at('x')).toBe('x');
    expect(at('nothing')).toBeNull();
  });

  test('a path with a slash is not the file of that name', () => {
    expect(at('x/')).toBe('x/index.html');
    expect(pageFilePath('a.html/', 'index.md', paths)).toBeNull();
  });
});

describe.each(dialects)('version files on %s', (dialect) => {
  let ctx: TestContext;
  let ada: UserRow;

  beforeEach(async () => {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T) });
    ada = (await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' })).user;
  });
  afterEach(() => ctx.close());

  /** The text of `path` in the current version of a new artifact holding `files`. */
  async function textOf(files: Record<string, string | Buffer>, path?: string): Promise<string> {
    const { version } = await publishFiles(ctx, ada, files);
    return readText(ctx.deps, await fileOf(ctx.deps, version, path));
  }

  /** The file of `files[path]` in a new artifact, for tests of `readText` to refuse. */
  async function fileRow(files: Record<string, string | Buffer>, path: string) {
    const { version } = await publishFiles(ctx, ada, files);
    return fileOf(ctx.deps, version, path);
  }

  test('versionFor is the current version, or the one numbered', async () => {
    const first = await publishFiles(ctx, ada, { 'index.html': '<p>1</p>' });
    const second = await publishFiles(
      ctx,
      ada,
      { 'index.html': '<p>2</p>' },
      {
        kind: 'new_version',
        artifactId: first.artifact.id,
        expectedVersionId: first.version.id,
      },
    );
    const current = await versionFor(ctx.deps, SYSTEM_SCOPE, first.artifact.id);
    expect(current.version.id).toBe(second.version.id);
    expect(current.artifact.id).toBe(first.artifact.id);
    const older = await versionFor(ctx.deps, SYSTEM_SCOPE, first.artifact.id, 1);
    expect(older.version.id).toBe(first.version.id);
  });

  test('versionFor answers not_found for a missing artifact, version or current version', async () => {
    const { artifact } = await publishFiles(ctx, ada, { 'index.html': '<p>1</p>' });
    expect((await failure(versionFor(ctx.deps, SYSTEM_SCOPE, 'art_unknown'))).code).toBe(
      'not_found',
    );
    expect((await failure(versionFor(ctx.deps, SYSTEM_SCOPE, artifact.id, 9))).code).toBe(
      'not_found',
    );
    await ctx.deps.db.db
      .updateTable('artifacts')
      .set({ current_version_id: null })
      .where('id', '=', artifact.id)
      .execute();
    expect((await failure(versionFor(ctx.deps, SYSTEM_SCOPE, artifact.id))).code).toBe('not_found');
  });

  test('fileOf is the entry by default and any other path by its exact name', async () => {
    const { version } = await publishFiles(ctx, ada, {
      'index.html': '<p>x</p>',
      'docs/a.md': '# A',
    });
    expect((await fileOf(ctx.deps, version)).path).toBe('index.html');
    expect((await fileOf(ctx.deps, version, 'docs/a.md')).path).toBe('docs/a.md');
    for (const missing of ['docs', 'docs/', 'DOCS/A.MD', '/docs/a.md', 'a.md']) {
      expect((await failure(fileOf(ctx.deps, version, missing))).code, missing).toBe('not_found');
    }
  });

  test('fileOf finds a Vietnamese name written in either Unicode form', async () => {
    const stored = 'tài liệu/bảng giá.md'.normalize('NFC');
    const { version } = await publishFiles(ctx, ada, { 'index.html': '<p>x</p>', [stored]: '#' });
    for (const form of ['NFC', 'NFD'] as const) {
      expect((await fileOf(ctx.deps, version, stored.normalize(form))).path).toBe(stored);
    }
  });

  test('filesAt finds the files at exact paths, in one map, and leaves out the missing', async () => {
    const { version } = await publishFiles(ctx, ada, {
      'index.html': '<p>x</p>',
      'docs/a.md': '# A',
      'b.css': 'b{}',
    });
    const files = await filesAt(ctx.deps, version, ['docs/a.md', 'index.html', 'nope.css']);
    expect([...files.keys()].sort()).toEqual(['docs/a.md', 'index.html']);
    expect(files.get('docs/a.md')).toMatchObject({ version_id: version.id, size: 3 });
    expect(await filesAt(ctx.deps, version, [])).toEqual(new Map());
  });

  test('readText keeps a leading BOM and the line breaks as stored', async () => {
    const text = await textOf({ 'index.html': Buffer.from('﻿<p>a</p>\r\n<p>b</p>\r\n') });
    expect(text).toBe('﻿<p>a</p>\r\n<p>b</p>\r\n');
  });

  test('readText decodes UTF-8 text, Vietnamese included', async () => {
    expect(await textOf({ 'index.html': '<h1>Bảng giá</h1>' })).toBe('<h1>Bảng giá</h1>');
  });

  test('readText reads an empty file', async () => {
    expect(await textOf({ 'index.html': '<p>x</p>', 'empty.txt': '' }, 'empty.txt')).toBe('');
  });

  test('readText refuses a type that is not text, with its size and type', async () => {
    const file = await fileRow(
      { 'index.html': '<p>x</p>', 'a.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      'a.png',
    );
    const refused = await failure(readText(ctx.deps, file));
    expect(refused.code).toBe('bad_request');
    expect(refused.details).toEqual({ reason: 'not_text', size: 4, content_type: 'image/png' });
  });

  test('readText refuses text with a NUL in its first 8,000 bytes, but not after them', async () => {
    const early = await fileRow({ 'index.html': Buffer.from('<p>a\u0000b</p>') }, 'index.html');
    expect((await failure(readText(ctx.deps, early))).details).toMatchObject({
      reason: 'not_text',
    });

    const late = `${'x'.repeat(8000)}\u0000y`;
    expect(await textOf({ 'index.html': late })).toBe(late);
  });

  test('readText refuses bytes that are not valid UTF-8', async () => {
    const file = await fileRow(
      { 'index.html': Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x70, 0x3e]) },
      'index.html',
    );
    const refused = await failure(readText(ctx.deps, file));
    expect(refused.code).toBe('bad_request');
    expect(refused.details).toMatchObject({ reason: 'not_text', size: 9 });
  });

  test('readText refuses a file over 5,000,000 bytes without reading it', async () => {
    expect(READ_TEXT_MAX_BYTES).toBe(5_000_000);
    const file = await fileRow({ 'index.html': '<p>x</p>' }, 'index.html');
    const refused = await failure(
      readText(ctx.deps, { ...file, size: READ_TEXT_MAX_BYTES + 1, sha256: 'f'.repeat(64) }),
    );
    expect(refused.code).toBe('bad_request');
    expect(refused.details).toMatchObject({ reason: 'too_large', size: READ_TEXT_MAX_BYTES + 1 });
    // A file of exactly that size is read.
    expect(await readText(ctx.deps, { ...file, size: READ_TEXT_MAX_BYTES })).toBe('<p>x</p>');
  });

  test('a blob the version lists but storage lost is a server error, not a 404', async () => {
    const file = await fileRow({ 'index.html': '<p>x</p>' }, 'index.html');
    const error = await readText(ctx.deps, { ...file, sha256: 'e'.repeat(64) }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
  });
});
