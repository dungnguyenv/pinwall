import { ApiTokenList, CreatedApiToken, Me } from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { createApiToken, MAX_ACTIVE_TOKENS } from '../../src/auth/api-tokens.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const T = Date.UTC(2026, 10, 10);
const DAY_MS = 86_400_000;

describe.each(dialects)('API tokens on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(() => ctx.close());

  async function start(): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    return ctx;
  }

  const list = (o: { cookie?: string; bearer?: string }) =>
    ctx.request('/api/v1/me/tokens', apiInit(ctx, o));
  const create = (o: { cookie?: string; bearer?: string }, body: unknown) =>
    ctx.request('/api/v1/me/tokens', apiInit(ctx, { ...o, body }));
  const revoke = (id: string, o: { cookie?: string; bearer?: string }) =>
    ctx.request(`/api/v1/me/tokens/${id}`, apiInit(ctx, { ...o, method: 'DELETE' }));
  const me = (bearer: string) => ctx.request('/api/v1/me', apiInit(ctx, { bearer }));

  const errorOf = async (r: Response) => ((await r.json()) as { error: unknown }).error;
  const listed = async (cookie: string) => {
    const r = await list({ cookie });
    expect(r.status).toBe(200);
    return ApiTokenList.parse(await r.json()).items;
  };
  const tokenRows = () => ctx.deps.db.db.selectFrom('api_tokens').selectAll().execute();

  test('creates a token and shows the secret once', async () => {
    await start();
    const { cookie } = await createSignedInUser(ctx);
    const r = await create({ cookie }, { name: 'ci' });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = CreatedApiToken.parse(await r.json());
    expect(body.secret).toMatch(/^pw_[A-Za-z0-9_-]{43}$/);
    expect(body.token).toMatchObject({
      name: 'ci',
      prefix: body.secret.slice(0, 11),
      expires_at: null,
      last_used_at: null,
      created_at: T,
    });
    expect(Object.keys(body.token).sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'last_used_at',
      'name',
      'prefix',
    ]);

    const l = await list({ cookie });
    expect(l.headers.get('cache-control')).toBe('no-store');
    const text = await l.text();
    expect(text).not.toContain(body.secret);
    const { items, next_cursor } = ApiTokenList.parse(JSON.parse(text));
    expect(next_cursor).toBeNull();
    expect(items).toEqual([body.token]);
    const raw = (JSON.parse(text) as { items: object[] }).items[0] ?? {};
    expect(raw).not.toHaveProperty('secret');
    expect(raw).not.toHaveProperty('token_hash');
  });

  test('the name is trimmed and must not be empty', async () => {
    await start();
    const { cookie } = await createSignedInUser(ctx);
    const ok = CreatedApiToken.parse(
      await (await create({ cookie }, { name: '  laptop ' })).json(),
    );
    expect(ok.token.name).toBe('laptop');
    for (const name of ['', '   ', 'x'.repeat(101), 5, undefined]) {
      expect((await create({ cookie }, { name })).status, String(name)).toBe(400);
    }
    expect(await tokenRows()).toHaveLength(1);
  });

  test('a token authenticates /me', async () => {
    await start();
    const { user } = await createSignedInUser(ctx);
    const secret = await createUserToken(ctx, user.id);
    const r = await me(secret);
    expect(r.status).toBe(200);
    const body = Me.parse(await r.json());
    expect(body).toMatchObject({ id: user.id, kind: 'owner', via: 'api_token' });

    const rows = await tokenRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.token_hash).toBe(hashSecret(secret));
    expect(
      Object.values(row ?? {})
        .map(String)
        .join('\n'),
    ).not.toContain(secret);
  });

  test('a token of an IdP member authenticates as that member', async () => {
    await start();
    const { user } = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bao' });
    const secret = await createUserToken(ctx, user.id);
    expect(Me.parse(await (await me(secret)).json())).toMatchObject({
      id: user.id,
      kind: 'oidc',
      role: 'member',
      via: 'api_token',
      credentials: null,
    });
  });

  test('last use is recorded', async () => {
    await start();
    const { user, cookie } = await createSignedInUser(ctx);
    const secret = await createUserToken(ctx, user.id);
    clock.advance(120_000);
    expect((await me(secret)).status).toBe(200);
    expect((await listed(cookie))[0]?.last_used_at).toBe(clock.now());
    const owner = await ctx.deps.db.db
      .selectFrom('users')
      .select('last_seen_at')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(owner.last_seen_at).toBe(clock.now());
  });

  test('last use is written at most once a minute', async () => {
    await start();
    const { user, cookie } = await createSignedInUser(ctx);
    const secret = await createUserToken(ctx, user.id);
    const lastUsed = async () => (await listed(cookie))[0]?.last_used_at;
    expect(await lastUsed()).toBeNull();

    expect((await me(secret)).status).toBe(200); // the first use is always recorded
    expect(await lastUsed()).toBe(T);
    clock.advance(59_999);
    expect((await me(secret)).status).toBe(200);
    expect(await lastUsed()).toBe(T);
    clock.advance(1);
    expect((await me(secret)).status).toBe(200);
    expect(await lastUsed()).toBe(T + 60_000);
  });

  test('an expired token is refused', async () => {
    await start();
    const { cookie } = await createSignedInUser(ctx);
    const created = CreatedApiToken.parse(
      await (await create({ cookie }, { name: 'short', expires_in_days: 1 })).json(),
    );
    expect(created.token.expires_at).toBe(T + DAY_MS);

    clock.advance(DAY_MS - 1);
    expect((await me(created.secret)).status).toBe(200);
    clock.advance(1);
    const r = await me(created.secret);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(await errorOf(r)).toEqual({ code: 'unauthorized', message: t('auth.invalidToken') });
  });

  test('an expired token stays listed until it is revoked', async () => {
    await start();
    const { cookie } = await createSignedInUser(ctx);
    const created = CreatedApiToken.parse(
      await (await create({ cookie }, { name: 'short', expires_in_days: 1 })).json(),
    );
    clock.advance(2 * DAY_MS);
    expect((await listed(cookie)).map((x) => x.id)).toEqual([created.token.id]);
    expect((await revoke(created.token.id, { cookie })).status).toBe(204);
    expect(await listed(cookie)).toEqual([]);
  });

  test('a revoked token is refused and leaves the list', async () => {
    await start();
    const { user, cookie } = await createSignedInUser(ctx);
    const secret = await createUserToken(ctx, user.id, { name: 'old' });
    const keep = await createUserToken(ctx, user.id, { name: 'keep' });
    const id = (await listed(cookie)).find((x) => x.name === 'old')?.id ?? '';
    expect((await me(secret)).status).toBe(200);

    const r = await revoke(id, { cookie });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    const refused = await me(secret);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect((await listed(cookie)).map((x) => x.name)).toEqual(['keep']);
    expect((await me(keep)).status).toBe(200);

    // The row stays, marked, so the record of it is kept; revoking again finds nothing.
    const revoked = (await tokenRows()).find((row) => row.id === id);
    expect(revoked?.revoked_at).toBe(T);
    const again = await revoke(id, { cookie });
    expect(again.status).toBe(404);
    expect(await errorOf(again)).toEqual({
      code: 'not_found',
      message: t('auth.tokenNotFound'),
    });
  });

  test("another user's token cannot be revoked", async () => {
    await start();
    const a = await createSignedInUser(ctx);
    const b = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bao' });
    const secret = await createUserToken(ctx, a.user.id);
    const id = (await listed(a.cookie))[0]?.id ?? '';

    const r = await revoke(id, { cookie: b.cookie });
    expect(r.status).toBe(404);
    expect(await errorOf(r)).toEqual({ code: 'not_found', message: t('auth.tokenNotFound') });
    expect((await me(secret)).status).toBe(200);
    expect(await listed(a.cookie)).toHaveLength(1);
    expect(await listed(b.cookie)).toEqual([]);
    expect((await revoke('tok_doesnotexist', { cookie: a.cookie })).status).toBe(404);
  });

  test('each user lists only their own tokens, newest first', async () => {
    await start();
    const a = await createSignedInUser(ctx);
    const b = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bao' });
    await createUserToken(ctx, a.user.id, { name: 'first' });
    clock.advance(1000);
    await createUserToken(ctx, b.user.id, { name: 'bao' });
    clock.advance(1000);
    await createUserToken(ctx, a.user.id, { name: 'second' });
    expect((await listed(a.cookie)).map((x) => x.name)).toEqual(['second', 'first']);
    expect((await listed(b.cookie)).map((x) => x.name)).toEqual(['bao']);
  });

  test('tokens cannot manage tokens', async () => {
    await start();
    const { user, cookie } = await createSignedInUser(ctx);
    const secret = await createUserToken(ctx, user.id);
    const id = (await listed(cookie))[0]?.id ?? '';
    const refusals = [
      await create({ bearer: secret }, { name: 'more' }),
      await list({ bearer: secret }),
      await revoke(id, { bearer: secret }),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toEqual({
        code: 'forbidden',
        message: t('auth.sessionRequired'),
      });
    }
    expect(await tokenRows()).toHaveLength(1);
    expect((await me(secret)).status).toBe(200); // the revoke attempt did nothing
  });

  test('token routes need a sign-in', async () => {
    await start();
    for (const r of [await list({}), await create({}, { name: 'x' }), await revoke('tok_x', {})]) {
      expect(r.status).toBe(401);
      expect(await errorOf(r)).toEqual({ code: 'unauthorized', message: t('auth.signInRequired') });
    }
  });

  test('a token made from a cookie request needs the public origin', async () => {
    await start();
    const { cookie } = await createSignedInUser(ctx);
    const r = await ctx.request(
      '/api/v1/me/tokens',
      apiInit(ctx, { cookie, body: { name: 'x' }, origin: 'https://evil.example' }),
    );
    expect(r.status).toBe(403);
    expect(await tokenRows()).toEqual([]);
  });

  test('expiry outside 1..3650 days is bad_request', async () => {
    await start();
    const { cookie } = await createSignedInUser(ctx);
    for (const days of [0, 3651, -1, 1.5, '30']) {
      const r = await create({ cookie }, { name: 'x', expires_in_days: days });
      expect(r.status, String(days)).toBe(400);
      expect(await errorOf(r)).toMatchObject({ code: 'bad_request' });
    }
    expect(await tokenRows()).toEqual([]);

    const longest = CreatedApiToken.parse(
      await (await create({ cookie }, { name: 'x', expires_in_days: 3650 })).json(),
    );
    expect(longest.token.expires_at).toBe(T + 3650 * DAY_MS);
    const never = CreatedApiToken.parse(
      await (await create({ cookie }, { name: 'x', expires_in_days: null })).json(),
    );
    expect(never.token.expires_at).toBeNull();
  });

  test('at most 100 active tokens', async () => {
    await start();
    const { user, cookie } = await createSignedInUser(ctx);
    for (let i = 0; i < MAX_ACTIVE_TOKENS - 1; i++) {
      await createApiToken(ctx.deps, user.id, { name: `t${i}`, expiresInDays: null });
    }
    const last = await create({ cookie }, { name: 'last' });
    expect(last.status).toBe(201);

    const over = await create({ cookie }, { name: 'one too many' });
    expect(over.status).toBe(409);
    expect(await errorOf(over)).toEqual({
      code: 'conflict',
      message: t('auth.tokenLimit', { max: 100 }),
    });
    expect(await tokenRows()).toHaveLength(100);

    // Another user's tokens do not count against this one.
    const other = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bao' });
    expect((await create({ cookie: other.cookie }, { name: 'mine' })).status).toBe(201);

    // Revoking one frees a place.
    const id = CreatedApiToken.parse(await last.json()).token.id;
    expect((await revoke(id, { cookie })).status).toBe(204);
    expect((await create({ cookie }, { name: 'again' })).status).toBe(201);
  });

  test('revoked and expired tokens do not count toward the limit', async () => {
    await start();
    const { user, cookie } = await createSignedInUser(ctx);
    for (let i = 0; i < 40; i++) {
      await createApiToken(ctx.deps, user.id, { name: `old${i}`, expiresInDays: 1 });
    }
    for (let i = 0; i < 40; i++) {
      await createApiToken(ctx.deps, user.id, { name: `gone${i}`, expiresInDays: null });
    }
    for (const x of (await listed(cookie)).filter((y) => y.name.startsWith('gone'))) {
      expect((await revoke(x.id, { cookie })).status).toBe(204);
    }
    clock.advance(2 * DAY_MS); // the first 40 have expired
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) {
      await createApiToken(ctx.deps, user.id, { name: `new${i}`, expiresInDays: null });
    }
    const over = await create({ cookie }, { name: 'over' });
    expect(over.status).toBe(409);
    expect(await tokenRows()).toHaveLength(40 + 40 + MAX_ACTIVE_TOKENS);
  });

  test('a token of a user without access is access_denied', async () => {
    await start();
    const { user } = await createSignedInUser(ctx);
    const secret = await createUserToken(ctx, user.id);
    await ctx.deps.db.db
      .updateTable('users')
      .set({ role_override: 'blocked' })
      .where('id', '=', user.id)
      .execute();
    const r = await me(secret);
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual({ code: 'access_denied', message: t('auth.accessDenied') });
  });

  test('a disabled user is access_denied too', async () => {
    await start();
    const { user } = await createSignedInUser(ctx, { kind: 'oidc' });
    const secret = await createUserToken(ctx, user.id);
    await ctx.deps.db.db
      .updateTable('users')
      .set({ disabled_at: clock.now(), disabled_reason: 'test' })
      .where('id', '=', user.id)
      .execute();
    expect((await me(secret)).status).toBe(403);
  });

  test('unknown, malformed and other-kind bearers are invalid_token', async () => {
    await start();
    const { user } = await createSignedInUser(ctx);
    const real = await createUserToken(ctx, user.id);
    const tampered = `${real.slice(0, -1)}${real.endsWith('A') ? 'B' : 'A'}`;
    for (const bearer of [`pw_${'x'.repeat(43)}`, 'pw_', tampered, real.slice('pw_'.length)]) {
      const r = await me(bearer);
      expect(r.status, bearer).toBe(401);
      expect(r.headers.get('www-authenticate'), bearer).toBe('Bearer error="invalid_token"');
    }
  });

  test('a token is not a session: the cookie of the same user is never consulted for it', async () => {
    await start();
    const { user, cookie } = await createSignedInUser(ctx);
    // A bad bearer next to a good cookie is refused, as `resolveAuth` promises.
    const r = await ctx.request(
      '/api/v1/me',
      apiInit(ctx, { cookie, bearer: `pw_${'y'.repeat(43)}` }),
    );
    expect(r.status).toBe(401);
    const good = await createUserToken(ctx, user.id);
    const via = await ctx.request('/api/v1/me', apiInit(ctx, { cookie, bearer: good }));
    expect(Me.parse(await via.json()).via).toBe('api_token');
  });

  test('the OpenAPI document lists the token routes as session-only', async () => {
    await start();
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, { security?: unknown }>>;
    };
    const operations = [
      doc.paths['/me/tokens']?.get,
      doc.paths['/me/tokens']?.post,
      doc.paths['/me/tokens/{id}']?.delete,
    ];
    for (const operation of operations) {
      expect(operation?.security).toEqual([{ session: [] }]);
    }
  });
});
