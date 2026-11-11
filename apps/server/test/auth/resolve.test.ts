import { type Context, Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppEnv } from '../../src/app.ts';
import { type BearerResolver, resolveAuth } from '../../src/auth/resolve.ts';
import { bearerResolvers } from '../../src/auth/resolvers.ts';
import { startSession } from '../../src/auth/session-cookie.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { errorHandler } from '../../src/http/errors.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import { apiInit, createSignedInUser, sessionCookieFrom } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

describe.each(dialects)('resolveAuth on %s', (dialect) => {
  let ctx: TestContext;
  let user: UserRow;
  let cookie: string;

  /** Claims `st_` tokens; only `st_good` is valid, and it names `user`. */
  const stub: BearerResolver = {
    name: 'stub',
    matches: (token) => token.startsWith('st_'),
    resolve: async (_deps, token) => (token === 'st_good' ? { user, via: 'oauth' } : null),
  };

  beforeEach(async () => {
    ctx = await createTestContext({ dialect, clock: new FixedClock(Date.UTC(2026, 10, 10)) });
    ({ user, cookie } = await createSignedInUser(ctx));
  });
  afterEach(() => ctx.close());

  function bareApp(cookies: boolean): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set('deps', ctx.deps);
      c.set('auth', null);
      await next();
    });
    app.use(resolveAuth({ bearer: [stub], cookies }));
    const who = (c: Context<AppEnv>) =>
      c.json({ via: c.var.auth?.via ?? null, user_id: c.var.auth?.user.id ?? null });
    app.get('/who', (c) => who(c));
    app.post('/who', (c) => who(c));
    app.post('/start', async (c) => {
      await startSession(c, user, 'passkey');
      return who(c);
    });
    app.onError(errorHandler);
    return app;
  }

  const send = (app: Hono<AppEnv>, headers: Record<string, string>, method = 'GET') =>
    app.request('http://localhost:8080/who', { method, headers });

  test('a matching resolver authenticates with its via', async () => {
    const r = await send(bareApp(true), { authorization: 'Bearer st_good' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ via: 'oauth', user_id: user.id });
  });

  test('a session cookie authenticates with via session', async () => {
    const r = await send(bareApp(true), { cookie });
    expect(await r.json()).toEqual({ via: 'session', user_id: user.id });
  });

  test('an invalid bearer is refused even with a valid session cookie', async () => {
    const r = await send(bareApp(true), { authorization: 'Bearer st_bad', cookie });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
    expect(await r.json()).toEqual({
      error: { code: 'unauthorized', message: t('auth.invalidToken') },
    });
  });

  test('a bearer no resolver claims is refused', async () => {
    const r = await send(bareApp(true), { authorization: 'Bearer xyz' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  });

  test('a malformed Authorization header is refused', async () => {
    const app = bareApp(true);
    for (const authorization of ['Basic abc', 'Bearer', 'Bearer a b', 'Bearer  st_good', '']) {
      const r = await send(app, { authorization, cookie });
      expect(r.status, authorization).toBe(401);
      expect(r.headers.get('www-authenticate'), authorization).toBe(
        'Bearer error="invalid_request"',
      );
      expect(await r.json()).toMatchObject({ error: { message: t('auth.invalidToken') } });
    }
  });

  test('the scheme is case-insensitive', async () => {
    const app = bareApp(true);
    for (const authorization of ['bearer st_good', 'BEARER st_good']) {
      const r = await send(app, { authorization });
      expect(r.status, authorization).toBe(200);
    }
  });

  test('a bearer for a user without access is access_denied', async () => {
    await ctx.deps.db.db
      .updateTable('users')
      .set({ role_override: 'blocked' })
      .where('id', '=', user.id)
      .execute();
    user = { ...user, role_override: 'blocked' };
    const r = await send(bareApp(true), { authorization: 'Bearer st_good' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      error: { code: 'access_denied', message: t('auth.accessDenied') },
    });
  });

  test('cookies are ignored when the middleware is bearer-only', async () => {
    const r = await send(bareApp(false), { cookie });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ via: null, user_id: null });
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  test('startSession drops the presented session and signs the request in', async () => {
    const app = bareApp(true);
    const r = await app.request(
      'http://localhost:8080/start',
      apiInit(ctx, { method: 'POST', cookie }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ via: 'session', user_id: user.id });
    const fresh = sessionCookieFrom(r);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(cookie);
    expect(r.headers.getSetCookie()).toHaveLength(1);

    const rows = await ctx.deps.db.db.selectFrom('sessions').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id_hash: hashSecret(fresh?.split('=')[1] ?? ''),
      auth_method: 'passkey',
    });
    expect(await (await send(app, { cookie })).json()).toEqual({ via: null, user_id: null });
    expect(await (await send(app, { cookie: fresh ?? '' })).json()).toMatchObject({
      via: 'session',
    });
  });

  // OAuth access tokens belong to `/mcp`, which gets its own resolver list; the list `/api/v1`
  // and `/a/*` share must never honour them, whatever a later milestone adds.
  test('the shared resolver list takes API tokens only, so an OAuth access token is refused', async () => {
    expect(bearerResolvers.map((r) => r.name)).toEqual(['api_token']);
    for (const token of ['pwa_0123456789abcdef', 'pwr_0123456789abcdef']) {
      const r = await ctx.request('/api/v1/me', apiInit(ctx, { bearer: token }));
      expect(r.status, token).toBe(401);
      expect(r.headers.get('www-authenticate'), token).toBe('Bearer error="invalid_token"');
    }
  });
});
