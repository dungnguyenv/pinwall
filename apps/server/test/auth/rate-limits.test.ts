import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { AppEnv } from '../../src/app.ts';
import { enforceRateLimit, RATE_RULES, type RateRule } from '../../src/auth/rate-limits.ts';
import { errorHandler } from '../../src/http/errors.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

let ctx: TestContext;
let clock: FixedClock;

beforeEach(async () => {
  clock = new FixedClock(Date.UTC(2026, 10, 10));
  ctx = await createTestContext({ clock, env: { PINWALL_TRUST_PROXY: 'true' } });
});
afterEach(() => ctx.close());

const RULE: RateRule = { name: 'probe', limit: 3, windowMs: 60_000 };

function appWith(rule: RateRule, key?: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set('deps', ctx.deps);
    c.set('auth', null);
    await next();
  });
  app.post('/try', async (c) => {
    await enforceRateLimit(c, rule, key);
    return c.body(null, 204);
  });
  app.onError(errorHandler);
  return app;
}

const from = (app: Hono<AppEnv>, ip: string) =>
  app.request('http://localhost:8080/try', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });

test('the rules have the documented limits', () => {
  expect(RATE_RULES).toEqual({
    setup: { name: 'setup', limit: 10, windowMs: 900_000 },
    password: { name: 'password', limit: 10, windowMs: 900_000 },
    passwordGlobal: { name: 'password-global', limit: 100, windowMs: 3_600_000 },
    passkey: { name: 'passkey', limit: 30, windowMs: 900_000 },
    publish: { name: 'publish', limit: 60, windowMs: 600_000 },
    grant: { name: 'grant', limit: 600, windowMs: 3_600_000 },
    shareLinkCreate: { name: 'share-link-create', limit: 30, windowMs: 3_600_000 },
    projectCreate: { name: 'project-create', limit: 30, windowMs: 3_600_000 },
  });
});

test('the limit is per client address and answers 429 with Retry-After', async () => {
  const app = appWith(RULE);
  for (let i = 0; i < 3; i++) expect((await from(app, '203.0.113.7')).status).toBe(204);
  clock.advance(10_500);
  const refused = await from(app, '203.0.113.7');
  expect(refused.status).toBe(429);
  expect(refused.headers.get('retry-after')).toBe('50');
  expect(await refused.json()).toMatchObject({
    error: { code: 'rate_limited', details: { retry_after_seconds: 50 } },
  });
  expect((await from(app, '203.0.113.8')).status).toBe(204);
  const same = await ctx.deps.rateLimiter.consume('probe:203.0.113.7', 3, 60_000);
  expect(same.allowed).toBe(false);
});

test('an explicit key replaces the client address', async () => {
  const app = appWith(RULE, 'all');
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
    expect((await from(app, ip)).status).toBe(204);
  }
  expect((await from(app, '198.51.100.4')).status).toBe(429);
  expect((await ctx.deps.rateLimiter.consume('probe:all', 3, 60_000)).allowed).toBe(false);
});
