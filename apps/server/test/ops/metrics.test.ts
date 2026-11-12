import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, onTestFinished, test } from 'vitest';
import { createGrant } from '../../src/content/grants.ts';
import { createShareLink } from '../../src/domain/shares.ts';
import type { PublishTarget } from '../../src/domain/versions.ts';
import type { Scheduler } from '../../src/infra/index.ts';
import { AppError, badRequest, notFound } from '../../src/lib/errors.ts';
import { newSecret } from '../../src/lib/ids.ts';
import {
  enableProcessMetrics,
  instrumentScheduler,
  rejectionReason,
} from '../../src/ops/metrics.ts';
import { startMetricsServer } from '../../src/ops/metrics-server.ts';
import { ingestInline, ingestUpload } from '../../src/publish/ingest.ts';
import { PINWALL_VERSION } from '../../src/version.ts';
import { makeTar } from '../helpers/archives.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { CONTENT_ENV, fetchContent } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const NEW_ARTIFACT: PublishTarget = { kind: 'new_artifact', projectId: null, name: null, tags: [] };

const scrape = (ctx: TestContext) => ctx.deps.metrics.registry.metrics();

/** The lines of `text` that are series of the counter `name`. */
const seriesOf = (text: string, name: string) =>
  text.split('\n').filter((line) => line.startsWith(`${name}{`));

describe.each(dialects)('metrics on %s', (dialect) => {
  async function open(env: Record<string, string> = {}): Promise<TestContext> {
    const ctx = await createTestContext({ dialect, env });
    onTestFinished(() => ctx.close());
    return ctx;
  }

  test('counts requests by route pattern, never by raw path', async () => {
    const ctx = await open();
    const { user, cookie } = await createSignedInUser(ctx);
    const { artifact, version } = await publishFiles(ctx, user, { 'index.html': '<h1>hi</h1>' });
    const grant = await createGrant(ctx.deps, { versionId: version.id, mode: 'raw', user });
    const share = await createShareLink(ctx.deps, user, artifact.id, {
      versionId: null,
      password: null,
      expiresAt: null,
      allowComments: false,
    });
    const random = newSecret();

    await ctx.request(`/c/${grant.token}/index.html`);
    await ctx.request(`/s/${share.token}`);
    await ctx.request(`/upload/${newSecret()}`, { method: 'POST', body: 'x' });
    await ctx.request(`/api/v1/artifacts/${artifact.id}`, apiInit(ctx, { cookie }));
    await ctx.request(`/x/${random}`);

    const text = await scrape(ctx);
    // `/c/*` is how the content router mounts grant URLs: the token is never in the label.
    expect(text).toContain('route="/c/*"');
    expect(text).toContain('route="/api/v1/artifacts/:id"');
    expect(text).toMatch(/route="\/s\/:[A-Za-z]+"/);
    expect(text).toMatch(/route="\/upload\/:[A-Za-z]+"/);
    expect(text).toContain('route="unmatched"');
    for (const secret of [grant.token, share.token, artifact.id, random]) {
      expect(text).not.toContain(secret);
    }
  });

  test('labels carry the method, the route and the status of the response', async () => {
    const ctx = await open();
    await ctx.request('/healthz');
    await ctx.request('/healthz', { method: 'POST' });

    const text = await scrape(ctx);
    expect(text).toContain(
      'pinwall_http_requests_total{method="GET",route="/healthz",status="200"} 1',
    );
    // The histogram counts the same request.
    expect(text).toContain(
      'pinwall_http_request_duration_seconds_count{method="GET",route="/healthz"} 1',
    );
    expect(text).toContain(
      'pinwall_http_request_duration_seconds_bucket{le="0.005",method="GET",route="/healthz"}',
    );
    expect(text).toContain('le="30"');
  });

  test('unknown paths share one series', async () => {
    const ctx = await open();
    await ctx.request(`/${newSecret()}/${newSecret()}`);
    const before = seriesOf(await scrape(ctx), 'pinwall_http_requests_total').length;

    for (let i = 0; i < 200; i++) await ctx.request(`/${newSecret()}/${newSecret()}`);

    const after = seriesOf(await scrape(ctx), 'pinwall_http_requests_total').length;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  test('content-domain hosts are labelled content', async () => {
    const ctx = await open(CONTENT_ENV);
    const { user } = await createSignedInUser(ctx);
    const { version } = await publishFiles(ctx, user, { 'index.html': '<h1>hi</h1>' });
    const grant = await createGrant(ctx.deps, { versionId: version.id, mode: 'raw', user });

    const res = await fetchContent(ctx, grant.token, '');
    expect(res.status).toBe(200);
    await fetchContent(ctx, 'not-a-token', '');

    const text = await scrape(ctx);
    expect(text).toContain('route="content"');
    expect(text).not.toContain(grant.token);
    expect(text).not.toContain('not-a-token');
    expect(text).not.toContain('pw-content.test');
  });

  test('the SPA fallback is labelled spa', async () => {
    const webDir = await mkdtemp(join(tmpdir(), 'pinwall-web-'));
    onTestFinished(() => rm(webDir, { recursive: true, force: true }));
    await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    const ctx = await open({ PINWALL_WEB_DIR: webDir });

    const page = await ctx.request('/projects/x', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    // A browser asking for something the SPA does not know is the 404 page, not the SPA.
    const api = await ctx.request('/api/v1/nothing', { headers: { accept: 'application/json' } });
    expect(api.status).toBe(404);
    const missing = await ctx.request('/projects/x/file.png', { headers: { accept: 'image/png' } });
    expect(missing.status).toBe(404);

    const text = await scrape(ctx);
    expect(text).toContain('pinwall_http_requests_total{method="GET",route="spa",status="200"} 1');
    expect(text).toContain('route="unmatched",status="404"');
  });

  test('publishes, upload bytes and rejections', async () => {
    const ctx = await open({ PINWALL_MAX_FILES: '1' });
    const { user } = await createSignedInUser(ctx);
    const upload = (tar: Buffer) =>
      ingestUpload(
        ctx.deps,
        NEW_ARTIFACT,
        {
          body: Readable.from([tar]),
          contentType: null,
          contentLength: tar.length,
          filename: null,
        },
        { actor: user, source: 'api', message: null },
      );

    await publishFiles(ctx, user, { 'index.html': '<h1>one</h1>' });
    let text = await scrape(ctx);
    expect(text).toContain('pinwall_publishes_total{source="api"} 1');

    const tar = await makeTar([{ name: 'index.html', body: 'x'.repeat(3000) }]);
    await upload(tar);
    text = await scrape(ctx);
    expect(text).toContain('pinwall_publishes_total{source="api"} 2');
    const bytes = /pinwall_upload_bytes_total\{source="api"\} (\d+)/.exec(text);
    expect(Number(bytes?.[1])).toBeGreaterThanOrEqual(3072);

    const two = await makeTar([{ name: 'index.html' }, { name: 'b.css' }]);
    await expect(upload(two)).rejects.toThrow();
    const outside = await makeTar([{ name: '../x', body: 'x' }]);
    await expect(upload(outside)).rejects.toThrow();

    text = await scrape(ctx);
    expect(text).toContain('pinwall_uploads_rejected_total{reason="max_files"} 1');
    expect(text).toContain('pinwall_uploads_rejected_total{reason="dot_segment"} 1');
    // Refusals are not versions.
    expect(text).toContain('pinwall_publishes_total{source="api"} 2');
  });

  test('a web upload refused before its first file is counted', async () => {
    const ctx = await open({ PINWALL_MAX_UPLOAD_BYTES: '10000' });
    const { cookie } = await createSignedInUser(ctx);
    const boundary = 'pinwall-metrics-form';
    /** A multipart body with these parts, in order. */
    const form = (...parts: [name: string, filename: string | null, value: string][]) => {
      const encoded = parts.map(([name, filename, value]) => {
        const file = filename === null ? '' : `; filename="${filename}"`;
        return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file}\r\n\r\n${value}\r\n`;
      });
      return Buffer.from(`${encoded.join('')}--${boundary}--\r\n`);
    };
    const upload = (body: Buffer, headers: Record<string, string> = {}) =>
      ctx.request('/api/v1/publish/upload', {
        method: 'POST',
        body,
        headers: {
          cookie,
          origin: ctx.deps.config.publicOrigin,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          ...headers,
        },
      });

    // A file before any target: refused while the fields before the first file are read.
    const fileFirst = form(['file', 'index.html', '<p>x</p>'], ['target', null, '{}']);
    expect((await upload(fileFirst)).status).toBe(400);
    let text = await scrape(ctx);
    expect(text).toContain('pinwall_uploads_rejected_total{reason="bad_request"} 1');
    expect(text).toContain(`pinwall_upload_bytes_total{source="web"} ${fileFirst.length}`);

    // No multipart form at all, a first field that crosses the upload limit, and a length
    // declared over it.
    const urlencoded = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await upload(Buffer.from('target=%7B%7D'), urlencoded)).status).toBe(400);
    const bigField = form(['target', null, `{"name":"${'x'.repeat(20_000)}"}`]);
    expect((await upload(bigField)).status).toBe(413);
    const declared = await upload(form(['target', null, '{}']), { 'content-length': '10001' });
    expect(declared.status).toBe(413);
    text = await scrape(ctx);
    expect(text).toContain('pinwall_uploads_rejected_total{reason="bad_request"} 2');
    expect(text).toContain('pinwall_uploads_rejected_total{reason="max_upload_bytes"} 2');
    const bytes = /pinwall_upload_bytes_total\{source="web"\} (\d+)/.exec(text);
    expect(Number(bytes?.[1])).toBeGreaterThan(fileFirst.length + 10_000);
    expect(seriesOf(text, 'pinwall_publishes_total')).toEqual([]);
  });

  test('inline and file publishes are counted with their source and size', async () => {
    const ctx = await open();
    const { user } = await createSignedInUser(ctx);
    const opts = { actor: user, source: 'inline', message: null } as const;

    await ingestInline(ctx.deps, NEW_ARTIFACT, [{ path: 'index.html', content: 'abcd' }], opts);
    await expect(
      ingestInline(ctx.deps, NEW_ARTIFACT, [{ path: 'photo.png', content: 'abcd' }], opts),
    ).rejects.toThrow();
    await publishFiles(ctx, user, { 'index.html': 'abcdef' });

    const text = await scrape(ctx);
    expect(text).toContain('pinwall_publishes_total{source="inline"} 1');
    // Bytes count whether or not the publish was accepted.
    expect(text).toContain('pinwall_upload_bytes_total{source="inline"} 8');
    expect(text).toContain('pinwall_upload_bytes_total{source="api"} 6');
    expect(text).toContain('pinwall_uploads_rejected_total{reason="inline_text_only"} 1');
  });

  test('job runs and failures', async () => {
    const ctx = await open();
    const scheduled = new Map<string, () => Promise<void>>();
    const inner: Scheduler = {
      every: (name, _interval, fn) => void scheduled.set(name, fn),
      stop: async () => {},
    };
    const boom = new Error('job failed');
    let calls = 0;
    instrumentScheduler(inner, ctx.deps.metrics).every('j', 1000, async () => {
      calls += 1;
      if (calls === 1) throw boom;
    });
    const run = scheduled.get('j');
    if (run === undefined) throw new Error('the job was not handed to the inner scheduler');

    await expect(run()).rejects.toBe(boom);
    await run();

    const text = await scrape(ctx);
    expect(text).toContain('pinwall_job_runs_total{job="j",outcome="error"} 1');
    expect(text).toContain('pinwall_job_runs_total{job="j",outcome="ok"} 1');
  });

  test('gauges read the database at scrape time', async () => {
    const ctx = await open();
    const { db } = ctx.deps.db;
    const now = ctx.deps.clock.now();
    const first = await createSignedInUser(ctx);
    await createSignedInUser(ctx, { kind: 'oidc' });
    await db
      .updateTable('sessions')
      .set({ expires_at: now - 1 })
      .where('user_id', '=', first.user.id)
      .execute();
    await db
      .insertInto('blobs')
      .values([1, 2, 3].map((size) => ({ sha256: String(size).repeat(64), size, created_at: now })))
      .execute();

    const text = await scrape(ctx);
    expect(text).toContain('pinwall_active_sessions 1\n');
    expect(text).toContain('pinwall_storage_blobs 3\n');
    expect(text).toContain('pinwall_storage_blob_bytes 6\n');
    expect(text).toContain(`pinwall_build_info{version="${PINWALL_VERSION}"} 1`);

    // Changes show on the next scrape; a database that stops answering keeps the last values.
    await db.deleteFrom('blobs').where('size', '=', 3).execute();
    expect(await scrape(ctx)).toContain('pinwall_storage_blobs 2\n');
    await ctx.deps.db.close();
    const after = await scrape(ctx);
    expect(after).toContain('pinwall_storage_blobs 2\n');
    expect(after).toContain('pinwall_active_sessions 1\n');
  });

  test('process metrics are added only when asked for', async () => {
    const ctx = await open();
    expect(await scrape(ctx)).not.toContain('process_cpu_user_seconds_total');
    enableProcessMetrics(ctx.deps.metrics);
    const text = await scrape(ctx);
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });

  test('every context has a registry of its own', async () => {
    const [one, two] = [await open(), await open()];
    await one.request('/healthz');
    expect(await scrape(one)).toContain('route="/healthz"');
    expect(await scrape(two)).not.toContain('route="/healthz"');
  });

  test('the metrics listener serves /metrics only, never the app port', async () => {
    const ctx = await open();
    await ctx.request('/healthz');
    const server = await startMetricsServer(ctx.deps, { port: 0 });
    if (server === null) throw new Error('no metrics listener');
    onTestFinished(() => server.close());
    const base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(await res.text()).toContain('pinwall_build_info');

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);
    expect(root.headers.get('content-type')).toMatch(/^text\/plain/);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/metrics/extra`)).status).toBe(404);

    const app = await ctx.request('/metrics', { headers: { accept: 'application/json' } });
    expect(app.status).toBe(404);
  });

  test('closing the metrics listener frees its port', async () => {
    const ctx = await open();
    const server = await startMetricsServer(ctx.deps, { port: 0 });
    if (server === null) throw new Error('no metrics listener');
    const { port } = server;
    // A keep-alive client must not hold the close open.
    const res = await fetch(`http://127.0.0.1:${port}/metrics`, { keepalive: true });
    await res.text();

    await server.close();
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
    await server.close();
  });

  test('PINWALL_METRICS_PORT=0 starts no listener', async () => {
    const ctx = await open({ PINWALL_METRICS_PORT: '0' });
    expect(await startMetricsServer(ctx.deps)).toBeNull();
  });
});

describe('rejectionReason', () => {
  test('names the limit or the reason of a refusal, else its code', () => {
    const limit = new AppError('payload_too_large', 413, 'too big', { limit: 'max_files', max: 1 });
    expect(rejectionReason(limit)).toBe('max_files');
    expect(rejectionReason(badRequest('bad', { reason: 'dot_segment', path: '../x' }))).toBe(
      'dot_segment',
    );
    expect(rejectionReason(notFound('gone'))).toBe('not_found');
  });

  test('keeps the set of values small: anything odd is "other"', () => {
    expect(rejectionReason(badRequest('bad', { reason: 'Has Spaces' }))).toBe('other');
    expect(rejectionReason(badRequest('bad', { reason: 'a'.repeat(41) }))).toBe('other');
    expect(rejectionReason(badRequest('bad', { reason: 42 }))).toBe('other');
    expect(rejectionReason(badRequest('bad', { reason: '../etc' }))).toBe('other');
  });

  test('is null for what is not a refusal of the client', () => {
    expect(rejectionReason(new AppError('internal', 500, 'oops'))).toBeNull();
    expect(rejectionReason(new Error('boom'))).toBeNull();
    expect(rejectionReason('text')).toBeNull();
    expect(rejectionReason(undefined)).toBeNull();
  });
});
