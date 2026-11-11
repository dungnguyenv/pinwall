import { PublishResult } from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { makeTar, makeZip } from '../helpers/archives.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const T = Date.UTC(2026, 10, 11);

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
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

  /** Posts `form` to the web upload route with the member's cookie from the app's own origin. */
  const upload = (form: FormData, o: { origin?: string; cookie?: string } = {}) =>
    ctx.request('/api/v1/publish/upload', {
      method: 'POST',
      body: form,
      headers: {
        cookie: o.cookie ?? member.cookie,
        origin: o.origin ?? ctx.deps.config.publicOrigin,
      },
    });

  const errorOf = async (r: Response) => ((await r.json()) as ErrorJson).error;

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
