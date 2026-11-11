import { createHash } from 'node:crypto';
import {
  ArtifactList,
  ContentGrant,
  PublishResult,
  PublishSession,
  VersionDiff,
} from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { annotatorTag } from '../../src/content/annotator-inject.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { makeTar } from '../helpers/archives.ts';
import { setupOwner } from '../helpers/auth.ts';
import { blobState, sha } from '../helpers/blobs.ts';
import { CONTENT_ENV } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { restClient } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 11);

/** Every path M4 adds to the API, relative to `/api/v1`. */
const M4_PATHS = [
  '/publish-sessions',
  '/publish/inline',
  '/publish/upload',
  '/projects',
  '/projects/{id}',
  '/artifacts',
  '/artifacts/recent',
  '/artifacts/{id}',
  '/artifacts/{id}/versions',
  '/artifacts/{id}/versions/{n}',
  '/artifacts/{id}/versions/{n}/files',
  '/artifacts/{id}/versions/{n}/restore',
  '/artifacts/{id}/versions/{n}/preview',
  '/artifacts/{id}/thumbnail',
  '/artifacts/{id}/diff',
  '/artifacts/{id}/diff/file',
  '/artifacts/{id}/diff/markdown',
];

const INDEX_V1 = '<!doctype html><title>Lịch chụp ảnh</title><a href="docs/">Docs</a>';
const DOCS = '<!doctype html><title>Docs</title><video src="../media/clip.mp4"></video>';
/** The start of an MP4 file, then some bytes. */
const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
  Buffer.alloc(4096, 7),
]);

describe.each(dialects)('the M4 publishing flow on %s', (dialect) => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  test('publish, preview, update, compare, search, delete and describe', async () => {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T), env: { ...CONTENT_ENV } });
    expect(ctx.deps.config.publicOrigin).toBe('https://pinwall.test');

    // 1. The owner asks for an upload URL.
    const { cookie } = await setupOwner(ctx);
    const api = restClient(ctx, cookie);
    const created = await api.post('/publish-sessions', { target: {} });
    expect(created.status).toBe(201);
    const session = PublishSession.parse(created.body);
    expect(session.upload_url).toMatch(/^https:\/\/pinwall\.test\/upload\/[A-Za-z0-9_-]{43}$/);

    // 2. A two-page site with a folder and a video, as `tar -czf - -C ./site .` packs it.
    const site = await makeTar(
      [
        { name: './', type: 'directory' },
        { name: './index.html', body: INDEX_V1 },
        { name: './docs/', type: 'directory' },
        { name: './docs/index.html', body: DOCS },
        { name: './media/', type: 'directory' },
        { name: './media/clip.mp4', body: VIDEO },
      ],
      { gzip: true },
    );
    const uploaded = await ctx.request(session.upload_url, {
      method: 'POST',
      body: site,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(uploaded.status).toBe(201);
    const v1 = PublishResult.parse(await uploaded.json());
    expect(v1).toMatchObject({
      version_number: 1,
      kind: 'html',
      entry_path: 'index.html',
      file_count: 3,
    });
    const id = v1.artifact_id;

    // 3. A review preview on the content host serves the page with the annotator tag after the
    //    doctype, and the folder redirects.
    const previewed = await api.get(`/artifacts/${id}/versions/1/preview?mode=review`);
    expect(previewed.status).toBe(200);
    const grant = ContentGrant.parse(previewed.body);
    expect(grant).toMatchObject({ mode: 'review', isolation: 'content-domain' });
    expect(grant.url).toMatch(/^https:\/\/[0-9a-hjkmnp-tv-z]{32}\.pw-content\.test\/$/);
    const page = await ctx.request(grant.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const annotated = (html: string) =>
      html.replace('<!doctype html>', `<!doctype html>${annotatorTag(grant.url)}`);
    expect(await page.text()).toBe(annotated(INDEX_V1));
    const folder = await ctx.request(new URL('docs', grant.url).href);
    expect(folder.status).toBe(308);
    expect(new URL(folder.headers.get('location') ?? '', grant.url).href).toBe(
      new URL('docs/', grant.url).href,
    );
    expect(await (await ctx.request(new URL('docs/', grant.url).href)).text()).toBe(
      annotated(DOCS),
    );
    const video = await ctx.request(new URL('media/clip.mp4', grant.url).href);
    expect(video.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await video.arrayBuffer()).equals(VIDEO)).toBe(true);

    // 4. Version 2, published inline on top of version 1, and the diff between them.
    const inline = await api.post('/publish/inline', {
      target: { artifact_id: id, expected_version_id: v1.version_id },
      message: 'Drop the video',
      files: [
        { path: 'index.html', content: '<!doctype html><title>Lịch chụp ảnh cưới</title>' },
        { path: 'docs/index.html', content: DOCS },
      ],
    });
    expect(inline.status).toBe(201);
    expect(PublishResult.parse(inline.body).version_number).toBe(2);
    const diff = await api.get(`/artifacts/${id}/diff?from=1&to=2`);
    expect(diff.status).toBe(200);
    expect(VersionDiff.parse(diff.body).files.map((f) => [f.path, f.status])).toEqual([
      ['index.html', 'modified'],
      ['media/clip.mp4', 'removed'],
    ]);

    // 5. Search finds it, accents left out.
    const found = await api.get(`/artifacts?q=${encodeURIComponent('lich chup anh cuoi')}`);
    expect(ArtifactList.parse(found.body).items.map((a) => a.id)).toEqual([id]);

    // 6. Deleting version 1 ends its grant at once and frees the video.
    expect((await api.del(`/artifacts/${id}/versions/1`)).status).toBe(204);
    expect((await ctx.request(grant.url)).status).toBe(410);
    expect(await blobState(ctx.deps, sha(INDEX_V1))).toEqual({ row: false, object: false });
    const videoSha = createHash('sha256').update(VIDEO).digest('hex');
    expect(await blobState(ctx.deps, videoSha)).toEqual({ row: false, object: false });
    // docs/index.html is still in version 2.
    expect(await blobState(ctx.deps, sha(DOCS))).toEqual({ row: true, object: true });

    // 7. The API document lists every M4 path, deletion included.
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    for (const path of M4_PATHS) expect(doc.paths, path).toHaveProperty([path]);
    expect(Object.keys(doc.paths['/artifacts/{id}'] ?? {})).toContain('delete');
    expect(Object.keys(doc.paths['/artifacts/{id}/versions/{n}'] ?? {})).toContain('delete');
  });
});
