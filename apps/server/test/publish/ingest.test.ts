import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MARKDOWN_MAX_BYTES, SCAN_MAX_BYTES } from '../../src/content/metadata.ts';
import { searchQuery } from '../../src/db/dialect.ts';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { SYSTEM_SCOPE } from '../../src/domain/spaces.ts';
import type { PublishTarget } from '../../src/domain/versions.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import {
  ingestFiles,
  ingestInline,
  ingestUpload,
  type PublishOptions,
  type PublishOutcome,
  publishLinks,
} from '../../src/publish/ingest.ts';
import { makeTar, makeZip, type TarSpec } from '../helpers/archives.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { blobState, sha } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 11);

const newTarget = (): PublishTarget => ({
  kind: 'new_artifact',
  projectId: null,
  name: null,
  tags: [],
});

/** The limits the rejection cases run under. */
const SMALL_LIMITS = {
  PINWALL_MAX_FILE_BYTES: '1000',
  PINWALL_MAX_FILES: '3',
  PINWALL_MAX_VERSION_BYTES: '2500',
  PINWALL_MAX_UPLOAD_BYTES: '20000',
};

/**
 * `buf` as a network body would arrive: in 1 KB chunks, with no declared length. Chunks after
 * the first 2 KB wait for `gate`.
 */
function streamed(buf: Buffer, gate: Promise<void> = Promise.resolve()): Readable {
  async function* chunks() {
    for (let start = 0; start < buf.length; start += 1024) {
      if (start >= 2048) await gate;
      yield buf.subarray(start, start + 1024);
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}

/** A body that counts the bytes anyone pulls from it. */
function countingBody(buf: Buffer): { body: Readable; pulled: () => number } {
  let pulled = 0;
  const body = new Readable({
    read() {
      pulled += buf.length;
      this.push(buf);
      this.push(null);
    },
  });
  return { body, pulled: () => pulled };
}

/** A tar that starts with a good `a.css`, so a blob is stored before the rest arrives. */
const withCss = (entries: TarSpec[], o: { css?: string | Buffer; gzip?: boolean } = {}) =>
  makeTar([{ name: 'a.css', body: o.css ?? 'p{}' }, ...entries], { gzip: o.gzip });

const bytes = (n: number) => Buffer.alloc(n, 'x');

const REJECTIONS: [string, () => Promise<Buffer>, object][] = [
  [
    'dot segment',
    () => withCss([{ name: '../evil', body: 'e' }]),
    { status: 400, details: { reason: 'dot_segment' } },
  ],
  [
    'absolute path',
    () => withCss([{ name: '/abs', body: 'e' }]),
    { status: 400, details: { reason: 'absolute' } },
  ],
  [
    'symlink',
    () => withCss([{ name: 'link.css', type: 'symlink', linkname: 'a.css' }]),
    { status: 400, details: { reason: 'link' } },
  ],
  [
    'hardlink',
    () => withCss([{ name: 'hard.css', type: 'link', linkname: 'a.css' }]),
    { status: 400, details: { reason: 'link' } },
  ],
  [
    'character device',
    () => withCss([{ name: 'tty', type: 'character-device' }]),
    { status: 400, details: { reason: 'special' } },
  ],
  [
    'duplicate',
    () =>
      withCss([
        { name: 'é.html'.normalize('NFC'), body: '1' },
        { name: 'é.html'.normalize('NFD'), body: '2' },
      ]),
    { status: 400, details: { reason: 'duplicate', path: 'é.html'.normalize('NFC') } },
  ],
  [
    'reserved',
    () => withCss([{ name: '__pinwall/x.js', body: 'x' }]),
    { status: 400, details: { reason: 'reserved' } },
  ],
  [
    'max_file_bytes',
    () => withCss([{ name: 'big.bin', body: bytes(1001) }]),
    { status: 413, details: { limit: 'max_file_bytes', max: 1000, path: 'big.bin' } },
  ],
  [
    'max_files',
    () =>
      withCss([
        { name: 'b.css', body: 'b' },
        { name: 'c.css', body: 'c' },
        { name: 'd.css', body: 'd' },
      ]),
    { status: 413, details: { limit: 'max_files', max: 3 } },
  ],
  [
    'max_version_bytes',
    () =>
      withCss(
        [
          { name: 'b.css', body: bytes(900) },
          { name: 'c.css', body: bytes(900) },
        ],
        { css: bytes(900) },
      ),
    { status: 413, details: { limit: 'max_version_bytes', max: 2500 } },
  ],
  [
    'max_upload_bytes',
    // 8 × (512-byte header + 3,072 bytes of data) = 28 KB of tar, all of it skipped junk, in
    // fewer members than the 4 × max_files any archive may hold.
    () => withCss(Array.from({ length: 8 }, (_, i) => ({ name: `._pad${i}`, body: bytes(3000) }))),
    { status: 413, details: { limit: 'max_upload_bytes', max: 20000 } },
  ],
  [
    'max_expansion_ratio',
    // About 10 KB gzipped; skipped entries still pass through gunzip.
    () => withCss([{ name: '._bomb', body: Buffer.alloc(10_000_000) }], { gzip: true }),
    { status: 413, details: { limit: 'max_expansion_ratio', max: 100 } },
  ],
  [
    'no entry',
    () =>
      withCss([
        { name: 'a.html', body: 'a' },
        { name: 'b.html', body: 'b' },
      ]),
    { status: 400, details: { reason: 'no_entry' } },
  ],
  [
    'truncated tar.gz',
    async () => {
      // Random bytes do not compress, so the cut lands inside b.bin, after a.css is complete.
      const tgz = await withCss([{ name: 'b.bin', body: randomBytes(900) }], { gzip: true });
      return tgz.subarray(0, tgz.length - 300);
    },
    { status: 400, details: { reason: 'corrupt_archive' } },
  ],
];

describe.each(dialects)('ingest on %s', (dialect) => {
  let ctx: TestContext;
  let actor: UserRow;
  let opts: PublishOptions;

  async function open(env: Record<string, string> = {}): Promise<void> {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T), env });
    actor = (await createSignedInUser(ctx)).user;
    opts = { actor, source: 'api', message: null };
  }
  afterEach(() => ctx.close());

  function upload(
    buf: Buffer,
    o: { type?: string; filename?: string; target?: PublishTarget; gate?: Promise<void> } = {},
  ): Promise<PublishOutcome> {
    return ingestUpload(
      ctx.deps,
      o.target ?? newTarget(),
      {
        body: streamed(buf, o.gate),
        contentType: o.type ?? null,
        contentLength: null,
        filename: o.filename ?? null,
      },
      opts,
    );
  }

  async function paths(version: VersionRow): Promise<string[]> {
    const rows = await ctx.deps.db.db
      .selectFrom('version_files')
      .select('path')
      .where('version_id', '=', version.id)
      .execute();
    return rows.map((row) => row.path).sort();
  }

  async function contentOf(version: VersionRow, path: string): Promise<string> {
    const row = await ctx.deps.db.db
      .selectFrom('version_files')
      .select('sha256')
      .where('version_id', '=', version.id)
      .where('path', '=', path)
      .executeTakeFirstOrThrow();
    const parts: Buffer[] = [];
    for await (const part of await ctx.deps.blobs.get(row.sha256)) parts.push(part as Buffer);
    return Buffer.concat(parts).toString('utf8');
  }

  async function storedBlobs(): Promise<string[]> {
    const keys: string[] = [];
    for await (const key of ctx.deps.blobs.list()) keys.push(key);
    return keys;
  }

  async function expectNothingStored(): Promise<void> {
    for (const table of ['artifacts', 'versions', 'version_files', 'blobs'] as const) {
      expect(await ctx.deps.db.db.selectFrom(table).selectAll().execute()).toEqual([]);
    }
    expect(await storedBlobs()).toEqual([]);
  }

  describe('with the default limits', () => {
    beforeEach(() => open());

    test('publishes a tar.gz made with tar -C dir .', async () => {
      const index = '<title>Home</title><p>Xin chào</p>';
      const tgz = await makeTar(
        [
          { name: './', type: 'directory' },
          { name: './index.html', body: index },
          { name: './css/', type: 'directory' },
          { name: './css/a.css', body: 'p{color:red}' },
        ],
        { gzip: true },
      );
      const { artifact, version, warnings } = await upload(tgz);

      expect(await paths(version)).toEqual(['css/a.css', 'index.html']);
      expect(version).toMatchObject({
        entry_path: 'index.html',
        title: 'Home',
        file_count: 2,
        total_bytes: Buffer.byteLength(index) + 'p{color:red}'.length,
        source: 'api',
        created_by: actor.id,
      });
      expect(artifact).toMatchObject({ kind: 'html', name: 'Home', latest_number: 1 });
      expect(warnings).toEqual([]);
      expect(await contentOf(version, 'css/a.css')).toBe('p{color:red}');
    });

    test('publishes a zip', async () => {
      const zip = makeZip([
        { name: 'index.md', body: '# Notes\n\nhello' },
        { name: 'img/a.png', body: 'png', level: 0 },
        { name: '__MACOSX/._index.md', body: 'junk' },
      ]);
      const { artifact, version } = await upload(zip);
      expect(await paths(version)).toEqual(['img/a.png', 'index.md']);
      expect(version).toMatchObject({ entry_path: 'index.md', title: 'Notes', file_count: 2 });
      expect(artifact.kind).toBe('markdown');
    });

    test('macOS junk is skipped and a wrapping folder stripped', async () => {
      const tgz = await makeTar(
        [
          { name: 'site/', type: 'directory' },
          { name: 'site/index.html', body: '<title>Hi</title>' },
          { name: 'site/._index.html', body: 'x' },
          { name: '__MACOSX/site/._index.html', body: 'x' },
          { name: 'site/.DS_Store', body: 'x' },
          { name: 'site/img/a.png', body: 'png' },
        ],
        { gzip: true },
      );
      const { version } = await upload(tgz);
      expect(await paths(version)).toEqual(['img/a.png', 'index.html']);
      expect(version).toMatchObject({ entry_path: 'index.html', title: 'Hi' });
    });

    test('NFD names are stored in NFC', async () => {
      const nfc = 'Tài liệu.html'.normalize('NFC');
      const nfd = nfc.normalize('NFD');
      expect(nfd).not.toBe(nfc);
      const { version } = await upload(await makeTar([{ name: nfd, body: '<p>x</p>' }]));
      expect(await paths(version)).toEqual([nfc]);
      expect(version.entry_path).toBe(nfc);
    });

    test('single files by content type or filename', async () => {
      const html = await upload(Buffer.from('<h1>Hi</h1>'), { type: 'text/html; charset=utf-8' });
      expect(await paths(html.version)).toEqual(['index.html']);
      expect(html.artifact.kind).toBe('html');
      expect(await contentOf(html.version, 'index.html')).toBe('<h1>Hi</h1>');

      for (const type of ['text/markdown', 'TEXT/X-Markdown; charset=utf-8']) {
        const md = await upload(Buffer.from('# Plan'), { type });
        expect(await paths(md.version)).toEqual(['index.md']);
        expect(md.artifact.kind).toBe('markdown');
      }

      const pdf = await upload(Buffer.from('%PDF-1.7'), {
        type: 'application/pdf',
        filename: 'docs/report.pdf',
      });
      expect(await paths(pdf.version)).toEqual(['docs/report.pdf']);
      expect(pdf.version.entry_path).toBe('docs/report.pdf');
      const row = await ctx.deps.db.db
        .selectFrom('version_files')
        .select('content_type')
        .where('version_id', '=', pdf.version.id)
        .executeTakeFirstOrThrow();
      expect(row.content_type).toBe('application/pdf');

      // A filename wins over the content type, and an archive under a filename is just a file.
      const tgz = await makeTar([{ name: 'index.html', body: 'x' }], { gzip: true });
      const kept = await upload(tgz, { type: 'text/html', filename: 'site.tgz' });
      expect(await paths(kept.version)).toEqual(['site.tgz']);

      await expect(
        upload(Buffer.from('%PDF-1.7'), { type: 'application/octet-stream' }),
      ).rejects.toMatchObject({
        status: 415,
        code: 'unsupported_media_type',
        message: t('publish.unsupported'),
      });
      await expect(upload(Buffer.from('x'), { filename: '.DS_Store' })).rejects.toMatchObject({
        status: 400,
        message: t('publish.entry.empty'),
      });
      await expect(upload(Buffer.from('x'), { filename: '../x.pdf' })).rejects.toMatchObject({
        status: 400,
        details: { reason: 'dot_segment' },
      });
      // Five uploads published; the three refused ones added no version.
      expect(await ctx.deps.db.db.selectFrom('versions').selectAll().execute()).toHaveLength(5);
    });

    test("curl's default content type is ignored for archives", async () => {
      const tgz = await makeTar([{ name: 'index.html', body: '<p>curl</p>' }], { gzip: true });
      const { version } = await upload(tgz, { type: 'application/x-www-form-urlencoded' });
      expect(await paths(version)).toEqual(['index.html']);
      expect(version.file_count).toBe(1);
    });

    test.each([
      ['closes', undefined, { status: 400, details: { reason: 'corrupt_archive' } }],
      [
        'fails',
        new Error('The upload body closed before it ended'),
        { status: 400, details: { reason: 'corrupt_archive' } },
      ],
      [
        'times out',
        new AppError('request_timeout', 408, 'idle'),
        { status: 408, code: 'request_timeout' },
      ],
    ] as const)(
      'a body that %s before its first 512 bytes arrive is a 4xx',
      async (_name, error, expected) => {
        const body = new Readable({ read() {} });
        body.push(Buffer.from('PK\x03\x04', 'latin1'));
        setImmediate(() => body.destroy(error));
        await expect(
          ingestUpload(
            ctx.deps,
            newTarget(),
            { body, contentType: null, contentLength: null, filename: null },
            opts,
          ),
        ).rejects.toMatchObject(expected);
        await expectNothingStored();
      },
    );

    test('a rejected upload keeps blobs other versions use', async () => {
      await publishFiles(ctx, actor, { 'a.css': 'x', 'index.html': '1' });
      await expect(
        upload(
          await makeTar([
            { name: 'a.css', body: 'x' },
            { name: 'new.css', body: 'only here' },
            { name: '../evil', body: 'e' },
          ]),
        ),
      ).rejects.toMatchObject({ status: 400, details: { reason: 'dot_segment' } });

      expect(await blobState(ctx.deps, sha('x'))).toEqual({ row: true, object: true });
      expect(await blobState(ctx.deps, sha('1'))).toEqual({ row: true, object: true });
      expect(await blobState(ctx.deps, sha('only here'))).toEqual({ row: false, object: false });
      expect((await storedBlobs()).sort()).toEqual([sha('x'), sha('1')].sort());
    });

    test('a version_conflict is found before the body is read', async () => {
      const v1 = await publishFiles(ctx, actor, { 'index.html': '1' });
      const stale: PublishTarget = {
        kind: 'new_version',
        artifactId: v1.artifact.id,
        expectedVersionId: v1.version.id,
      };
      const v2 = await publishFiles(ctx, actor, { 'index.html': '2' }, stale);

      const { body, pulled } = countingBody(
        await makeTar([{ name: 'index.html', body: '3' }], { gzip: true }),
      );
      await expect(
        ingestUpload(
          ctx.deps,
          stale,
          { body, contentType: null, contentLength: null, filename: null },
          opts,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'version_conflict',
        details: { current_version_id: v2.version.id, current_version_number: 2 },
      });
      expect(pulled()).toBe(0);
      expect(body.destroyed).toBe(true);
    });

    test('a new version goes on top of the current one', async () => {
      const v1 = await publishFiles(ctx, actor, { 'index.html': '1' });
      const { artifact, version } = await upload(
        await makeTar([{ name: 'index.html', body: '<title>Two</title>' }]),
        {
          target: {
            kind: 'new_version',
            artifactId: v1.artifact.id,
            expectedVersionId: v1.version.id,
          },
        },
      );
      expect(artifact).toMatchObject({ id: v1.artifact.id, current_version_id: version.id });
      expect(version).toMatchObject({ number: 2, parent_version_id: v1.version.id });
    });

    test('ingestFiles publishes a dropped folder', async () => {
      const { version } = await ingestFiles(
        ctx.deps,
        newTarget(),
        [
          { path: 'site/index.html', data: Buffer.from('<title>Dropped</title>') },
          { path: 'site/app.js', data: Buffer.from('run()') },
          { path: 'site/.DS_Store', data: Buffer.from('junk') },
        ],
        opts,
      );
      expect(await paths(version)).toEqual(['app.js', 'index.html']);
      expect(version).toMatchObject({ entry_path: 'index.html', title: 'Dropped' });

      await expect(
        ingestFiles(
          ctx.deps,
          newTarget(),
          [
            { path: 'index.html', data: Buffer.from('1') },
            { path: './index.html', data: Buffer.from('2') },
          ],
          opts,
        ),
      ).rejects.toMatchObject({ status: 400, details: { reason: 'duplicate' } });
    });

    test('warnings come back with the outcome', async () => {
      const { version, warnings } = await publishFiles(ctx, actor, {
        'index.html': '<link href="/x.css">',
      });
      expect(warnings).toEqual([
        expect.objectContaining({ code: 'root_absolute_url', file: 'index.html', url: '/x.css' }),
      ]);
      expect(JSON.parse(version.meta)).toEqual({ warnings });
    });

    test('metadata reads only the head of each file, by ranged reads', async () => {
      const get = vi.spyOn(ctx.deps.blobs, 'get');
      const page = `<title>Big</title>${' '.repeat(SCAN_MAX_BYTES)}<p>late</p>`;
      const notes = `# Notes${' '.repeat(MARKDOWN_MAX_BYTES)}late`;
      const { version } = await publishFiles(ctx, actor, {
        'index.html': page,
        'notes.md': notes,
        'empty.html': '',
        'logo.png': 'png',
      });

      expect(version.title).toBe('Big');
      expect(get.mock.calls).toEqual(
        expect.arrayContaining([
          [sha(page), { start: 0, end: SCAN_MAX_BYTES - 1 }],
          [sha(notes), { start: 0, end: MARKDOWN_MAX_BYTES - 1 }],
        ]),
      );
      // The empty page and the image are never read.
      expect(get).toHaveBeenCalledTimes(2);
    });

    test('a page of 200k characters of distinct Korean words publishes and is searchable', async () => {
      // The title and 66,665 two-syllable words fill the 200,000-unit text cap; folded to jamo,
      // they overflowed a Postgres tsvector.
      const words = Array.from({ length: 66_665 }, (_, n) =>
        String.fromCharCode(0xac00 + Math.floor(n / 11_172), 0xac00 + (n % 11_172)),
      );
      const { artifact } = await publishFiles(ctx, actor, {
        'index.html': `<title>보고서</title><p>${words.join(' ')}</p>`,
      });
      for (const q of [words[0], words[40_000], words[66_664], '보고서']) {
        expect(await searchQuery(ctx.deps.db, q ?? '', 10, SYSTEM_SCOPE), q).toEqual([artifact.id]);
      }
    });

    test('publishLinks names the artifact and the raw version on the public origin', () => {
      const origin = ctx.deps.config.publicOrigin;
      expect(publishLinks(ctx.deps.config, 'art_abc', 3)).toEqual({
        review_url: `${origin}/a/art_abc`,
        raw_url: `${origin}/a/art_abc/v/3/raw`,
      });
    });
  });

  describe('with small limits', () => {
    beforeEach(() => open(SMALL_LIMITS));

    test.each(REJECTIONS)(
      'a rejected upload leaves no version and no orphan blobs: %s',
      async (_name, build, expected) => {
        // The first 2 KB hold a.css; the rest arrives once it is stored, so the limits that count
        // ahead of the archive parser (request bytes, expansion) cannot fire before it is.
        const store = ctx.deps.blobs.put.bind(ctx.deps.blobs);
        let opened = () => {};
        const firstStored = new Promise<void>((resolve) => {
          opened = resolve;
        });
        const put = vi.spyOn(ctx.deps.blobs, 'put').mockImplementation(async (...args) => {
          await store(...args);
          opened();
        });

        await expect(upload(await build(), { gate: firstStored })).rejects.toMatchObject(expected);
        expect(put).toHaveBeenCalled();
        await expectNothingStored();
      },
    );

    test('a declared Content-Length over the limit is refused before the body is read', async () => {
      const { body, pulled } = countingBody(Buffer.from('<p>x</p>'));
      await expect(
        ingestUpload(
          ctx.deps,
          newTarget(),
          { body, contentType: 'text/html', contentLength: 20_001, filename: null },
          opts,
        ),
      ).rejects.toMatchObject({ status: 413, details: { limit: 'max_upload_bytes', max: 20000 } });
      expect(pulled()).toBe(0);
      expect(body.destroyed).toBe(true);
    });

    test('a single file is counted while it streams', async () => {
      await expect(upload(bytes(1001), { type: 'text/html' })).rejects.toMatchObject({
        status: 413,
        details: { limit: 'max_file_bytes', max: 1000, path: 'index.html' },
      });
      await expectNothingStored();
    });
  });

  describe('inline', () => {
    beforeEach(() => open({ PINWALL_MAX_INLINE_BYTES: '100' }));

    test('inline publish takes text files within the inline limit', async () => {
      const { version } = await ingestInline(
        ctx.deps,
        newTarget(),
        [{ path: 'index.html', content: '<h1>chụp ảnh</h1>' }],
        { ...opts, source: 'inline' },
      );
      expect(version).toMatchObject({
        source: 'inline',
        title: 'chụp ảnh',
        entry_path: 'index.html',
      });
      expect(await contentOf(version, 'index.html')).toBe('<h1>chụp ảnh</h1>');

      await expect(
        ingestInline(
          ctx.deps,
          newTarget(),
          [
            { path: 'index.html', content: 'x' },
            { path: 'a.png', content: 'x' },
          ],
          opts,
        ),
      ).rejects.toMatchObject({
        status: 400,
        message: t('publish.inline.textOnly', { path: 'a.png' }),
        details: { reason: 'inline_text_only', path: 'a.png' },
      });

      // 34 characters, 102 bytes in UTF-8.
      const wide = 'ả'.repeat(34);
      await expect(
        ingestInline(ctx.deps, newTarget(), [{ path: 'index.md', content: wide }], opts),
      ).rejects.toMatchObject({ status: 413, details: { limit: 'max_inline_bytes', max: 100 } });
      expect(await ctx.deps.db.db.selectFrom('versions').selectAll().execute()).toHaveLength(1);
    });
  });
});
