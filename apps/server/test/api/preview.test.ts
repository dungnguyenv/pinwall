import { createHash, randomBytes } from 'node:crypto';
import { ContentGrant } from '@pinwall/shared';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { annotatorTag } from '../../src/content/annotator-inject.ts';
import { THUMBNAIL_CSP } from '../../src/content/raw-links.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { listRecent } from '../../src/domain/artifacts.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { CONTENT_ENV } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';
import { type ErrorJson, restClient } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 11);

const MODES = [
  ['single-domain', {}],
  ['content-domain', CONTENT_ENV],
] as const;
const cases = dialects.flatMap((dialect) =>
  MODES.map(([mode, env]) => [dialect, mode, env] as const),
);

/** A PNG signature followed by random bytes, NUL included. */
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0]),
    randomBytes(200),
  ]);

describe.each(cases)('previews and thumbnails on %s in %s mode', (dialect, mode, env) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let member: { user: UserRow; cookie: string };
  let api: ReturnType<typeof restClient>;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env: { ...env } });
    member = await createSignedInUser(ctx);
    api = restClient(ctx, member.cookie);
  });
  afterEach(() => ctx.close());

  const preview = (artifactId: string, n: number, query = '') =>
    api.get(`/artifacts/${artifactId}/versions/${n}/preview${query}`);

  test('preview returns a content URL for the current mode', async () => {
    const html = '<!doctype html><title>Báo cáo</title><p>Xin chào</p>';
    const { artifact } = await publishFiles(ctx, member.user, { 'index.html': html });
    clock.advance(1_000);

    const r = await preview(artifact.id, 1);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const grant = ContentGrant.parse(r.body);
    expect(grant.mode).toBe('review');
    expect(grant.isolation).toBe(mode);
    expect(grant.expires_at).toBe(clock.now() + 43_200_000);
    if (mode === 'single-domain') {
      expect(grant.url.startsWith('http://localhost:8080/c/')).toBe(true);
      expect(grant.url.endsWith('/')).toBe(true);
    } else {
      expect(grant.url).toMatch(/^https:\/\/[0-9a-hjkmnp-tv-z]{32}\.pw-content\.test\/$/);
    }

    // A review grant adds the annotator tag (after the doctype here); a raw one serves the bytes.
    const served = await ctx.request(grant.url);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(
      html.replace('<!doctype html>', `<!doctype html>${annotatorTag(grant.url)}`),
    );

    const raw = await preview(artifact.id, 1, '?mode=raw');
    expect(raw.status).toBe(200);
    const rawGrant = ContentGrant.parse(raw.body);
    expect(rawGrant.mode).toBe('raw');
    expect(rawGrant.url).not.toBe(grant.url);
    const rawServed = await ctx.request(rawGrant.url);
    expect(rawServed.status).toBe(200);
    expect(await rawServed.text()).toBe(html);

    expect((await preview(artifact.id, 1, '?mode=other')).status).toBe(400);
    const anonymous = await ctx.request(`/api/v1/artifacts/${artifact.id}/versions/1/preview`);
    expect(anonymous.status).toBe(401);
  });

  test('preview answers 404 and 410 like the version it names', async () => {
    const { artifact } = await publishFiles(ctx, member.user, { 'index.html': '<p>one</p>' });
    expect((await preview(artifact.id, 2)).status).toBe(404);
    expect((await preview('art_unknown', 1)).status).toBe(404);
    await ctx.deps.db.db.deleteFrom('versions').where('artifact_id', '=', artifact.id).execute();
    const gone = await preview(artifact.id, 1);
    expect(gone.status).toBe(410);
    expect((gone.body as ErrorJson).error.message).toBe(t('version.gone'));
  });

  test('a review preview records a view; a raw one does not', async () => {
    const { artifact } = await publishFiles(ctx, member.user, { 'index.html': '<p>seen</p>' });
    expect((await preview(artifact.id, 1, '?mode=raw')).status).toBe(200);
    expect(await listRecent(ctx.deps, member.user.id, 20)).toEqual([]);
    expect((await preview(artifact.id, 1)).status).toBe(200);
    expect((await listRecent(ctx.deps, member.user.id, 20)).map((a) => a.id)).toEqual([
      artifact.id,
    ]);
  });

  test('thumbnails are raster only, with locked-down headers', async () => {
    const cover = png();
    const withCover = await publishFiles(ctx, member.user, {
      'index.html': '<meta property="og:image" content="cover.png"><p>x</p>',
      'cover.png': cover,
    });
    const r = await ctx.request(
      `/api/v1/artifacts/${withCover.artifact.id}/thumbnail`,
      apiInit(ctx, { cookie: member.cookie }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(THUMBNAIL_CSP).toBe("default-src 'none'; sandbox");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, max-age=300');
    const etag = `"${createHash('sha256').update(cover).digest('hex')}"`;
    expect(r.headers.get('etag')).toBe(etag);
    expect(r.headers.get('content-length')).toBe(String(cover.length));
    expect(Buffer.from(await r.arrayBuffer()).equals(cover)).toBe(true);

    const cached = await ctx.request(
      `/api/v1/artifacts/${withCover.artifact.id}/thumbnail`,
      apiInit(ctx, { cookie: member.cookie, headers: { 'if-none-match': etag } }),
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get('etag')).toBe(etag);
    expect(cached.headers.get('content-security-policy')).toBe(THUMBNAIL_CSP);
    expect(await cached.text()).toBe('');

    const head = await ctx.request(
      `/api/v1/artifacts/${withCover.artifact.id}/thumbnail`,
      apiInit(ctx, { method: 'HEAD', cookie: member.cookie }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(cover.length));
    expect(await head.text()).toBe('');

    const svgOnly = await publishFiles(ctx, member.user, {
      'index.html': '<meta property="og:image" content="logo.svg"><p>x</p>',
      'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    const svg = await api.get<ErrorJson>(`/artifacts/${svgOnly.artifact.id}/thumbnail`);
    expect(svg.status).toBe(404);
    expect(svg.body.error).toMatchObject({
      code: 'not_found',
      message: t('artifact.noThumbnail'),
    });

    const anonymous = await ctx.request(`/api/v1/artifacts/${withCover.artifact.id}/thumbnail`);
    expect(anonymous.status).toBe(401);
  });

  test('a thumbnail whose bytes are not the image its name claims is never served', async () => {
    const disguised = {
      'fake.png': '<!doctype html><script>alert(document.cookie)</script>',
      'fake.gif': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      'empty.jpg': '',
      'short.webp': 'RIFF',
    };
    for (const [name, bytes] of Object.entries(disguised)) {
      const { artifact } = await publishFiles(ctx, member.user, {
        'index.html': `<img src="${name}">`,
        [name]: bytes,
      });
      const r = await api.get<ErrorJson>(`/artifacts/${artifact.id}/thumbnail`);
      expect(r.status, name).toBe(404);
      expect(r.body.error.message, name).toBe(t('artifact.noThumbnail'));
    }
  });

  test('the thumbnail follows the current version and the artifact', async () => {
    const first = png();
    const { artifact, version } = await publishFiles(ctx, member.user, {
      'index.html': '<img src="a.png">',
      'a.png': first,
    });
    await publishFiles(
      ctx,
      member.user,
      { 'index.html': '<p>no image</p>' },
      { kind: 'new_version', artifactId: artifact.id, expectedVersionId: version.id },
    );
    expect((await api.get(`/artifacts/${artifact.id}/thumbnail`)).status).toBe(404);
    expect((await api.get('/artifacts/art_unknown/thumbnail')).status).toBe(404);

    await ctx.deps.db.db.deleteFrom('artifacts').where('id', '=', artifact.id).execute();
    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'artifact', key: artifact.id, expiresAt: null }],
      clock.now(),
    );
    const gone = await api.get<ErrorJson>(`/artifacts/${artifact.id}/thumbnail`);
    expect(gone.status).toBe(410);
    expect(gone.body.error.message).toBe(t('artifact.gone'));
  });

  test('a thumbnail whose stored bytes are lost is a server error, not a missing image', async () => {
    const cover = png();
    const { artifact } = await publishFiles(ctx, member.user, {
      'index.html': '<img src="cover.png">',
      'cover.png': cover,
    });
    await ctx.deps.blobs.delete(createHash('sha256').update(cover).digest('hex'));
    const r = await api.get<ErrorJson>(`/artifacts/${artifact.id}/thumbnail`);
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('internal');
  });
});
