import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { errorHandler, notFoundHandler, wantsHtml } from '../../src/http/errors.ts';
import { conflict, forbidden, rateLimited } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

const html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

describe('not found', () => {
  test('browser 404 is an HTML page without stack traces', async () => {
    const r = await ctx.request('/definitely/not/here', { headers: html });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('text/html');
    const requestId = r.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    const body = await r.text();
    expect(body.startsWith('<!doctype html>')).toBe(true);
    expect(body).toContain(t('error.notFound.title'));
    expect(body).toContain(requestId);
    expect(body).toContain(t('error.goHome'));
    expect(body).not.toContain('<style');
  });

  test('api 404 is JSON', async () => {
    const r = await ctx.request('/api/v1/nope', { headers: { accept: 'text/html' } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  test('a client that does not accept HTML gets JSON anywhere', async () => {
    const r = await ctx.request('/definitely/not/here', {
      headers: { accept: 'application/json' },
    });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({
      error: { code: 'not_found', message: t('error.notFound.message') },
    });
  });
});

describe('thrown errors', () => {
  test('unexpected errors hide internals', async () => {
    const logged = vi.spyOn(ctx.deps.logger, 'error');
    ctx.app.get('/boom', () => {
      throw new Error('db password leaked');
    });

    const r = await ctx.request('/boom', { headers: html });
    expect(r.status).toBe(500);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const requestId = r.headers.get('x-request-id') ?? '';
    const body = await r.text();
    expect(body).toContain(requestId);
    expect(body).toContain(t('error.server.title'));
    expect(body).not.toContain('db password leaked');
    expect(body).not.toContain('at ');

    // The operator still gets the whole error, tied to the request id.
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: requestId, err: expect.any(Error) }),
      expect.any(String),
    );
  });

  test('unexpected errors in JSON name only the request id', async () => {
    ctx.app.get('/api/v1/boom', () => {
      throw new Error('db password leaked');
    });

    const r = await ctx.request('/api/v1/boom');
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toContain('db password leaked');
    expect(JSON.parse(text)).toEqual({
      error: {
        code: 'internal',
        message: t('error.server.message'),
        details: { request_id: r.headers.get('x-request-id') },
      },
    });
  });

  test('AppError keeps its status and code', async () => {
    ctx.app.get('/api/v1/taken', () => {
      throw conflict('x', { name: 'Report' });
    });

    const r = await ctx.request('/api/v1/taken');
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      error: { code: 'conflict', message: 'x', details: { name: 'Report' } },
    });
  });

  test('a browser sees the AppError message on an HTML page', async () => {
    ctx.app.get('/private', () => {
      throw forbidden('Only admins can open this page.');
    });

    const r = await ctx.request('/private', { headers: html });
    expect(r.status).toBe(403);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(await r.text()).toContain('Only admins can open this page.');
  });

  test('rate limits tell the client when to retry', async () => {
    ctx.app.get('/api/v1/busy', () => {
      throw rateLimited(42);
    });

    const r = await ctx.request('/api/v1/busy');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('42');
    expect(await r.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  test("Hono's HTTPException maps to an error code by status", async () => {
    ctx.app.get('/api/v1/big', () => {
      throw new HTTPException(413, { message: 'Request body is too large.' });
    });

    const r = await ctx.request('/api/v1/big');
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({
      error: { code: 'payload_too_large', message: 'Request body is too large.' },
    });
  });

  test('the handlers work on a bare app without the request id middleware', async () => {
    const bare = new Hono();
    bare.get('/boom', () => {
      throw new Error('hidden');
    });
    bare.onError(errorHandler);
    bare.notFound(notFoundHandler);

    // Without deps there is no logger: the error still reaches the operator, on stderr.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await bare.request('/boom', { headers: html });
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('hidden');
    expect(stderr).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ err: expect.any(Error) }),
    );
    stderr.mockRestore();
    expect((await bare.request('/nope')).status).toBe(404);
  });
});

describe('error page stylesheet', () => {
  test('the page links a versioned stylesheet served with a long cache', async () => {
    const page = await (await ctx.request('/nowhere', { headers: html })).text();
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(page)?.[1];
    expect(href).toMatch(/^\/_pinwall\/pages\.css\?v=[0-9a-f]{12}$/);

    const css = await ctx.request(href ?? '');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await css.text()).toContain('prefers-color-scheme: dark');
  });
});

describe('wantsHtml', () => {
  const app = new Hono();
  app.get('*', (c) => c.text(String(wantsHtml(c))));
  const ask = async (path: string, accept = 'text/html') =>
    (await app.request(path, { headers: { accept } })).text();

  test('browser routes want HTML', async () => {
    for (const path of ['/', '/projects/x', '/oauth/authorize', '/mcpx', '/apis', '/uploads']) {
      expect(await ask(path), path).toBe('true');
    }
  });

  test('machine endpoints never get HTML', async () => {
    const paths = [
      '/api',
      '/api/v1/x',
      '/mcp',
      '/mcp/x',
      '/oauth/token',
      '/oauth/register',
      '/oauth/revoke',
      '/.well-known',
      '/.well-known/oauth-authorization-server',
      '/upload/abc',
    ];
    for (const path of paths) expect(await ask(path), path).toBe('false');
  });

  test('clients that do not accept HTML do not get it', async () => {
    expect(await ask('/projects/x', 'application/json')).toBe('false');
    expect(await ask('/projects/x', '')).toBe('false');
  });
});
