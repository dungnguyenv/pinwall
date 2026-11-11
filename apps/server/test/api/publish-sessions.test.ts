import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { PublishResult, PublishSession } from '@pinwall/shared';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AppEnv } from '../../src/app.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { errorHandler } from '../../src/http/errors.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import { type UploadReceipt, uploadCommands } from '../../src/publish/sessions.ts';
import { mountUploadRoute, withIdleTimeout } from '../../src/publish/upload-route.ts';
import { makeTar } from '../helpers/archives.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const T = Date.UTC(2026, 10, 11);
const URL_PATTERN = /^http:\/\/localhost:8080\/upload\/[A-Za-z0-9_-]{43}$/;

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** A small site as `tar -czf - -C ./site .` makes it. */
const site = (title = 'Hi') =>
  makeTar(
    [
      { name: './', type: 'directory' },
      { name: './index.html', body: `<title>${title}</title><p>x</p>` },
      { name: './a.css', body: 'p{}' },
    ],
    { gzip: true },
  );

/** The path of an upload URL, for requests over a socket. */
const pathOf = (url: string) => new URL(url).pathname;

/** Serves `app` on an ephemeral port of the loopback interface. */
async function listen(app: Hono<AppEnv>): Promise<{ port: number; close(): Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    ) as Server;
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface SocketReply {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
}

/**
 * POSTs to `path` with `node:http`, as curl does: the body goes out in `chunks` (chunked unless a
 * Content-Length is given), after `100 Continue` when `Expect` asks for it. `stall` sends the
 * chunks and then neither ends nor closes the request. Resolves once the whole response body
 * has arrived; a reset after that does not matter, one before it fails the call.
 */
function socketPost(
  port: number,
  path: string,
  o: { headers: Record<string, string>; chunks: Buffer[]; gapMs?: number; stall?: boolean },
): Promise<SocketReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: o.headers });
    let answered = false;
    req.on('response', (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () => {
        answered = true;
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json: JSON.parse(text) });
        req.destroy();
      });
      res.on('error', reject);
    });
    req.on('error', (error) => {
      if (!answered) reject(error);
    });
    const send = async () => {
      for (const chunk of o.chunks) {
        if (req.destroyed) return;
        req.write(chunk);
        if (o.gapMs) await new Promise((r) => setTimeout(r, o.gapMs));
      }
      if (!o.stall && !req.destroyed) req.end();
    };
    if (o.headers.expect === '100-continue') req.on('continue', () => void send());
    else void send();
  });
}

/** `buf` cut into `n` chunks of about the same size. */
function split(buf: Buffer, n: number): Buffer[] {
  const size = Math.ceil(buf.length / n);
  const chunks: Buffer[] = [];
  for (let start = 0; start < buf.length; start += size) {
    chunks.push(buf.subarray(start, start + size));
  }
  return chunks;
}

/** curl's headers for `--data-binary @-`. */
const CURL_HEADERS = {
  'content-type': 'application/x-www-form-urlencoded',
  'transfer-encoding': 'chunked',
  expect: '100-continue',
};

describe.each(dialects)('publish sessions on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let member: { user: UserRow; cookie: string };
  afterEach(() => ctx.close());

  async function start(env: Record<string, string> = {}): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    member = await createSignedInUser(ctx, { kind: 'oidc', name: 'Linh' });
  }

  const create = (body: unknown, o: { cookie?: string; bearer?: string } = {}) =>
    ctx.request(
      '/api/v1/publish-sessions',
      apiInit(
        ctx,
        o.bearer === undefined ? { cookie: o.cookie ?? member.cookie, body } : { ...o, body },
      ),
    );

  async function newSession(body: unknown = { target: {} }): Promise<PublishSession> {
    const r = await create(body);
    expect(r.status, await r.clone().text()).toBe(201);
    return PublishSession.parse(await r.json());
  }

  const put = (url: string, buf: Buffer | ReadableStream, headers?: Record<string, string>) =>
    ctx.app.request(url, {
      method: 'POST',
      body: buf,
      headers,
      ...(buf instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);

  const errorOf = async (r: Response) => ((await r.json()) as ErrorJson).error;
  const versions = () => ctx.deps.db.db.selectFrom('versions').selectAll().execute();

  async function storedBlobs(): Promise<string[]> {
    const keys: string[] = [];
    for await (const key of ctx.deps.blobs.list()) keys.push(key);
    return keys;
  }

  test('a publish session returns a one-time URL and ready commands', async () => {
    await start();
    const r = await create({ target: {} });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const s = PublishSession.parse(await r.json());
    expect(s.upload_url).toMatch(URL_PATTERN);
    expect(s.expires_at).toBe(clock.now() + 600_000);
    expect(s.max_upload_bytes).toBe(95_000_000);
    expect(s.commands.archive).toBe(
      `tar -czf - -C ./site . | curl --fail-with-body --data-binary @- "${s.upload_url}"`,
    );
    expect(s.commands.single_file).toBe(
      `curl --fail-with-body -H 'Content-Type: text/html' --data-binary @./index.html "${s.upload_url}"`,
    );
    // Only a hash of the token is kept.
    const token = s.upload_url.slice(s.upload_url.lastIndexOf('/') + 1);
    expect(await ctx.deps.oneTime.peek(`upload:${token}`)).toBeNull();
    expect(await ctx.deps.oneTime.peek(`upload:${hashSecret(token)}`)).not.toBeNull();
  });

  test('commands follow the given directory or file', async () => {
    await start();
    const dir = await newSession({ target: {}, directory: 'my site' });
    expect(dir.commands.archive).toBe(
      `tar -czf - -C 'my site' . | curl --fail-with-body --data-binary @- "${dir.upload_url}"`,
    );
    const md = await newSession({ target: {}, file: 'notes/plan.md' });
    expect(md.commands.single_file).toBe(
      `curl --fail-with-body -H 'Content-Type: text/markdown' --data-binary @notes/plan.md "${md.upload_url}"`,
    );
    const pdf = await newSession({ target: {}, file: 'deck.pdf' });
    expect(pdf.commands.single_file).toBe(
      `curl --fail-with-body --data-binary @deck.pdf "${pdf.upload_url}?filename=deck.pdf"`,
    );
    const quote = await newSession({ target: {}, file: "it's.html" });
    expect(quote.commands.single_file).toBe(
      `curl --fail-with-body -H 'Content-Type: text/html' --data-binary @'it'\\''s.html' "${quote.upload_url}"`,
    );
  });

  test('a file name is encoded so no shell acts on it inside the quotes', () => {
    const url = 'http://localhost:8080/upload/x';
    expect(uploadCommands(url, { file: 'out/Báo cáo (v2)!.pdf' }).single_file).toBe(
      `curl --fail-with-body --data-binary @'out/Báo cáo (v2)!.pdf' "${url}?filename=B%C3%A1o%20c%C3%A1o%20%28v2%29%21.pdf"`,
    );
    expect(uploadCommands(url, { file: 'INDEX.HTM' }).single_file).toContain('text/html');
    expect(uploadCommands(url, { directory: '$HOME/site' }).archive).toContain("-C '$HOME/site' .");
  });

  test('path hints with control characters are refused', async () => {
    await start();
    const r = await create({ target: {}, file: 'a\nb.html' });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toMatchObject({
      code: 'bad_request',
      details: { issues: [{ path: 'file' }] },
    });
  });

  test('an upload publishes and returns links', async () => {
    await start();
    const s = await newSession({ target: {}, message: 'First cut' });
    const r = await put(s.upload_url, await site());
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = PublishResult.parse(await r.json());
    const id = body.artifact_id;
    expect(body).toEqual({
      artifact_id: expect.stringMatching(/^art_/),
      version_id: expect.stringMatching(/^ver_/),
      version_number: 1,
      kind: 'html',
      entry_path: 'index.html',
      file_count: 2,
      total_bytes: expect.any(Number),
      review_url: `http://localhost:8080/a/${id}`,
      raw_url: `http://localhost:8080/a/${id}/v/1/raw`,
      warnings: [],
    });
    expect(await versions()).toEqual([
      expect.objectContaining({
        id: body.version_id,
        source: 'api',
        message: 'First cut',
        created_by: member.user.id,
      }),
    ]);
  });

  test('a single file goes by its content type or ?filename=', async () => {
    await start();
    const md = await newSession();
    const r1 = await put(md.upload_url, Buffer.from('# Plan'), { 'content-type': 'text/markdown' });
    expect(await r1.json()).toMatchObject({ kind: 'markdown', entry_path: 'index.md' });

    const pdf = await newSession();
    const r2 = await put(`${pdf.upload_url}?filename=deck%20v2.pdf`, Buffer.from('%PDF-1.7'));
    expect(r2.status).toBe(201);
    expect(await r2.json()).toMatchObject({ entry_path: 'deck v2.pdf', file_count: 1 });
  });

  test('a retried upload names the version it created', async () => {
    await start();
    const s = await newSession();
    const tgz = await site();
    const r1 = await put(s.upload_url, tgz);
    expect(r1.status).toBe(201);
    const { artifact_id: id, version_id: vid } = PublishResult.parse(await r1.json());

    const r2 = await put(s.upload_url, tgz);
    expect(r2.status).toBe(409);
    const error = await errorOf(r2);
    expect(error).toMatchObject({
      code: 'upload_session_used',
      details: {
        artifact_id: id,
        version_id: vid,
        version_number: 1,
        review_url: `http://localhost:8080/a/${id}`,
      },
    });
    expect(error.message).toBe(t('publish.session.used', { number: 1 }));
    // Still the answer long after the session would have expired.
    clock.advance(3_600_000);
    expect((await errorOf(await put(s.upload_url, tgz))).code).toBe('upload_session_used');
    expect(await versions()).toHaveLength(1);
  });

  test('an expired session says how to get a new one', async () => {
    await start();
    const s = await newSession();
    clock.advance(600_001);
    const r = await put(s.upload_url, await site());
    expect(r.status).toBe(410);
    const error = await errorOf(r);
    expect(error).toMatchObject({
      code: 'upload_session_expired',
      details: { expired_at: s.expires_at },
    });
    expect(error.message).toContain('create_publish_session');
    expect(error.message).toContain('/api/v1/publish-sessions');
    expect(await versions()).toEqual([]);
  });

  test('an unknown upload URL is not_found', async () => {
    await start();
    // A browser asking for HTML still gets JSON here.
    const r = await put('http://localhost:8080/upload/not-a-real-token', await site(), {
      accept: 'text/html',
    });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await errorOf(r)).toEqual({
      code: 'not_found',
      message: t('publish.session.unknown'),
    });
  });

  test('a rejected upload leaves the session usable until it expires', async () => {
    await start();
    const s = await newSession();
    const bad = await makeTar([{ name: '../x', body: 'x' }], { gzip: true });
    const r1 = await put(s.upload_url, bad);
    expect(r1.status).toBe(400);
    expect(await errorOf(r1)).toMatchObject({ details: { reason: 'dot_segment' } });

    clock.advance(300_000);
    const r2 = await put(s.upload_url, await site());
    expect(r2.status).toBe(201);
    expect(await versions()).toHaveLength(1);
  });

  test('a rejection after the session expired does not revive it', async () => {
    await start();
    const s = await newSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bad = await makeTar([{ name: '../x', body: 'x' }]);
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bad.subarray(0, 100));
        await gate;
        controller.enqueue(bad.subarray(100));
        controller.close();
      },
    });
    const first = put(s.upload_url, slow);
    await vi.waitFor(async () => {
      const receipt = await ctx.deps.oneTime.peek<UploadReceipt>(
        `upload-receipt:${hashSecret(s.upload_url.split('/').pop() ?? '')}`,
      );
      expect(receipt?.state).toBe('running');
    });
    clock.advance(600_001);
    release();
    expect((await first).status).toBe(400);
    const r = await put(s.upload_url, await site());
    expect(r.status).toBe(410);
    expect((await errorOf(r)).code).toBe('upload_session_expired');
  });

  test('an upload in progress refuses a second one', async () => {
    await start();
    const s = await newSession();
    const tgz = await site();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(tgz.subarray(0, 20));
        await gate;
        controller.enqueue(tgz.subarray(20));
        controller.close();
      },
    });
    const first = put(s.upload_url, slow);
    const token = s.upload_url.slice(s.upload_url.lastIndexOf('/') + 1);
    await vi.waitFor(async () => {
      const receipt = await ctx.deps.oneTime.peek<UploadReceipt>(
        `upload-receipt:${hashSecret(token)}`,
      );
      expect(receipt?.state).toBe('running');
    });

    const r2 = await put(s.upload_url, tgz);
    expect(r2.status).toBe(409);
    expect(await errorOf(r2)).toEqual({
      code: 'upload_session_used',
      message: t('publish.session.running'),
      details: { in_progress: true },
    });
    // Past expiry, a running upload is still reported as running, not as expired.
    clock.advance(600_001);
    expect(await errorOf(await put(s.upload_url, tgz))).toMatchObject({
      details: { in_progress: true },
    });

    release();
    expect((await first).status).toBe(201);
    expect(await versions()).toHaveLength(1);
  });

  test('a stale target fails at session creation', async () => {
    await start();
    const v1 = await publishFiles(ctx, member.user, { 'index.html': '<p>1</p>' });
    const artifact_id = v1.artifact.id;
    const v2 = await publishFiles(
      ctx,
      member.user,
      { 'index.html': '<p>2</p>' },
      { kind: 'new_version', artifactId: artifact_id, expectedVersionId: v1.version.id },
    );

    const stale = await create({ target: { artifact_id, expected_version_id: v1.version.id } });
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toMatchObject({
      code: 'version_conflict',
      details: { current_version_id: v2.version.id, current_version_number: 2 },
    });

    const missing = await create({
      target: { artifact_id: 'art_00000000000000000000', expected_version_id: 'ver_x' },
    });
    expect(missing.status).toBe(404);

    const current = await newSession({
      target: { artifact_id, expected_version_id: v2.version.id },
    });
    const r = await put(current.upload_url, await site('Three'));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ artifact_id, version_number: 3 });
  });

  test('a target must be one of the two shapes', async () => {
    await start();
    for (const target of [
      { artifact_id: 'art_x' },
      { project_id: null, artifact_id: 'art_x', expected_version_id: 'ver_x' },
      { name: '' },
      { tags: ['a\ud800'] },
    ]) {
      const r = await create({ target });
      expect(r.status, JSON.stringify(target)).toBe(400);
    }
  });

  test('the documented command publishes over a real socket', async () => {
    await start();
    const s = await newSession();
    const server = await listen(ctx.app);
    try {
      const reply = await socketPost(server.port, pathOf(s.upload_url), {
        headers: CURL_HEADERS,
        chunks: split(await site(), 3),
      });
      expect(reply.status).toBe(201);
      expect(reply.json).toMatchObject({ version_number: 1, kind: 'html' });
    } finally {
      await server.close();
    }
  });

  test('an oversized streamed body is 413 without Content-Length', async () => {
    await start({ PINWALL_MAX_UPLOAD_BYTES: '10000' });
    const s = await newSession();
    const server = await listen(ctx.app);
    try {
      // Random bytes after a gzip header: still a tar.gz to the sniffer, but 20 KB of it.
      const big = Buffer.concat([await site(), Buffer.alloc(20_000, 7)]);
      const reply = await socketPost(server.port, pathOf(s.upload_url), {
        headers: CURL_HEADERS,
        chunks: split(big, 20),
      });
      expect(reply.status).toBe(413);
      expect(reply.json).toMatchObject({
        error: {
          code: 'payload_too_large',
          details: { limit: 'max_upload_bytes', max: 10000 },
        },
      });
    } finally {
      await server.close();
    }
    expect(await versions()).toEqual([]);
    expect(await storedBlobs()).toEqual([]);
  });

  test('a rejection mid-stream still reaches a client that keeps sending', async () => {
    await start({ PINWALL_MAX_UPLOAD_BYTES: '10000' });
    const s = await newSession();
    const server = await listen(ctx.app);
    try {
      // Far more than the limit, sent as fast as the socket takes it: the server stops reading
      // long before the client stops writing.
      const reply = await socketPost(server.port, pathOf(s.upload_url), {
        headers: CURL_HEADERS,
        chunks: [await site(), ...Array.from({ length: 80 }, () => Buffer.alloc(65_536, 1))],
      });
      expect(reply.status).toBe(413);
      expect(reply.json).toMatchObject({ error: { code: 'payload_too_large' } });
    } finally {
      await server.close();
    }
    // The session is still there for a corrected upload.
    expect((await put(s.upload_url, await site())).status).toBe(201);
  });

  test('a declared Content-Length over the limit is refused before reading', async () => {
    await start({ PINWALL_MAX_UPLOAD_BYTES: '10000' });
    const s = await newSession();
    const server = await listen(ctx.app);
    try {
      const reply = await socketPost(server.port, pathOf(s.upload_url), {
        headers: { 'content-type': 'application/gzip', 'content-length': '10001' },
        chunks: [Buffer.alloc(10_001)],
      });
      expect(reply.status).toBe(413);
      expect(reply.json).toMatchObject({
        error: { details: { limit: 'max_upload_bytes', max: 10000 } },
      });
    } finally {
      await server.close();
    }
    expect(await versions()).toEqual([]);
  });

  test('upload URLs ignore cookies and bearer tokens', async () => {
    await start();
    const s = await newSession();
    const r = await put(s.upload_url, await site(), {
      cookie: 'pinwall_session=junk',
      authorization: 'Bearer junk',
      origin: 'https://evil.example',
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  test('session creation needs auth and is rate limited per user', async () => {
    await start();
    const anonymous = await ctx.request(
      '/api/v1/publish-sessions',
      apiInit(ctx, { body: { target: {} } }),
    );
    expect(anonymous.status).toBe(401);

    for (let i = 0; i < 60; i += 1) {
      expect((await create({ target: {} })).status).toBe(201);
    }
    const refused = await create({ target: {} });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('600');

    // Another user, here by API token, has an allowance of their own.
    const other = await createSignedInUser(ctx, { kind: 'oidc', name: 'Minh' });
    const bearer = await createUserToken(ctx, other.user.id);
    expect((await create({ target: {} }, { bearer })).status).toBe(201);

    clock.advance(600_000);
    expect((await create({ target: {} })).status).toBe(201);
  });

  test('a session whose creator lost access cannot upload', async () => {
    await start();
    const s = await newSession();
    const setOverride = (role_override: 'blocked' | null) =>
      ctx.deps.db.db
        .updateTable('users')
        .set({ role_override })
        .where('id', '=', member.user.id)
        .execute();

    await setOverride('blocked');
    const r1 = await put(s.upload_url, await site());
    expect(r1.status).toBe(403);
    expect((await errorOf(r1)).code).toBe('access_denied');

    await setOverride(null);
    const r2 = await put(s.upload_url, await site());
    expect(r2.status).toBe(201);
    expect(await versions()).toHaveLength(1);
  });

  describe('a client that stops sending', () => {
    /** The app's upload route alone, with an idle timeout of `idleMs`. */
    function uploadApp(idleMs: number): Hono<AppEnv> {
      const app = new Hono<AppEnv>();
      app.use(async (c, next) => {
        c.set('deps', ctx.deps);
        c.set('auth', null);
        await next();
      });
      mountUploadRoute(app, { idleTimeoutMs: idleMs });
      app.onError(errorHandler);
      return app;
    }

    test('times out with 408, removes what it staged, and keeps the session', async () => {
      await start();
      const s = await newSession();
      const server = await listen(uploadApp(300));
      const stored = vi.spyOn(ctx.deps.blobs, 'put');
      try {
        // a.css arrives whole and is stored; b.bin's data never comes.
        const tar = await makeTar([
          { name: 'a.css', body: 'p{}' },
          { name: 'b.bin', body: Buffer.alloc(4096, 1) },
        ]);
        const reply = await socketPost(server.port, pathOf(s.upload_url), {
          headers: { 'content-type': 'application/x-tar', 'transfer-encoding': 'chunked' },
          chunks: [tar.subarray(0, 2048)],
          stall: true,
        });
        expect(reply.status).toBe(408);
        expect(reply.json).toEqual({
          error: {
            code: 'request_timeout',
            message: t('publish.upload.idle', { seconds: 1 }),
            details: { idle_timeout_seconds: 1 },
          },
        });
      } finally {
        await server.close();
      }
      expect(stored).toHaveBeenCalledTimes(1);
      expect(await storedBlobs()).toEqual([]);
      expect(await versions()).toEqual([]);
      expect((await put(s.upload_url, await site())).status).toBe(201);
    });

    test('a slow but steady upload is not cut off', async () => {
      await start();
      const s = await newSession();
      const server = await listen(uploadApp(300));
      try {
        const reply = await socketPost(server.port, pathOf(s.upload_url), {
          headers: CURL_HEADERS,
          chunks: split(await site(), 6),
          gapMs: 150,
        });
        expect(reply.status).toBe(201);
      } finally {
        await server.close();
      }
    });
  });
});

describe('withIdleTimeout', () => {
  const idle = () => new Error('idle');

  test('passes every byte through and ends', async () => {
    const guarded = withIdleTimeout(Readable.from([Buffer.from('ab'), Buffer.from('c')]), 50, idle);
    const parts: Buffer[] = [];
    for await (const part of guarded) parts.push(part as Buffer);
    expect(Buffer.concat(parts).toString()).toBe('abc');
  });

  test('fails when nothing arrives while the reader waits', async () => {
    const source = new Readable({ read() {} });
    source.push(Buffer.from('a'));
    const guarded = withIdleTimeout(source, 50, idle);
    const read = (async () => {
      for await (const _ of guarded) {
        // keep waiting
      }
    })();
    await expect(read).rejects.toThrow('idle');
    expect(source.destroyed).toBe(true);
  });

  test('time the reader spends on what it has does not count', async () => {
    const chunks = Array.from({ length: 64 }, () => Buffer.alloc(16_384, 1));
    const guarded = withIdleTimeout(Readable.from(chunks), 50, idle);
    let total = 0;
    for await (const part of guarded) {
      total += (part as Buffer).length;
      // A slow store: far longer than the idle timeout per chunk.
      if (total === 16_384) await new Promise((r) => setTimeout(r, 200));
    }
    expect(total).toBe(64 * 16_384);
  });

  test('destroying it destroys the source', () => {
    const source = new Readable({ read() {} });
    withIdleTimeout(source, 50, idle).destroy();
    expect(source.destroyed).toBe(true);
  });
});
