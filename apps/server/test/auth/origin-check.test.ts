import { ErrorBody } from '@pinwall/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppEnv } from '../../src/app.ts';
import { type BearerResolver, resolveAuth } from '../../src/auth/resolve.ts';
import { errorHandler } from '../../src/http/errors.ts';
import { originCheck } from '../../src/http/origin-check.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const EXPECTED = 'http://localhost:8080';
const EVIL = 'https://evil.example';

describe.each(dialects)('the CSRF origin check on %s', (dialect) => {
  let ctx: TestContext;
  let cookie: string;

  beforeEach(async () => {
    ctx = await createTestContext({ dialect });
    ({ cookie } = await createSignedInUser(ctx));
  });
  afterEach(() => ctx.close());

  const signOut = (o: Parameters<typeof apiInit>[1] = {}) =>
    ctx.request('/api/v1/auth/sign-out', apiInit(ctx, { method: 'POST', cookie, ...o }));

  const expectRefused = async (r: Response, origin: string | null) => {
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({
      error: {
        code: 'forbidden',
        message: t('auth.crossOrigin', { origin: origin ?? '(none)', expected: EXPECTED }),
        details: { origin, expected_origin: EXPECTED },
      },
    });
  };

  const sessionCount = async () =>
    (await ctx.deps.db.db.selectFrom('sessions').select('id_hash').execute()).length;

  test('cross-origin POST with a session cookie is refused', async () => {
    await expectRefused(await signOut({ origin: EVIL }), EVIL);
    expect(await sessionCount()).toBe(1);
    const me = await ctx.request('/api/v1/me', apiInit(ctx, { cookie }));
    expect(me.status).toBe(200);
  });

  test('missing or null Origin is refused', async () => {
    await expectRefused(await signOut({ origin: null }), null);
    await expectRefused(await signOut({ origin: 'null' }), 'null');
    expect(await sessionCount()).toBe(1);
  });

  test('Sec-Fetch-Site other than same-origin is refused', async () => {
    for (const site of ['same-site', 'cross-site', 'none']) {
      const r = await signOut({ headers: { 'sec-fetch-site': site } });
      expect(r.status, site).toBe(403);
    }
    expect(await sessionCount()).toBe(1);
  });

  test('every unsafe method is checked, with or without a cookie', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await ctx.request('/api/v1/me', apiInit(ctx, { method, origin: EVIL }));
      expect(r.status, method).toBe(403);
    }
  });

  test('same-origin POST passes', async () => {
    const r = await signOut({ headers: { 'sec-fetch-site': 'same-origin' } });
    expect(r.status).toBe(204);
    expect(await sessionCount()).toBe(0);
  });

  test('safe methods are not checked', async () => {
    const r = await ctx.request('/api/v1/me', apiInit(ctx, { cookie, origin: EVIL }));
    expect(r.status).toBe(200);
  });

  test('bearer requests skip the check', async () => {
    const stub: BearerResolver = {
      name: 'stub',
      matches: (token) => token.startsWith('st_'),
      resolve: async (_deps, token) => {
        const owner = await ctx.deps.db.db.selectFrom('users').selectAll().executeTakeFirst();
        return token === 'st_good' && owner ? { user: owner, via: 'oauth' } : null;
      },
    };
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set('deps', ctx.deps);
      c.set('auth', null);
      await next();
    });
    app.use(originCheck(ctx.deps.config), resolveAuth({ bearer: [stub], cookies: true }));
    app.post('/who', (c) => c.json({ via: c.var.auth?.via ?? null }));
    app.onError(errorHandler);
    const r = await app.request(
      `${EXPECTED}/who`,
      apiInit(ctx, { method: 'POST', bearer: 'st_good', origin: EVIL }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ via: 'oauth' });
  });

  test('origin mismatch names the expected origin', async () => {
    const r = await ctx.request(
      '/api/v1/auth/sign-out',
      apiInit(ctx, { method: 'POST', cookie, origin: 'http://127.0.0.1:8080' }),
    );
    const { error } = ErrorBody.parse(await r.json());
    expect(error.details).toEqual({
      origin: 'http://127.0.0.1:8080',
      expected_origin: 'http://localhost:8080',
    });
    expect(error.message).toContain('http://localhost:8080');
    expect(error.message).toContain('PINWALL_PUBLIC_ORIGIN');
  });
});
