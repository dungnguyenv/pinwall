import { createRoute } from '@hono/zod-openapi';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { jsonBodyLimit } from '../../src/api/body-limit.ts';
import { createApiRouter } from '../../src/api/router.ts';
import type { AppEnv } from '../../src/app.ts';
import { errorHandler } from '../../src/http/errors.ts';
import { rateLimited, unauthorized } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

const echo = createRoute({
  method: 'post',
  path: '/echo',
  middleware: [jsonBodyLimit],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ n: z.number() }) } },
    },
  },
  responses: {
    200: {
      description: 'Echo',
      content: { 'application/json': { schema: z.object({ n: z.number() }) } },
    },
  },
});

let ctx: TestContext;
let app: Hono<AppEnv>;

beforeEach(async () => {
  ctx = await createTestContext();
  const api = createApiRouter();
  api.openapi(echo, (c) => c.json({ n: c.req.valid('json').n }, 200));
  api.get('/busy', () => {
    throw rateLimited(30);
  });
  api.get('/guarded', (c) => {
    c.header('www-authenticate', 'Bearer');
    throw unauthorized('Sign in first.');
  });

  app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set('deps', ctx.deps);
    c.set('auth', null);
    await next();
  });
  app.route('/api/v1', api);
  app.onError(errorHandler);
});
afterEach(() => ctx.close());

const post = (body: string, contentType = 'application/json') =>
  app.request('http://pinwall.test/api/v1/echo', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

describe('the API router', () => {
  test('a valid body reaches the handler', async () => {
    const r = await post(JSON.stringify({ n: 3 }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ n: 3 });
  });

  test('validation failures are bad_request with issues', async () => {
    const r = await post(JSON.stringify({ n: 'x' }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      error: {
        code: 'bad_request',
        message: t('error.validation'),
        details: { issues: [{ path: 'n', message: expect.any(String) }] },
      },
    });
  });

  test('malformed JSON is bad_request', async () => {
    const r = await post('{');
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  test('a body that is not declared as JSON is unsupported_media_type', async () => {
    const r = await post('n=1', 'application/x-www-form-urlencoded');
    expect(r.status).toBe(415);
    expect(await r.json()).toMatchObject({ error: { code: 'unsupported_media_type' } });
  });

  test('oversized JSON is payload_too_large', async () => {
    const r = await post(JSON.stringify({ n: 1, pad: 'x'.repeat(70_000) }));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({
      error: { code: 'payload_too_large', message: t('error.tooLarge') },
    });
  });

  test('oversized JSON without a Content-Length is payload_too_large too', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(10_000));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 7; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const r = await app.request('http://pinwall.test/api/v1/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half', // Node's fetch requires it for a streamed body.
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  test('rate_limited errors carry Retry-After', async () => {
    const r = await app.request('http://pinwall.test/api/v1/busy');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('30');
  });

  test('headers set before an error survive', async () => {
    const r = await app.request('http://pinwall.test/api/v1/guarded');
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
    expect(await r.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });
});
