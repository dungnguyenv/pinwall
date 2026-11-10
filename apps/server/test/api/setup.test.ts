import { CeremonyOptions, Me } from '@pinwall/shared';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSession } from '../../src/auth/sessions.ts';
import { announceSetupLink, SETUP_LINK_TTL_MS } from '../../src/auth/setup.ts';
import { startAuth } from '../../src/auth/startup.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import { apiInit, sessionCookieFrom, setupOwner } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { SoftAuthenticator } from '../helpers/soft-authenticator.ts';

const T = Date.UTC(2026, 10, 10);
const PASSWORD = 'correct horse battery';

describe.each(dialects)('owner setup on %s', (dialect) => {
  let ctx: TestContext | undefined;
  let clock: FixedClock;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  async function start(env: Record<string, string> = {}): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    return ctx;
  }

  /** Announces a fresh setup link and returns its token. */
  async function newToken(c: TestContext): Promise<string> {
    const url = await announceSetupLink(c.deps);
    if (url === null) throw new Error('expected a setup link');
    return new URL(url).searchParams.get('token') ?? '';
  }

  const post = (c: TestContext, path: string, body: unknown, url?: string) =>
    url === undefined
      ? c.request(`/api/v1${path}`, apiInit(c, { body }))
      : c.app.request(url, apiInit(c, { body }));
  const check = (c: TestContext, token: string) => post(c, '/auth/setup/check', { token });
  const setup = (c: TestContext, body: Record<string, unknown>) => post(c, '/auth/setup', body);

  async function passkeyOptions(c: TestContext, token: string, name = 'Ada') {
    const r = await post(c, '/auth/setup/passkey/options', { token, name });
    expect(r.status).toBe(200);
    const body = CeremonyOptions.parse(await r.json());
    return {
      ceremonyId: body.ceremony_id,
      options: body.options as unknown as PublicKeyCredentialCreationOptionsJSON,
    };
  }

  const errorOf = async (r: Response) => ((await r.json()) as { error: unknown }).error;
  const users = (c: TestContext) => c.deps.db.db.selectFrom('users').selectAll().execute();

  test('announce prints a one-time setup link while no owner exists', async () => {
    const c = await start();
    const warn = vi.spyOn(c.deps.logger, 'warn');
    const url = await announceSetupLink(c.deps);
    expect(url).toMatch(/^http:\/\/localhost:8080\/setup\?token=[A-Za-z0-9_-]{43}$/);
    expect(warn).toHaveBeenCalledWith({ setup_url: url }, expect.stringContaining(url ?? '-'));
    expect(warn).toHaveBeenCalledWith({ setup_url: url }, t('log.setupLink', { url: url ?? '-' }));
  });

  test('the setup link uses the public origin', async () => {
    const c = await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
    expect(await announceSetupLink(c.deps)).toMatch(/^https:\/\/pinwall\.test\/setup\?token=/);
  });

  test('the token is kept only as a hash', async () => {
    const c = await start();
    const token = await newToken(c);
    const store = c.deps.oneTime;
    expect(await store.peek(`setup:${token}`)).toBeNull();
    expect(await store.peek(`setup:${hashSecret(token)}`)).toEqual({ created_at: T });
    expect(await store.peek('setup:current')).toEqual({ hash: hashSecret(token) });
  });

  test('a new announcement replaces the previous link', async () => {
    const c = await start();
    const old = await newToken(c);
    const current = await newToken(c);
    expect(current).not.toBe(old);
    const r = await check(c, old);
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toEqual({ code: 'forbidden', message: t('auth.setup.invalidLink') });
    expect((await check(c, current)).status).toBe(204);
  });

  test('the link expires after 24 hours', async () => {
    const c = await start();
    const token = await newToken(c);
    clock.advance(SETUP_LINK_TTL_MS - 1);
    expect((await check(c, token)).status).toBe(204);
    clock.set(T + 86_400_001);
    expect((await check(c, token)).status).toBe(403);
  });

  test('setup with a password creates the owner and signs in', async () => {
    const c = await start();
    const token = await newToken(c);
    const r = await setup(c, { token, name: 'Ada', email: 'ada@example.com', password: PASSWORD });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = Me.parse(await r.json());
    expect(body).toEqual({
      id: expect.stringMatching(/^usr_/),
      kind: 'owner',
      name: 'Ada',
      email: 'ada@example.com',
      email_verified: false,
      avatar_url: null,
      role: 'admin',
      via: 'session',
      credentials: { password: true, passkeys: 0 },
      created_at: T,
    });

    const cookie = sessionCookieFrom(r);
    expect(cookie).toMatch(/^pinwall_session=[A-Za-z0-9_-]{43}$/);
    const me = await c.request('/api/v1/me', apiInit(c, { cookie: cookie ?? '' }));
    expect(me.status).toBe(200);
    expect(Me.parse(await me.json()).id).toBe(body.id);

    const { db } = c.deps.db;
    expect(await users(c)).toEqual([
      expect.objectContaining({
        id: body.id,
        kind: 'owner',
        email_verified: 0,
        created_at: T,
        last_seen_at: T,
      }),
    ]);
    const credential = await db.selectFrom('password_credentials').selectAll().execute();
    expect(credential).toEqual([{ user_id: body.id, hash: expect.any(String), updated_at: T }]);
    expect(credential[0]?.hash.startsWith('scrypt$')).toBe(true);
    const session = await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(session).toMatchObject({ user_id: body.id, auth_method: 'password' });
  });

  test('setup with a passkey', async () => {
    const c = await start();
    const a = new SoftAuthenticator({ origin: c.deps.config.publicOrigin });
    const token = await newToken(c);
    const { ceremonyId, options } = await passkeyOptions(c, token);
    expect(options.rp).toEqual({ name: 'Pinwall', id: 'localhost' });
    expect(options.user).toMatchObject({ name: 'Ada', displayName: 'Ada' });

    const r = await setup(c, {
      token,
      name: 'Ada',
      passkey: { ceremony_id: ceremonyId, response: a.register(options), name: 'Laptop' },
    });
    expect(r.status).toBe(201);
    const body = Me.parse(await r.json());
    expect(body.credentials).toEqual({ password: false, passkeys: 1 });
    expect(sessionCookieFrom(r)).not.toBeNull();

    const { db } = c.deps.db;
    const passkeys = await db.selectFrom('passkeys').selectAll().execute();
    expect(passkeys).toEqual([
      expect.objectContaining({
        name: 'Laptop',
        user_id: body.id,
        credential_id: a.credentials[0]?.id,
        created_at: T,
      }),
    ]);
    // The passkey's user handle is the owner's id, so it can sign in later.
    expect(Buffer.from(a.credentials[0]?.userHandle ?? '', 'base64url').toString()).toBe(body.id);
    expect(await db.selectFrom('password_credentials').selectAll().execute()).toEqual([]);
    const session = await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(session.auth_method).toBe('passkey');
  });

  test('setup with a password and an unnamed passkey keeps both', async () => {
    const c = await start();
    const a = new SoftAuthenticator({ origin: c.deps.config.publicOrigin });
    const token = await newToken(c);
    const { ceremonyId, options } = await passkeyOptions(c, token);
    const r = await setup(c, {
      token,
      name: 'Ada',
      password: PASSWORD,
      passkey: { ceremony_id: ceremonyId, response: a.register(options) },
    });
    expect(r.status).toBe(201);
    expect(Me.parse(await r.json()).credentials).toEqual({ password: true, passkeys: 1 });
    const passkey = await c.deps.db.db.selectFrom('passkeys').selectAll().executeTakeFirstOrThrow();
    expect(passkey.name).toBe('Passkey 1');
  });

  test('setup needs a password or a passkey', async () => {
    const c = await start();
    const token = await newToken(c);
    const r = await setup(c, { token, name: 'Ada', email: null });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toEqual({
      code: 'bad_request',
      message: t('auth.setup.needCredential'),
    });
    expect((await check(c, token)).status).toBe(204);
  });

  test('the link works once', async () => {
    const c = await start();
    const token = await newToken(c);
    expect((await setup(c, { token, name: 'Ada', password: PASSWORD })).status).toBe(201);

    const again = await setup(c, { token, name: 'Eve', password: PASSWORD });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toEqual({ code: 'setup_done', message: t('auth.setup.done') });
    const checked = await check(c, token);
    expect(checked.status).toBe(409);
    expect(await errorOf(checked)).toMatchObject({ code: 'setup_done' });
    expect(await c.deps.oneTime.peek('setup:current')).toBeNull();

    const warn = vi.spyOn(c.deps.logger, 'warn');
    expect(await announceSetupLink(c.deps)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(await users(c)).toHaveLength(1);
  });

  test('a rejected setup attempt leaves the link usable', async () => {
    const c = await start();
    const token = await newToken(c);

    const short = await setup(c, { token, name: 'Ada', password: 'short' });
    expect(short.status).toBe(400);
    expect(await errorOf(short)).toEqual({
      code: 'bad_request',
      message: t('auth.passwordTooShort', { min: 12 }),
      details: { field: 'password' },
    });

    const evil = new SoftAuthenticator({ origin: 'http://evil.example' });
    const { ceremonyId, options } = await passkeyOptions(c, token);
    const forged = await setup(c, {
      token,
      name: 'Ada',
      passkey: { ceremony_id: ceremonyId, response: evil.register(options) },
    });
    expect(forged.status).toBe(401);
    expect(await errorOf(forged)).toMatchObject({ code: 'invalid_credentials' });
    expect(await users(c)).toEqual([]);

    expect((await setup(c, { token, name: 'Ada', password: PASSWORD })).status).toBe(201);
    expect(await users(c)).toHaveLength(1);
  });

  test('a setup that cannot store the owner leaves the link usable', async () => {
    const c = await start();
    const a = new SoftAuthenticator({ origin: c.deps.config.publicOrigin });
    const token = await newToken(c);
    const { ceremonyId, options } = await passkeyOptions(c, token);
    const response = a.register(options);

    // Another user already holds this credential id, so storing the passkey fails.
    const { db } = c.deps.db;
    await db
      .insertInto('users')
      .values({ id: 'usr_other', kind: 'oidc', email_verified: 0, created_at: T })
      .execute();
    await db
      .insertInto('passkeys')
      .values({
        id: 'pky_other',
        user_id: 'usr_other',
        credential_id: response.id,
        public_key: 'pk',
        counter: 0,
        transports: '[]',
        name: 'Other',
        created_at: T,
      })
      .execute();

    const failed = await setup(c, {
      token,
      name: 'Ada',
      passkey: { ceremony_id: ceremonyId, response },
    });
    expect(failed.status).toBe(500);
    expect(await db.selectFrom('users').select('id').where('kind', '=', 'owner').execute()).toEqual(
      [],
    );
    expect((await check(c, token)).status).toBe(204);
    expect((await setup(c, { token, name: 'Ada', password: PASSWORD })).status).toBe(201);
  });

  test('two concurrent setups create one owner', async () => {
    const c = await start();
    const token = await newToken(c);
    const body = { token, name: 'Ada', password: PASSWORD };
    const results = await Promise.all([setup(c, body), setup(c, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(await errorOf(loser ?? results[0] ?? new Response())).toMatchObject({
      code: 'setup_done',
    });
    expect(await users(c)).toHaveLength(1);
  });

  test('a wrong token is forbidden', async () => {
    const c = await start();
    await newToken(c);
    const wrong = 'A'.repeat(43);
    for (const r of [
      await check(c, wrong),
      await post(c, '/auth/setup/passkey/options', { token: wrong, name: 'Ada' }),
      await setup(c, { token: wrong, name: 'Ada', password: PASSWORD }),
    ]) {
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toEqual({
        code: 'forbidden',
        message: t('auth.setup.invalidLink'),
      });
    }
    expect(await users(c)).toEqual([]);
  });

  test('setup by password works where passkeys are unavailable', async () => {
    const c = await start({ PINWALL_PUBLIC_ORIGIN: 'http://pinwall.lan:8080' });
    const token = await newToken(c);
    const options = await post(c, '/auth/setup/passkey/options', { token, name: 'Ada' });
    expect(options.status).toBe(400);
    expect(await errorOf(options)).toEqual({
      code: 'bad_request',
      message: t('auth.passkeysUnavailable'),
    });
    expect((await setup(c, { token, name: 'Ada', password: PASSWORD })).status).toBe(201);
  });

  test('setup cookie is Secure and __Host- on an https origin although the request is http', async () => {
    const c = await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
    const token = await newToken(c);
    const r = await post(
      c,
      '/auth/setup',
      { token, name: 'Ada', password: PASSWORD },
      'http://internal:8080/api/v1/auth/setup',
    );
    expect(r.status).toBe(201);
    const cookies = r.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const sc = cookies[0] ?? '';
    expect(sc).toMatch(/^__Host-pinwall_session=[A-Za-z0-9_-]{43};/);
    for (const part of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) {
      expect(sc).toContain(part);
    }
  });

  test('setup is rate limited per IP', async () => {
    const c = await start();
    await newToken(c);
    for (let i = 0; i < 10; i++) {
      expect((await check(c, `wrong-${i}`)).status).toBe(403);
    }
    const r = await check(c, 'wrong-10');
    expect(r.status).toBe(429);
    expect(await errorOf(r)).toMatchObject({ code: 'rate_limited' });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('setup requests need the public origin', async () => {
    const c = await start();
    const token = await newToken(c);
    const r = await c.request(
      '/api/v1/auth/setup',
      apiInit(c, {
        body: { token, name: 'Ada', password: PASSWORD },
        origin: 'http://evil.example',
      }),
    );
    expect(r.status).toBe(403);
    expect(await users(c)).toEqual([]);
  });

  test('startAuth announces the link and schedules the session cleanup', async () => {
    const c = await start();
    const every = vi.spyOn(c.deps.scheduler, 'every');
    const url = await startAuth(c.deps);
    expect(url).toMatch(/\/setup\?token=/);
    expect(every).toHaveBeenCalledWith('auth-cleanup', 3_600_000, expect.any(Function));

    const user = 'usr_cleanup';
    await c.deps.db.db
      .insertInto('users')
      .values({ id: user, kind: 'owner', email_verified: 0, created_at: T })
      .execute();
    await createSession(c.deps, user, 'password', { ip: '::1', userAgent: null });
    clock.advance(c.deps.config.ttl.sessionMs);
    const job = every.mock.calls[0]?.[2];
    await job?.();
    expect(await c.deps.db.db.selectFrom('sessions').select('id_hash').execute()).toEqual([]);
  });

  test('setupOwner creates the owner through the HTTP flow', async () => {
    const c = await start();
    const { me, cookie } = await setupOwner(c);
    expect(me).toMatchObject({
      kind: 'owner',
      name: 'Ada',
      credentials: { password: true, passkeys: 0 },
    });
    expect((await c.request('/api/v1/me', apiInit(c, { cookie }))).status).toBe(200);
  });

  test('setupOwner with only a passkey leaves the owner without a password', async () => {
    const c = await start();
    const passkey = new SoftAuthenticator({ origin: c.deps.config.publicOrigin });
    const { me } = await setupOwner(c, { name: 'Bao', passkey });
    expect(me).toMatchObject({ name: 'Bao', credentials: { password: false, passkeys: 1 } });
  });

  test('startAuth prints nothing once the owner exists', async () => {
    const c = await start();
    const token = await newToken(c);
    await setup(c, { token, name: 'Ada', password: PASSWORD });
    expect(await startAuth(c.deps)).toBeNull();
  });
});
