import { PublishResult } from '@pinwall/shared';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { makeTar, makeZip } from '../helpers/archives.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { aroundSpoolStores } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { listen, openPost, socketPost, split, watchUncaught } from '../helpers/socket.ts';

const T = Date.UTC(2026, 10, 11);

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

const BOUNDARY = 'pinwall-test-form';

/** One multipart part as a browser writes it, followed by the line end before the next. */
function part(
  p: { name: string; value: string } | { name: string; filename: string; body: string | Buffer },
): Buffer {
  const head =
    'filename' in p
      ? `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n'
      : `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n`;
  const body = 'filename' in p ? p.body : p.value;
  return Buffer.concat([Buffer.from(head), Buffer.from(body), Buffer.from('\r\n')]);
}

describe.each(dialects)('publishing over REST on %s', (dialect) => {
  let ctx: TestContext;
  let member: { user: UserRow; cookie: string };
  afterEach(() => ctx.close());

  async function start(env: Record<string, string> = {}): Promise<void> {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T), env });
    member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
  }

  const inline = (body: unknown, o: { cookie?: string; bearer?: string } = {}) =>
    ctx.request(
      '/api/v1/publish/inline',
      apiInit(
        ctx,
        o.bearer === undefined ? { cookie: o.cookie ?? member.cookie, body } : { ...o, body },
      ),
    );

  /**
   * Posts `form` to the web upload route with the member's cookie from the app's own origin, as
   * the bytes a browser sends. (undici's own stream of a FormData body throws when the server
   * stops reading it early, which the upload route does on purpose.)
   */
  const upload = async (form: FormData, o: { origin?: string; cookie?: string } = {}) => {
    const encoded = new Response(form);
    return ctx.request('/api/v1/publish/upload', {
      method: 'POST',
      body: Buffer.from(await encoded.arrayBuffer()),
      headers: {
        cookie: o.cookie ?? member.cookie,
        origin: o.origin ?? ctx.deps.config.publicOrigin,
        'content-type': encoded.headers.get('content-type') ?? '',
      },
    });
  };

  const errorOf = async (r: Response) => ((await r.json()) as ErrorJson).error;

  /** The headers a browser sends with a form from the app's own origin, chunked. */
  const formHeaders = () => ({
    cookie: member.cookie,
    origin: ctx.deps.config.publicOrigin,
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    'transfer-encoding': 'chunked',
  });

  const versions = () => ctx.deps.db.db.selectFrom('versions').selectAll().execute();

  async function storedBlobs(): Promise<{ rows: unknown[]; objects: string[] }> {
    const objects: string[] = [];
    for await (const key of ctx.deps.blobs.list()) objects.push(key);
    return { rows: await ctx.deps.db.db.selectFrom('blobs').selectAll().execute(), objects };
  }

  const versionRow = (id: string) =>
    ctx.deps.db.db
      .selectFrom('versions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  async function pathsOf(versionId: string): Promise<string[]> {
    const rows = await ctx.deps.db.db
      .selectFrom('version_files')
      .select('path')
      .where('version_id', '=', versionId)
      .execute();
    return rows.map((row) => row.path).sort();
  }

  const file = (text: string | Buffer, name: string) =>
    new File([new Uint8Array(Buffer.from(text))], name);

  test('inline publish over REST', async () => {
    await start();
    const r = await inline({
      target: {},
      message: 'Draft',
      files: [{ path: 'index.md', content: '# Hi' }],
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = PublishResult.parse(await r.json());
    expect(body).toMatchObject({
      kind: 'markdown',
      entry_path: 'index.md',
      version_number: 1,
      file_count: 1,
      total_bytes: 4,
      review_url: `http://localhost:8080/a/${body.artifact_id}`,
    });
    expect(await versionRow(body.version_id)).toMatchObject({
      source: 'inline',
      message: 'Draft',
      created_by: member.user.id,
    });
  });

  test('inline publish by API token, on top of the current version', async () => {
    await start();
    const bearer = await createUserToken(ctx, member.user.id);
    const first = PublishResult.parse(
      await (
        await inline(
          {
            target: { name: 'Plan', tags: ['Q4'] },
            files: [{ path: 'a.html', content: '<p>1</p>' }],
          },
          { bearer },
        )
      ).json(),
    );
    const r = await inline(
      {
        target: { artifact_id: first.artifact_id, expected_version_id: first.version_id },
        files: [{ path: 'index.html', content: '<p>2</p>' }],
      },
      { bearer },
    );
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ artifact_id: first.artifact_id, version_number: 2 });

    const stale = await inline(
      {
        target: { artifact_id: first.artifact_id, expected_version_id: first.version_id },
        files: [{ path: 'index.html', content: '<p>3</p>' }],
      },
      { bearer },
    );
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('version_conflict');
  });

  test('inline publish refuses names that are not valid Unicode', async () => {
    await start();
    // JSON can carry half of a surrogate pair; both databases would store U+FFFD instead.
    const r = await inline({
      target: {},
      files: [
        { path: 'a\ud800.html', content: '<p>1</p>' },
        { path: 'a\udbff.html', content: '<p>2</p>' },
      ],
    });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toMatchObject({
      code: 'bad_request',
      details: { issues: [{ path: 'files.0.path' }, { path: 'files.1.path' }] },
    });
    expect(await ctx.deps.db.db.selectFrom('versions').selectAll().execute()).toEqual([]);
  });

  test('inline publish is held to the inline limits', async () => {
    await start({ PINWALL_MAX_INLINE_BYTES: '1000' });
    const over = await inline({
      target: {},
      files: [{ path: 'index.html', content: 'x'.repeat(1001) }],
    });
    expect(over.status).toBe(413);
    expect(await errorOf(over)).toMatchObject({
      code: 'payload_too_large',
      details: { limit: 'max_inline_bytes', max: 1000 },
    });

    // A body that cannot fit is refused before it is parsed: twice the limit plus 64 KiB.
    const huge = await inline({
      target: {},
      files: [{ path: 'index.html', content: 'x'.repeat(2 * 1000 + 65_536) }],
    });
    expect(huge.status).toBe(413);
    expect(await errorOf(huge)).toMatchObject({
      details: { limit: 'max_inline_bytes', max: 1000 },
    });

    const binary = await inline({
      target: {},
      files: [{ path: 'logo.png', content: 'png' }],
    });
    expect(binary.status).toBe(400);
    expect(await errorOf(binary)).toMatchObject({ details: { reason: 'inline_text_only' } });
  });

  test('inline publish needs auth and a same-origin browser', async () => {
    await start();
    const body = { target: {}, files: [{ path: 'index.md', content: '# Hi' }] };
    const anonymous = await ctx.request('/api/v1/publish/inline', apiInit(ctx, { body }));
    expect(anonymous.status).toBe(401);
    const sameSite = await inline(body, { cookie: member.cookie });
    expect(sameSite.status).toBe(201);
    const evil = await ctx.request(
      '/api/v1/publish/inline',
      apiInit(ctx, { cookie: member.cookie, body, origin: 'https://evil.example' }),
    );
    expect(evil.status).toBe(403);
  });

  test('web upload of a dropped folder and of one archive', async () => {
    await start();
    const folder = new FormData();
    folder.append('target', '{}');
    folder.append('message', 'From the browser');
    folder.append('path', 'site/index.html');
    folder.append('file', file('<title>Folder</title>', 'index.html'));
    folder.append('path', 'site/a.css');
    folder.append('file', file('p{}', 'a.css'));
    const r1 = await upload(folder);
    expect(r1.status).toBe(201);
    const v1 = PublishResult.parse(await r1.json());
    expect(v1).toMatchObject({ entry_path: 'index.html', file_count: 2, kind: 'html' });
    expect(await pathsOf(v1.version_id)).toEqual(['a.css', 'index.html']);
    expect(await versionRow(v1.version_id)).toMatchObject({
      source: 'web',
      message: 'From the browser',
      title: 'Folder',
    });

    const zip = new FormData();
    zip.append('target', '{}');
    zip.append(
      'file',
      file(
        makeZip([
          { name: 'index.md', body: '# Zipped' },
          { name: 'img/a.png', body: 'png' },
        ]),
        'site.zip',
      ),
    );
    const r2 = await upload(zip);
    expect(r2.status).toBe(201);
    const v2 = PublishResult.parse(await r2.json());
    expect(v2).toMatchObject({ entry_path: 'index.md', kind: 'markdown', file_count: 2 });

    const noTarget = new FormData();
    noTarget.append('file', file('<p>x</p>', 'index.html'));
    const r3 = await upload(noTarget);
    expect(r3.status).toBe(400);
    expect(await errorOf(r3)).toEqual({ code: 'bad_request', message: t('publish.upload.form') });

    const crossSite = new FormData();
    crossSite.append('target', '{}');
    crossSite.append('file', file('<p>x</p>', 'index.html'));
    expect((await upload(crossSite, { origin: 'https://evil.example' })).status).toBe(403);
  });

  test('web upload takes single files and tar.gz archives by their names', async () => {
    await start();
    const single = new FormData();
    single.append('target', JSON.stringify({ name: 'Report' }));
    single.append('file', file('%PDF-1.7', 'report.pdf'));
    const r1 = await upload(single);
    expect(r1.status).toBe(201);
    expect(await r1.json()).toMatchObject({ entry_path: 'report.pdf', file_count: 1 });

    const tgz = new FormData();
    tgz.append('target', '{}');
    tgz.append(
      'file',
      file(
        await makeTar([{ name: 'site/index.html', body: '<p>t</p>' }], { gzip: true }),
        'S.TAR.GZ',
      ),
    );
    const r2 = await upload(tgz);
    expect(r2.status).toBe(201);
    expect(await r2.json()).toMatchObject({ entry_path: 'index.html', file_count: 1 });

    // With a path, an archive is just a file of the folder (whose lone folder is removed).
    const kept = new FormData();
    kept.append('target', '{}');
    kept.append('path', 'downloads/site.zip');
    kept.append('file', file(makeZip([{ name: 'index.html', body: 'z' }]), 'site.zip'));
    const r3 = await upload(kept);
    expect(r3.status).toBe(201);
    expect(await r3.json()).toMatchObject({ entry_path: 'site.zip', file_count: 1 });

    const notAnArchive = new FormData();
    notAnArchive.append('target', '{}');
    notAnArchive.append('file', file('hello', 'notes.zip'));
    const r4 = await upload(notAnArchive);
    expect(r4.status).toBe(415);
  });

  test('a web upload form that does not add up is refused', async () => {
    await start();
    const extraPath = new FormData();
    extraPath.append('target', '{}');
    extraPath.append('path', 'a.html');
    extraPath.append('path', 'b.html');
    extraPath.append('file', file('<p>a</p>', 'a.html'));
    expect(await errorOf(await upload(extraPath))).toMatchObject({
      message: t('publish.upload.form'),
    });

    const badTarget = new FormData();
    badTarget.append('target', '{"artifact_id":');
    badTarget.append('file', file('<p>a</p>', 'a.html'));
    const r2 = await upload(badTarget);
    expect(r2.status).toBe(400);
    expect(await errorOf(r2)).toMatchObject({ details: { issues: [{ path: 'target' }] } });

    const traversal = new FormData();
    traversal.append('target', '{}');
    traversal.append('path', '../index.html');
    traversal.append('file', file('<p>a</p>', 'index.html'));
    const r3 = await upload(traversal);
    expect(r3.status).toBe(400);
    expect(await errorOf(r3)).toMatchObject({ details: { reason: 'dot_segment' } });

    const notMultipart = await ctx.request('/api/v1/publish/upload', {
      method: 'POST',
      body: 'target=%7B%7D',
      headers: {
        cookie: member.cookie,
        origin: ctx.deps.config.publicOrigin,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    expect(notMultipart.status).toBe(400);
    expect(await errorOf(notMultipart)).toMatchObject({ message: t('publish.upload.form') });
  });

  test('a web upload over the upload limit is 413', async () => {
    await start({ PINWALL_MAX_UPLOAD_BYTES: '10000' });
    const form = new FormData();
    form.append('target', '{}');
    form.append('file', file(Buffer.alloc(20_000, 1), 'big.bin'));
    const r = await upload(form);
    expect(r.status).toBe(413);
    expect(await errorOf(r)).toMatchObject({
      code: 'payload_too_large',
      details: { limit: 'max_upload_bytes', max: 10000 },
    });
  });

  test('a web upload is refused at its first extra file, before the body ends', async () => {
    await start({ PINWALL_MAX_FILES: '3' });
    const server = await listen(ctx.app, ctx.deps.config);
    try {
      // The fourth file part arrives, then the browser keeps the request open.
      const reply = await socketPost(server.port, '/api/v1/publish/upload', {
        headers: formHeaders(),
        chunks: [
          part({ name: 'target', value: '{}' }),
          ...['index.html', 'a.css', 'b.js', 'c.txt'].map((filename) =>
            part({ name: 'file', filename, body: `/* ${filename} */` }),
          ),
        ],
        stall: true,
      });
      expect(reply.status).toBe(413);
      expect(reply.json).toMatchObject({
        error: { code: 'payload_too_large', details: { limit: 'max_files', max: 3 } },
      });
    } finally {
      await server.close();
    }
    expect(await versions()).toEqual([]);
    expect(await storedBlobs()).toEqual({ rows: [], objects: [] });
  });

  test('a file over the per-file limit is refused while it streams, leaving no blobs', async () => {
    await start({ PINWALL_MAX_FILE_BYTES: '10000' });
    const server = await listen(ctx.app, ctx.deps.config);
    try {
      // index.html is stored whole; big.bin goes past the limit and never ends.
      const reply = await socketPost(server.port, '/api/v1/publish/upload', {
        headers: formHeaders(),
        chunks: [
          part({ name: 'target', value: '{}' }),
          part({ name: 'file', filename: 'index.html', body: '<p>x</p>' }),
          part({ name: 'file', filename: 'big.bin', body: Buffer.alloc(20_000, 1) }).subarray(
            0,
            -100,
          ),
        ],
        stall: true,
      });
      expect(reply.status).toBe(413);
      expect(reply.json).toMatchObject({
        error: { details: { limit: 'max_file_bytes', max: 10000, path: 'big.bin' } },
      });
    } finally {
      await server.close();
    }
    expect(await versions()).toEqual([]);
    expect(await storedBlobs()).toEqual({ rows: [], objects: [] });
  });

  test('a declared length over the upload limit is refused before the body is read', async () => {
    await start({ PINWALL_MAX_UPLOAD_BYTES: '10000' });
    const server = await listen(ctx.app, ctx.deps.config);
    try {
      const { 'transfer-encoding': _, ...headers } = formHeaders();
      const reply = await socketPost(server.port, '/api/v1/publish/upload', {
        headers: { ...headers, 'content-length': '10001' },
        chunks: [part({ name: 'target', value: '{}' })],
        stall: true,
      });
      expect(reply.status).toBe(413);
      expect(reply.json).toMatchObject({
        error: { details: { limit: 'max_upload_bytes', max: 10000 } },
      });
    } finally {
      await server.close();
    }
  });

  test('a web upload streams over a real socket', async () => {
    await start();
    const server = await listen(ctx.app, ctx.deps.config);
    try {
      const body = Buffer.concat([
        part({ name: 'target', value: '{"name":"Streamed"}' }),
        part({ name: 'message', value: 'Gửi từ trình duyệt' }),
        part({ name: 'path', value: 'site/index.html' }),
        part({ name: 'file', filename: 'index.html', body: '<title>Báo cáo</title>' }),
        part({ name: 'path', value: 'site/img/logo.png' }),
        part({ name: 'file', filename: 'logo.png', body: Buffer.alloc(50_000, 7) }),
        Buffer.from(`--${BOUNDARY}--\r\n`),
      ]);
      const reply = await socketPost(server.port, '/api/v1/publish/upload', {
        headers: formHeaders(),
        chunks: split(body, 13),
      });
      expect(reply.status).toBe(201);
      const result = PublishResult.parse(reply.json);
      expect(result).toMatchObject({ entry_path: 'index.html', file_count: 2 });
      expect(await pathsOf(result.version_id)).toEqual(['img/logo.png', 'index.html']);
      expect(await versionRow(result.version_id)).toMatchObject({
        message: 'Gửi từ trình duyệt',
        title: 'Báo cáo',
      });
    } finally {
      await server.close();
    }
  });

  describe('a client that resets the connection', () => {
    /**
     * Opens a request to `path` that sends `first` and then resets, while `hold` keeps the
     * publish busy elsewhere; checks the request ends as a 400 that takes nothing down and keeps
     * nothing, then that the server still publishes.
     */
    async function resetWhileBusy(o: {
      path: string;
      headers: Record<string, string>;
      first: Buffer;
      hold: (gate: Promise<void>, reached: () => void) => () => void;
    }): Promise<void> {
      const server = await listen(ctx.app, ctx.deps.config);
      const uncaught = watchUncaught();
      const info = vi.spyOn(ctx.deps.logger, 'info');
      const errors = vi.spyOn(ctx.deps.logger, 'error');
      let reached = () => {};
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let open = () => {};
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const restore = o.hold(opened, reached);
      try {
        const request = await openPost(server.server, server.port, o.path, o.headers, o.first);
        await atGate;
        await request.reset();
        // Time for the broken body to fail while nothing reads it.
        await new Promise((resolve) => setTimeout(resolve, 50));
        open();
        await vi.waitFor(() =>
          expect(info).toHaveBeenCalledWith(
            expect.objectContaining({ path: o.path, status: 400 }),
            'request',
          ),
        );
        restore();
        expect(uncaught.errors).toEqual([]);
        expect(errors).not.toHaveBeenCalled();
        expect(await versions()).toEqual([]);
        expect(await storedBlobs()).toEqual({ rows: [], objects: [] });
        const retry = await socketPost(server.port, '/api/v1/publish/upload', {
          headers: formHeaders(),
          chunks: [
            part({ name: 'target', value: '{}' }),
            part({ name: 'file', filename: 'index.html', body: '<p>again</p>' }),
            Buffer.from(`--${BOUNDARY}--\r\n`),
          ],
        });
        expect(retry.status).toBe(201);
      } finally {
        open();
        restore();
        uncaught.stop();
        info.mockRestore();
        errors.mockRestore();
        await server.close();
      }
    }

    test('a web upload whose next part waits unread ends as a 400', async () => {
      await start();
      // index.html arrives whole and is stored; the reset comes while its blob is being put,
      // with the start of the next part read by the form but by no one else.
      await resetWhileBusy({
        path: '/api/v1/publish/upload',
        headers: formHeaders(),
        first: Buffer.concat([
          part({ name: 'target', value: '{}' }),
          part({ name: 'file', filename: 'index.html', body: '<p>x</p>' }),
          part({ name: 'file', filename: 'a.css', body: 'p{}'.repeat(100) }).subarray(0, -50),
        ]),
        hold: (gate, reached) => {
          const spy = aroundSpoolStores(ctx.deps.blobs, async (store) => {
            reached();
            await gate;
            await store();
          });
          return () => spy.mockRestore();
        },
      });
    });

    test('an inline publish whose body breaks off ends as a 400', async () => {
      await start();
      await resetWhileBusy({
        path: '/api/v1/publish/inline',
        headers: {
          cookie: member.cookie,
          origin: ctx.deps.config.publicOrigin,
          'content-type': 'application/json',
        },
        first: Buffer.from('{"target":{},"files":[{"path":"index.html","content":"<p>'),
        // The body limit reads the body as it arrives; nothing else is busy.
        hold: (_gate, reached) => {
          reached();
          return () => {};
        },
      });
    });
  });

  test('the target and message come before the files, and paths go with every file or none', async () => {
    await start();
    const late = new FormData();
    late.append('file', file('<p>a</p>', 'index.html'));
    late.append('target', '{}');
    expect(await errorOf(await upload(late))).toEqual({
      code: 'bad_request',
      message: t('publish.upload.form'),
    });

    const lateMessage = new FormData();
    lateMessage.append('target', '{}');
    lateMessage.append('file', file('<p>a</p>', 'index.html'));
    lateMessage.append('message', 'too late');
    expect((await upload(lateMessage)).status).toBe(400);

    const mixed = new FormData();
    mixed.append('target', '{}');
    mixed.append('path', 'index.html');
    mixed.append('file', file('<p>a</p>', 'index.html'));
    mixed.append('file', file('p{}', 'a.css'));
    expect(await errorOf(await upload(mixed))).toMatchObject({ message: t('publish.upload.form') });

    const trailingPath = new FormData();
    trailingPath.append('target', '{}');
    trailingPath.append('path', 'index.html');
    trailingPath.append('file', file('<p>a</p>', 'index.html'));
    trailingPath.append('path', 'a.css');
    expect((await upload(trailingPath)).status).toBe(400);
    expect(await versions()).toEqual([]);
  });

  test('an archive part is unpacked only as the one file of the form', async () => {
    await start();
    const zip = makeZip([{ name: 'index.html', body: '<p>z</p>' }]);
    const two = new FormData();
    two.append('target', '{}');
    two.append('file', file(zip, 'site.zip'));
    two.append('file', file('<p>b</p>', 'b.html'));
    const r = await upload(two);
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toEqual({
      code: 'bad_request',
      message: t('publish.upload.archiveAlone'),
    });
    expect(await versions()).toEqual([]);
    expect(await storedBlobs()).toEqual({ rows: [], objects: [] });

    // Behind another file, or with paths, archives are plain files.
    const behind = new FormData();
    behind.append('target', '{}');
    behind.append('file', file('<p>a</p>', 'index.html'));
    behind.append('file', file(zip, 'site.zip'));
    expect(await (await upload(behind)).json()).toMatchObject({ file_count: 2 });
  });

  test('junk and parts not named file are drained, and field values are capped', async () => {
    await start();
    const form = new FormData();
    form.append('target', '{}');
    form.append('attachment', file('ignored', 'notes.txt'));
    form.append('file', file('junk', '.DS_Store'));
    form.append('file', file('<p>kept</p>', 'index.html'));
    const r = await upload(form);
    expect(r.status).toBe(201);
    const result = PublishResult.parse(await r.json());
    expect(await pathsOf(result.version_id)).toEqual(['index.html']);

    const huge = new FormData();
    huge.append('target', '{}');
    huge.append('message', 'x'.repeat(65_537));
    huge.append('file', file('<p>x</p>', 'index.html'));
    const r2 = await upload(huge);
    expect(r2.status).toBe(400);
    expect(await errorOf(r2)).toEqual({ code: 'bad_request', message: t('publish.upload.form') });
  });

  test('file names keep their Unicode', async () => {
    await start();
    const form = new FormData();
    form.append('target', '{}');
    form.append('file', file('<p>x</p>', 'Báo cáo điện thoại.html'));
    const r = await upload(form);
    expect(r.status).toBe(201);
    const result = PublishResult.parse(await r.json());
    expect(await pathsOf(result.version_id)).toEqual(['Báo cáo điện thoại.html']);
  });

  test('the routes are in the OpenAPI document', async () => {
    await start();
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/publish-sessions', '/publish/inline', '/publish/upload']),
    );
  });
});
