import { createHash } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, onTestFinished, test } from 'vitest';
import { createGrant, type GrantMode } from '../../src/content/grants.ts';
import type { ContentHooks } from '../../src/content/hooks.ts';
import { CONTENT_SANDBOX_CSP } from '../../src/content/serve.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { addTombstones } from '../../src/domain/tombstones.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { CONTENT_ENV, fetchContent, withContentHooks } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 11);

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Serves `ctx.app` on an ephemeral loopback port, closed when the test finishes. */
async function listen(ctx: TestContext): Promise<number> {
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: ctx.app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    ) as Server;
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

/** A request over a real socket with the given `Host` and request target, sent as written. */
function rawRequest(
  port: number,
  host: string,
  target: string,
  o: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: target,
        method: o.method ?? 'GET',
        headers: { ...o.headers, host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A GET over a real socket with the given `Host` and request target, sent as written. */
async function rawGet(
  port: number,
  host: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; type: string; body: string; frameOptions: string | undefined }> {
  const r = await rawRequest(port, host, target, { headers });
  return {
    status: r.status,
    type: r.headers['content-type'] ?? '',
    body: r.body,
    frameOptions: r.headers['x-frame-options'] as string | undefined,
  };
}

/** A PNG signature followed by bytes that differ per call site. */
const png = (seed: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);

describe.each([
  ['single-domain', {}],
  ['content-domain', CONTENT_ENV],
] as const)('content serving in %s mode', (mode, env) => {
  const single = mode === 'single-domain';
  let ctx: TestContext;
  let clock: FixedClock;
  let owner: UserRow;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ env: { ...env }, clock });
    owner = (await createSignedInUser(ctx)).user;
  });
  afterEach(() => ctx.close());

  /** Publishes `files` as a new artifact and returns a fresh grant on its version. */
  async function grantFor(files: Record<string, string | Buffer>, grantMode: GrantMode = 'raw') {
    const { version } = await publishFiles(ctx, owner, files);
    const grant = await createGrant(ctx.deps, {
      versionId: version.id,
      mode: grantMode,
      user: owner,
    });
    return { token: grant.token, version };
  }

  const get = (token: string, path: string, headers: Record<string, string> = {}) =>
    fetchContent(ctx, token, path, { headers });

  /** The headers every content response carries, and none of the app's. */
  function expectContentHeaders(r: Response): void {
    // Success keeps the spec header; an error page is never cached.
    expect(r.headers.get('cache-control')).toBe(
      r.status >= 400 ? 'no-store, no-transform' : 'private, max-age=300, no-transform',
    );
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('content-security-policy')).toBe(single ? CONTENT_SANDBOX_CSP : null);
    expect(r.headers.get('x-frame-options')).toBeNull();
    expect(r.headers.get('cross-origin-opener-policy')).toBeNull();
    expect(r.headers.get('strict-transport-security')).toBeNull();
    expect(r.headers.getSetCookie()).toEqual([]);
    // Anyone holding the URL may read it, a sandboxed page (`Origin: null`) included; nothing
    // ever lets a browser send credentials along.
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  }

  test('serves files with exactly the content headers', async () => {
    const html = '<!doctype html><title>Báo cáo</title><p>Xin chào</p>';
    const { token } = await grantFor({ 'index.html': html });
    const r = await fetchContent(ctx, token, 'index.html');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, max-age=300, no-transform');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('etag')).toBe(`"${sha256(html)}"`);
    expect(r.headers.get('content-security-policy')).toBe(
      mode === 'single-domain' ? CONTENT_SANDBOX_CSP : null,
    );
    expect(r.headers.get('x-frame-options')).toBeNull();
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(html)));
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-expose-headers')).toBe(
      'Accept-Ranges, Content-Range, ETag',
    );
    expect([...r.headers.keys()].sort()).toEqual(
      [
        'accept-ranges',
        'access-control-allow-origin',
        'access-control-expose-headers',
        'cache-control',
        'content-length',
        'content-type',
        'etag',
        'referrer-policy',
        'x-content-type-options',
        'x-request-id',
        ...(single ? ['content-security-policy'] : []),
      ].sort(),
    );
    expect(await r.text()).toBe(html);
  });

  test('error responses are never cached and successes keep the spec header', async () => {
    const video = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
    const { token } = await grantFor({ 'index.html': '<p>x</p>', 'v.mp4': video });
    const deleted = await grantFor({ 'index.html': '<p>y</p>' });
    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'content_grant', key: deleted.token, expiresAt: null }],
      clock.now(),
    );
    await ctx.deps.db.db.deleteFrom('versions').where('id', '=', deleted.version.id).execute();

    const cached = 'private, max-age=300, no-transform';
    const uncached = 'no-store, no-transform';
    const answers: [string, number, string, Response][] = [
      ['file', 200, cached, await get(token, 'index.html')],
      ['range', 206, cached, await get(token, 'v.mp4', { range: 'bytes=0-9' })],
      ['not modified', 304, cached, await get(token, 'index.html', { 'if-none-match': '*' })],
      ['not found', 404, uncached, await get(token, 'nope.html')],
      ['unknown token', 404, uncached, await get('a'.repeat(32), 'index.html')],
      ['bad range', 416, uncached, await get(token, 'v.mp4', { range: 'bytes=500-' })],
      ['method', 405, uncached, await fetchContent(ctx, token, '', { method: 'POST' })],
      ['gone', 410, uncached, await get(deleted.token, 'index.html')],
    ];
    await ctx.deps.blobs.delete(sha256('<p>x</p>'));
    answers.push(['server error', 500, uncached, await get(token, 'index.html')]);
    clock.advance(ctx.deps.config.ttl.previewMs + 1);
    answers.push(['expired', 410, uncached, await get(token, 'index.html')]);

    for (const [name, status, cacheControl, r] of answers) {
      expect(r.status, name).toBe(status);
      expect(r.headers.get('cache-control'), name).toBe(cacheControl);
    }
  });

  test('never reads or sets cookies', async () => {
    const { token } = await grantFor({ 'index.html': '<p>same for everyone</p>' });
    // A real session cookie too: a route that resolved it would refresh it or answer differently.
    const { cookie } = await createSignedInUser(ctx, { kind: 'oidc' });
    const cookies = { cookie: `${cookie}; pinwall_session=x; __Host-pinwall_session=y` };
    for (const path of ['index.html', 'missing.html', '__pinwall/nope.js']) {
      const plain = await get(token, path);
      const withCookies = await get(token, path, cookies);
      expect(withCookies.status).toBe(plain.status);
      expect(withCookies.headers.getSetCookie()).toEqual([]);
      expect(await withCookies.text()).toBe(await plain.text());
    }
    const unknown = await get('a'.repeat(32), 'index.html', cookies);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.getSetCookie()).toEqual([]);
  });

  test('the root serves the entry and directories their index', async () => {
    const solo = await grantFor({ 'report.html': '<p>report</p>' });
    expect(await (await get(solo.token, '')).text()).toBe('<p>report</p>');

    const { token } = await grantFor({
      'index.html': 'root',
      'docs/index.html': 'docs',
      'docs/index.md': '# not this one',
      'md/index.md': '# md',
      'a/b/index.html': 'ab',
      'img/x.png': png('x'),
    });
    expect(await (await get(token, '')).text()).toBe('root');
    expect(await (await get(token, 'docs/')).text()).toBe('docs');
    const md = await get(token, 'md/');
    expect(md.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await md.text()).toContain('<h1 id="md">md</h1>');
    expect(await (await get(token, 'md/?source')).text()).toBe('# md');

    const redirect = await get(token, 'docs');
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get('location')).toBe('docs/');
    expectContentHeaders(redirect);
    expect((await get(token, 'docs?x=1')).headers.get('location')).toBe('docs/?x=1');
    expect((await get(token, 'md')).headers.get('location')).toBe('md/');
    expect((await get(token, 'a/b')).headers.get('location')).toBe('b/');

    for (const path of ['img', 'img/', 'index.html/', 'nothing/']) {
      expect((await get(token, path)).status, path).toBe(404);
    }
  });

  test('a directory redirect never names a scheme', async () => {
    const { token } = await grantFor({ 'index.html': 'root', 'see:also/index.html': 'odd' });
    const r = await get(token, 'see:also');
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe('see%3Aalso/');
    expect(await (await get(token, 'see%3Aalso/')).text()).toBe('odd');
  });

  test('finds a file whatever the normalization form and percent-encoding', async () => {
    const image = png('Tài liệu');
    const pngSha = sha256(image);
    const { token } = await grantFor({ 'index.html': 'root', 'Tài liệu/ảnh 1.png': image });
    for (const form of ['NFC', 'NFD'] as const) {
      const p = 'Tài liệu/ảnh 1.png'.normalize(form).split('/').map(encodeURIComponent).join('/');
      expect((await fetchContent(ctx, token, p)).headers.get('etag')).toBe(`"${pngSha}"`);
      const lower = p.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
      expect((await fetchContent(ctx, token, lower)).headers.get('etag')).toBe(`"${pngSha}"`);
    }
    const r = await fetchContent(ctx, token, 'T%C3%A0i%20li%E1%BB%87u/%E1%BA%A3nh%201.png');
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(image);
  });

  test('a đ without decomposition is found as sent', async () => {
    const { token } = await grantFor({ 'index.html': 'root', 'đường đi.html': 'road' });
    const r = await get(token, encodeURIComponent('đường đi.html'.normalize('NFD')));
    expect(await r.text()).toBe('road');
  });

  test('dot segments and encoded slashes do not escape the version', async () => {
    const { token } = await grantFor({ 'index.html': 'root', 'a/b.html': 'b' });
    for (const path of [
      '../x',
      '%2e%2e/x',
      'a/../../x',
      'a%2F..%2F..%2Fx',
      'a%2Fb.html',
      'a%5Cb',
      'a%5Cb.html',
      'a%00b',
      'a/b.html%00',
      '%E0%A4%A',
      '%ED%A0%80',
    ]) {
      const r = await get(token, path);
      expect(r.status, path).toBe(404);
      expectContentHeaders(r);
    }
    expect(await (await get(token, 'a/b.html')).text()).toBe('b');
  });

  test('range requests for video', async () => {
    const video = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7) % 256));
    const etag = `"${sha256(video)}"`;
    const { token } = await grantFor({ 'index.html': 'root', 'v.mp4': video });
    const range = (value: string, extra: Record<string, string> = {}) =>
      get(token, 'v.mp4', { range: value, ...extra });
    const bytes = async (r: Response) => Buffer.from(await r.arrayBuffer());

    const first = await range('bytes=0-99');
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(first.headers.get('content-length')).toBe('100');
    expect(first.headers.get('content-type')).toBe('video/mp4');
    expect(first.headers.get('etag')).toBe(etag);
    expect(first.headers.get('accept-ranges')).toBe('bytes');
    expectContentHeaders(first);
    expect(await bytes(first)).toEqual(video.subarray(0, 100));

    const tail = await range('bytes=900-');
    expect(tail.headers.get('content-range')).toBe('bytes 900-999/1000');
    expect(await bytes(tail)).toEqual(video.subarray(900));
    const suffix = await range('bytes=-10');
    expect(suffix.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(await bytes(suffix)).toEqual(video.subarray(990));
    const clamped = await range('bytes=995-5000');
    expect(clamped.headers.get('content-range')).toBe('bytes 995-999/1000');
    expect(await bytes(clamped)).toEqual(video.subarray(995));

    for (const unsatisfiable of ['bytes=2000-', 'bytes=1000-1001', 'bytes=-0']) {
      const r = await range(unsatisfiable);
      expect(r.status, unsatisfiable).toBe(416);
      expect(r.headers.get('content-range')).toBe('bytes */1000');
      expectContentHeaders(r);
    }

    for (const ignored of ['bytes=0-1,5-6', 'bytes=5-1', 'items=0-1', 'bytes=x-y', 'bytes=-']) {
      const r = await range(ignored);
      expect(r.status, ignored).toBe(200);
      expect(r.headers.get('content-length')).toBe('1000');
      expect(r.headers.get('accept-ranges')).toBe('bytes');
      expect(await bytes(r)).toEqual(video);
    }

    const stale = await range('bytes=0-99', { 'if-range': '"other"' });
    expect(stale.status).toBe(200);
    expect(await bytes(stale)).toEqual(video);
    const current = await range('bytes=0-99', { 'if-range': etag });
    expect(current.status).toBe(206);
    expect(await bytes(current)).toEqual(video.subarray(0, 100));
  });

  test('If-None-Match answers 304', async () => {
    const css = 'body { color: teal }';
    const etag = `"${sha256(css)}"`;
    const { token } = await grantFor({ 'index.html': 'root', 'site.css': css });
    for (const value of [etag, `W/${etag}`, `"nope", ${etag}`, '*']) {
      const r = await get(token, 'site.css', { 'if-none-match': value });
      expect(r.status, value).toBe(304);
      expect(r.headers.get('etag')).toBe(etag);
      expectContentHeaders(r);
      expect(await r.text()).toBe('');
    }
    const changed = await get(token, 'site.css', { 'if-none-match': '"nope"' });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe(css);
  });

  test('HEAD returns headers only', async () => {
    const html = '<p>head</p>';
    const { token } = await grantFor({ 'index.html': html });
    const r = await fetchContent(ctx, token, 'index.html', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(html.length));
    expect(r.headers.get('etag')).toBe(`"${sha256(html)}"`);
    expectContentHeaders(r);
    expect(await r.text()).toBe('');

    const partial = await fetchContent(ctx, token, 'index.html', {
      method: 'HEAD',
      headers: { range: 'bytes=0-1' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-length')).toBe('2');
    expect(await partial.text()).toBe('');
  });

  test('only GET and HEAD are served', async () => {
    const { token } = await grantFor({ 'index.html': '<p>x</p>' });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const tok of [token, 'a'.repeat(32)]) {
        const r = await fetchContent(ctx, tok, 'index.html', { method });
        expect(r.status, method).toBe(405);
        expect(r.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
        expectContentHeaders(r);
      }
    }
  });

  test('a sandboxed page can load its own scripts, fonts and data across origins', async () => {
    const { token } = await grantFor({
      'index.html': '<script type="module" src="app.js"></script>',
      'app.js': 'export const x = 1;',
      'fonts/body.woff2': Buffer.from('wOF2-font'),
      'data.json': '{"rows":[]}',
    });
    const port = await listen(ctx);
    const host = single ? 'localhost:8080' : `${token}.pw-content.test`;
    const at = (path: string) => (single ? `/c/${token}/${path}` : `/${path}`);
    // What a document without allow-same-origin sends for its own files: an opaque origin.
    const opaque = { origin: 'null', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' };

    for (const [path, dest, body] of [
      ['app.js', 'script', 'export const x = 1;'],
      ['fonts/body.woff2', 'font', 'wOF2-font'],
      ['data.json', 'empty', '{"rows":[]}'],
    ] as const) {
      const r = await rawRequest(port, host, at(path), {
        headers: { ...opaque, 'sec-fetch-dest': dest },
      });
      expect(r.status, path).toBe(200);
      expect(r.body, path).toBe(body);
      expect(r.headers['access-control-allow-origin'], path).toBe('*');
      expect(r.headers['access-control-allow-credentials'], path).toBeUndefined();
      expect(r.headers['access-control-expose-headers'], path).toBe(
        'Accept-Ranges, Content-Range, ETag',
      );
    }

    // A fetch with a Range or a header of its own is preflighted; the preflight needs no grant
    // lookup and allows reading only.
    for (const tok of [token, 'a'.repeat(32)]) {
      const target = single ? `/c/${tok}/data.json` : '/data.json';
      const preflight = await rawRequest(port, single ? host : `${tok}.pw-content.test`, target, {
        method: 'OPTIONS',
        headers: {
          ...opaque,
          'sec-fetch-dest': 'empty',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'range,x-requested-with',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.body).toBe('');
      expect(preflight.headers).toMatchObject({
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD',
        'access-control-allow-headers': 'range,x-requested-with',
        allow: 'GET, HEAD, OPTIONS',
        vary: 'Access-Control-Request-Headers',
        'cache-control': 'private, max-age=300, no-transform',
        'x-content-type-options': 'nosniff',
      });
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
      expect(preflight.headers['set-cookie']).toBeUndefined();
      expect(preflight.headers['content-security-policy']).toBe(
        single ? CONTENT_SANDBOX_CSP : undefined,
      );
    }

    // Only a plain list of header names is echoed back.
    const odd = await rawRequest(port, host, at('data.json'), {
      method: 'OPTIONS',
      headers: {
        ...opaque,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'range, <x>',
      },
    });
    expect(odd.status).toBe(204);
    expect(odd.headers['access-control-allow-headers']).toBeUndefined();
  });

  test('missing files get a 404 page with content headers', async () => {
    const { token } = await grantFor({ 'index.html': '<p>x</p>' });
    const r = await get(token, 'nope.html', { accept: 'text/html' });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expectContentHeaders(r);
    const body = await r.text();
    expect(body).toContain(t('content.notFound.title'));
    expect(body).toContain(t('content.notFound.message'));
    // Self-contained: nothing for the sandboxed page to load.
    expect(body).not.toMatch(/<(link|script|img)\b|src=|href=/i);
  });

  test('expired grants are gone', async () => {
    const { token } = await grantFor({ 'index.html': '<p>x</p>' });
    clock.advance(ctx.deps.config.ttl.previewMs + 1);
    for (const path of ['', 'index.html', 'nope.html', '__pinwall/x.js']) {
      const r = await get(token, path);
      expect(r.status, path).toBe(410);
      expectContentHeaders(r);
      expect(await r.text()).toContain(t('content.expired.title'));
    }
  });

  test('grants of deleted versions are gone', async () => {
    const { token, version } = await grantFor({ 'index.html': '<p>x</p>' });
    await addTombstones(
      ctx.deps.db.db,
      [{ kind: 'content_grant', key: token, expiresAt: null }],
      clock.now(),
    );
    await ctx.deps.db.db.deleteFrom('versions').where('id', '=', version.id).execute();
    const r = await get(token, 'index.html');
    expect(r.status).toBe(410);
    expectContentHeaders(r);
    expect(await r.text()).toContain(t('content.gone.title'));
  });

  test('unknown tokens are not found', async () => {
    for (const token of ['a'.repeat(32), 'nottoken', 'A'.repeat(32)]) {
      const r = await get(token, 'index.html');
      expect(r.status, token).toBe(404);
      expectContentHeaders(r);
      expect(await r.text()).toContain(t('content.notFound.title'));
    }
  });

  test('unexpected errors answer the content error page', async () => {
    const html = '<p>lost</p>';
    const { token } = await grantFor({ 'index.html': html });
    await ctx.deps.blobs.delete(sha256(html));
    const r = await get(token, 'index.html', { accept: 'text/html' });
    expect(r.status).toBe(500);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expectContentHeaders(r);
    const body = await r.text();
    expect(body).toContain(t('content.error.title'));
    expect(body).not.toContain('Blob');
  });

  test('isolation: content never under app routes, app never on content hosts', async () => {
    const { token } = await grantFor({ 'index.html': '<p>artifact</p>' });
    const isJson = (r: Response) => r.headers.get('content-type')?.startsWith('application/json');
    const isAppResponse = (r: Response) =>
      r.headers.get('content-security-policy')?.includes("frame-ancestors 'none'") === true &&
      r.headers.get('x-frame-options') === 'DENY';

    if (single) {
      // The grant root without its slash redirects to it, once the grant is known to be good.
      const root = await ctx.request(`/c/${token}`);
      expect(root.status).toBe(308);
      expect(root.headers.get('location')).toBe(`${token}/`);
      expectContentHeaders(root);
      expect((await ctx.request(`/c/${token}?a=1`)).headers.get('location')).toBe(`${token}/?a=1`);
      for (const path of [`/c/${'a'.repeat(32)}`, '/c/', '/c']) {
        const r = await ctx.request(path);
        expect(r.status, path).toBe(404);
        expectContentHeaders(r);
      }
      // App paths inside a grant are files of the artifact, never the app.
      const api = await fetchContent(ctx, token, 'api/v1/config/public');
      expect(api.status).toBe(404);
      expect(isJson(api)).toBe(false);
      expectContentHeaders(api);
      // A content-host name means nothing in single-domain mode: it is an app request.
      const host = await ctx.app.request(`https://${token}.pw-content.test/api/v1/config/public`);
      expect(host.status).toBe(200);
      expect(isJson(host)).toBe(true);
      expect(isAppResponse(host)).toBe(true);
      const hostRoot = await ctx.app.request(`https://${token}.pw-content.test/`);
      expect(hostRoot.headers.get('cache-control')).not.toBe('private, max-age=300, no-transform');
      expect(isAppResponse(hostRoot)).toBe(true);
    } else {
      // The app host never serves content, with or without the token.
      for (const url of [
        `http://localhost/c/${token}/`,
        `https://pinwall.test/c/${token}/index.html`,
        `https://pinwall.test/c/${token}`,
      ]) {
        const r = await ctx.app.request(url, { headers: { accept: 'text/html' } });
        expect(r.status, url).toBe(404);
        expect(await r.text()).toContain(t('error.notFound.title'));
        expect(isAppResponse(r)).toBe(true);
      }
      // Content hosts never serve the app.
      const api = await ctx.app.request(`https://${token}.pw-content.test/api/v1/config/public`);
      expect(api.status).toBe(404);
      expect(isJson(api)).toBe(false);
      expect(await api.text()).toContain(t('content.notFound.title'));
      expectContentHeaders(api);
      for (const url of [
        'https://pw-content.test/',
        'https://pw-content.test/api/v1/config/public',
        'https://nottoken.pw-content.test/',
        `https://a.${token}.pw-content.test/`,
        `https://${'a'.repeat(32)}.pw-content.test/healthz`,
      ]) {
        const r = await ctx.app.request(url);
        expect(r.status, url).toBe(404);
        expect(isJson(r)).toBe(false);
        expectContentHeaders(r);
      }
      // Host names compare without case and without a trailing dot.
      const upper = await ctx.app.request(`https://${token.toUpperCase()}.PW-CONTENT.TEST/`);
      expect(await upper.text()).toBe('<p>artifact</p>');
      const dotted = await ctx.app.request(`https://${token}.pw-content.test./`);
      expect(await dotted.text()).toBe('<p>artifact</p>');
      // Only the Host counts, never X-Forwarded-Host.
      const forwarded = await ctx.app.request('https://pinwall.test/api/v1/config/public', {
        headers: { 'x-forwarded-host': `${token}.pw-content.test` },
      });
      expect(isJson(forwarded)).toBe(true);
      expect(isAppResponse(forwarded)).toBe(true);
      const forwardedBack = await ctx.app.request(`https://${token}.pw-content.test/`, {
        headers: { 'x-forwarded-host': 'pinwall.test' },
      });
      expect(await forwardedBack.text()).toBe('<p>artifact</p>');
    }
  });

  test('over a real socket, the Host header alone picks content or app', async () => {
    const { token } = await grantFor({ 'index.html': '<p>artifact</p>' });
    const port = await listen(ctx);
    const contentHost = `${token}.pw-content.test`;
    if (single) {
      const page = await rawGet(port, contentHost, `/c/${token}/index.html`);
      expect(page.body).toBe('<p>artifact</p>');
      for (const target of [`/c/${token}/a%2F..%2F..%2Findex.html`, `/c/${token}/%2e%2e/x`]) {
        expect((await rawGet(port, 'localhost:8080', target)).status, target).toBe(404);
      }
      return;
    }
    const page = await rawGet(port, contentHost, '/index.html');
    expect(page.body).toBe('<p>artifact</p>');
    expect(page.frameOptions).toBeUndefined();
    // The port in Host does not matter; the name does.
    expect((await rawGet(port, `${contentHost}:8443`, '/')).body).toBe('<p>artifact</p>');
    const api = await rawGet(port, contentHost, '/api/v1/config/public');
    expect([api.status, api.type]).toEqual([404, 'text/html; charset=utf-8']);
    const app = await rawGet(port, 'pinwall.test', '/api/v1/config/public');
    expect([app.status, app.type, app.frameOptions]).toEqual([200, 'application/json', 'DENY']);
    const forwarded = await rawGet(port, 'pinwall.test', '/api/v1/config/public', {
      'x-forwarded-host': contentHost,
    });
    expect(forwarded.type).toBe('application/json');
    const appPath = await rawGet(port, 'pinwall.test', `/c/${token}/index.html`);
    expect(appPath.status).toBe(404);
    expect(appPath.body).not.toContain('<p>artifact</p>');
  });

  test('reserved __pinwall paths come only from hooks', async () => {
    const { token } = await grantFor({ 'index.html': '<p>x</p>' });
    expect((await get(token, '__pinwall/nope.js')).status).toBe(404);
    expect((await get(token, '__pinwall/x.js')).status).toBe(404);

    const hooked = withContentHooks(ctx, {
      reservedAssets: {
        'x.js': { contentType: 'text/javascript; charset=utf-8', body: () => Buffer.from('1') },
      },
    });
    const r = await fetchContent(hooked, token, '__pinwall/x.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expectContentHeaders(r);
    expect(await r.text()).toBe('1');
    for (const path of ['__pinwall/nope.js', '__pinwall/constructor', '__pinwall/', '__pinwall']) {
      expect((await fetchContent(hooked, token, path)).status, path).toBe(404);
    }
    // A reserved asset still needs a good grant.
    expect((await fetchContent(hooked, 'a'.repeat(32), '__pinwall/x.js')).status).toBe(404);
  });

  test('review grants pass through the transform hook; raw grants never do', async () => {
    const html = '<!doctype html><p>page</p>';
    const css = 'p { margin: 0 }';
    const files = { 'index.html': html, 'site.css': css };
    const seen: { path: string; baseUrl: string; mode: string }[] = [];
    const hooks: ContentHooks = {
      transformReviewHtml: (body, c) => {
        seen.push({ path: c.path, baseUrl: c.baseUrl, mode: c.grant.mode });
        return Buffer.concat([body, Buffer.from('<!--t-->')]);
      },
    };
    const hooked = withContentHooks(ctx, hooks);
    const review = await grantFor(files, 'review');
    const raw = await grantFor(files, 'raw');

    const r = await fetchContent(hooked, review.token, 'index.html', {
      headers: { range: 'bytes=0-3' },
    });
    expect(r.status).toBe(200);
    const transformed = `${html}<!--t-->`;
    expect(r.headers.get('etag')).toBe(`"${sha256(transformed)}"`);
    expect(r.headers.get('content-length')).toBe(String(transformed.length));
    expect(r.headers.get('accept-ranges')).toBeNull();
    expectContentHeaders(r);
    expect(await r.text()).toBe(transformed);
    const base = single
      ? `http://localhost:8080/c/${review.token}/`
      : `https://${review.token}.pw-content.test/`;
    expect(seen).toEqual([{ path: 'index.html', baseUrl: base, mode: 'review' }]);

    // The root is the entry, transformed the same way; its own ETag answers 304.
    const root = await fetchContent(hooked, review.token, '');
    expect(await root.text()).toBe(transformed);
    const again = await fetchContent(hooked, review.token, '', {
      headers: { 'if-none-match': `"${sha256(transformed)}"` },
    });
    expect(again.status).toBe(304);
    const stale = await fetchContent(hooked, review.token, '', {
      headers: { 'if-none-match': `"${sha256(html)}"` },
    });
    expect(stale.status).toBe(200);

    const reviewCss = await fetchContent(hooked, review.token, 'site.css');
    expect(await reviewCss.text()).toBe(css);
    expect(reviewCss.headers.get('etag')).toBe(`"${sha256(css)}"`);

    const rawHtml = await fetchContent(hooked, raw.token, 'index.html');
    expect(await rawHtml.text()).toBe(html);
    expect(rawHtml.headers.get('etag')).toBe(`"${sha256(html)}"`);
    // Four review HTML requests went through the hook; the CSS and the raw grant never did.
    expect(seen).toHaveLength(4);
  });
});
