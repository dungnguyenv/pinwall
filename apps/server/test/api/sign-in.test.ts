import { CeremonyOptions, Me } from '@pinwall/shared';
import {
  generateRegistrationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { afterEach, describe, expect, test } from 'vitest';
import { insertPasskey } from '../../src/auth/passkeys.ts';
import { beginRegistration, finishRegistration } from '../../src/auth/webauthn.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret } from '../../src/lib/ids.ts';
import {
  apiInit,
  createSignedInUser,
  createUserToken,
  sessionCookieFrom,
  setupOwner,
} from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { SoftAuthenticator } from '../helpers/soft-authenticator.ts';

const T = Date.UTC(2026, 10, 10);
const PASSWORD = 'correct horse battery';

describe.each(dialects)('owner sign-in on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(() => ctx.close());

  async function start(env: Record<string, string> = {}): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    return ctx;
  }

  const signIn = (
    pw: unknown,
    o: { cookie?: string; bearer?: string; headers?: Record<string, string> } = {},
  ) =>
    ctx.request(
      '/api/v1/auth/password/sign-in',
      apiInit(ctx, { body: pw === undefined ? {} : { password: pw }, ...o }),
    );
  const passkeyOptionsRequest = () =>
    ctx.request('/api/v1/auth/passkey/options', apiInit(ctx, { method: 'POST' }));
  async function passkeyOptions() {
    const r = await passkeyOptionsRequest();
    expect(r.status).toBe(200);
    const body = CeremonyOptions.parse(await r.json());
    return {
      ceremonyId: body.ceremony_id,
      options: body.options as unknown as PublicKeyCredentialRequestOptionsJSON,
    };
  }
  const passkeySignIn = (body: unknown) =>
    ctx.request('/api/v1/auth/passkey/sign-in', apiInit(ctx, { body }));

  const errorOf = async (r: Response) => ((await r.json()) as { error: unknown }).error;
  const sessions = () => ctx.deps.db.db.selectFrom('sessions').selectAll().execute();
  // The owner is always an admin and cannot be blocked, so access is lost by being disabled.
  const disable = (id: string) =>
    ctx.deps.db.db
      .updateTable('users')
      .set({ disabled_at: clock.now(), disabled_reason: 'test' })
      .where('id', '=', id)
      .execute();

  test('password sign-in returns the owner and a session', async () => {
    await start();
    const { me: owner } = await setupOwner(ctx, { password: PASSWORD });
    clock.advance(60_000);
    const r = await signIn(PASSWORD);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const me = Me.parse(await r.json());
    expect(me).toEqual({ ...owner, via: 'session' });

    const cookie = sessionCookieFrom(r);
    expect(cookie).toMatch(/^pinwall_session=[A-Za-z0-9_-]{43}$/);
    const check = await ctx.request('/api/v1/me', apiInit(ctx, { cookie: cookie ?? '' }));
    expect(check.status).toBe(200);
    const secret = cookie?.split('=')[1] ?? '';
    const row = (await sessions()).find((s) => s.id_hash === hashSecret(secret));
    expect(row).toMatchObject({
      user_id: owner.id,
      auth_method: 'password',
      created_at: T + 60_000,
    });
  });

  test('a wrong password is invalid_credentials and sets no cookie', async () => {
    await start();
    await setupOwner(ctx, { password: PASSWORD });
    const r = await signIn('correct horse battery!');
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toEqual({
      code: 'invalid_credentials',
      message: t('auth.wrongPassword'),
    });
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  test('sign-in before setup is setup_required', async () => {
    await start();
    for (const r of [await signIn(PASSWORD), await passkeyOptionsRequest()]) {
      expect(r.status).toBe(409);
      expect(await errorOf(r)).toEqual({
        code: 'setup_required',
        message: t('auth.setup.required'),
      });
    }
  });

  test('a passkey-only owner cannot sign in by password', async () => {
    await start();
    await setupOwner(ctx, {
      passkey: new SoftAuthenticator({ origin: ctx.deps.config.publicOrigin }),
    });
    const r = await signIn(PASSWORD);
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toMatchObject({ code: 'invalid_credentials' });
  });

  test('sign-in replaces the session presented with the request', async () => {
    await start();
    const { cookie: a } = await setupOwner(ctx, { password: PASSWORD });
    const r = await signIn(PASSWORD, { cookie: a });
    expect(r.status).toBe(200);
    const b = sessionCookieFrom(r);
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
    const hashes = (await sessions()).map((s) => s.id_hash);
    expect(hashes).not.toContain(hashSecret(a.split('=')[1] ?? ''));
    expect(hashes).toEqual([hashSecret(b?.split('=')[1] ?? '')]);
    expect((await ctx.request('/api/v1/me', apiInit(ctx, { cookie: a }))).status).toBe(401);
  });

  test('a bearer request never has its session cookie read or ended', async () => {
    await start();
    const { me: owner, cookie: a } = await setupOwner(ctx, { password: PASSWORD });
    const bearer = await createUserToken(ctx, owner.id);
    const r = await signIn(PASSWORD, { bearer, cookie: a });
    expect(r.status).toBe(200);
    const b = sessionCookieFrom(r);
    expect(b).not.toBeNull();

    // The session the request carried is untouched; the sign-in made a second one.
    const hashes = (await sessions()).map((s) => s.id_hash);
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain(hashSecret(a.split('=')[1] ?? ''));
    expect(hashes).toContain(hashSecret(b?.split('=')[1] ?? ''));
    expect((await ctx.request('/api/v1/me', apiInit(ctx, { cookie: a }))).status).toBe(200);
  });

  test('passkey sign-in', async () => {
    await start();
    const a = new SoftAuthenticator({ origin: ctx.deps.config.publicOrigin });
    const { me: owner } = await setupOwner(ctx, { passkey: a });
    clock.advance(60_000);

    const { ceremonyId, options } = await passkeyOptions();
    expect(options.allowCredentials).toBeUndefined();
    expect(options.rpId).toBe('localhost');
    const r = await passkeySignIn({ ceremony_id: ceremonyId, response: a.authenticate(options) });
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json())).toEqual({ ...owner, via: 'session' });
    expect(sessionCookieFrom(r)).not.toBeNull();

    const { db } = ctx.deps.db;
    const passkey = await db.selectFrom('passkeys').selectAll().executeTakeFirstOrThrow();
    expect(passkey).toMatchObject({ counter: 1, last_used_at: T + 60_000 });
    const methods = (await sessions()).map((s) => s.auth_method).sort();
    expect(methods).toEqual(['passkey', 'passkey']); // setup's session and this one
  });

  test('a replayed passkey assertion is refused', async () => {
    await start();
    const a = new SoftAuthenticator({ origin: ctx.deps.config.publicOrigin });
    await setupOwner(ctx, { passkey: a });
    const { ceremonyId, options } = await passkeyOptions();
    const body = { ceremony_id: ceremonyId, response: a.authenticate(options) };
    expect((await passkeySignIn(body)).status).toBe(200);
    const replay = await passkeySignIn(body);
    expect(replay.status).toBe(401);
    expect(await errorOf(replay)).toEqual({
      code: 'invalid_credentials',
      message: t('auth.passkeyFailed'),
    });
    expect(replay.headers.getSetCookie()).toEqual([]);
  });

  test('an unknown passkey is refused', async () => {
    await start();
    await setupOwner(ctx, { password: PASSWORD });
    const stranger = new SoftAuthenticator({ origin: ctx.deps.config.publicOrigin });
    stranger.register(
      await generateRegistrationOptions({
        rpName: 'Pinwall',
        rpID: 'localhost',
        userName: 'stranger',
        userID: new TextEncoder().encode('usr_stranger'),
        supportedAlgorithmIDs: [-7],
      }),
    );
    const { ceremonyId, options } = await passkeyOptions();
    const r = await passkeySignIn({
      ceremony_id: ceremonyId,
      response: stranger.authenticate(options),
    });
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toMatchObject({ code: 'invalid_credentials' });
  });

  test("another user's passkey does not open the owner account", async () => {
    await start();
    await setupOwner(ctx, { password: PASSWORD });
    const { user } = await createSignedInUser(ctx, { kind: 'oidc' });
    const b = new SoftAuthenticator({ origin: ctx.deps.config.publicOrigin });
    const begun = await beginRegistration(ctx.deps, {
      purpose: 'add',
      userId: user.id,
      userName: 'Bao',
      displayName: 'Bao',
      exclude: [],
    });
    const registration = await finishRegistration(ctx.deps, {
      purpose: 'add',
      ceremonyId: begun.ceremonyId,
      userId: user.id,
      response: b.register(begun.options),
    });
    await insertPasskey(ctx.deps.db.db, { ...registration, name: 'Key', now: T });

    const { ceremonyId, options } = await passkeyOptions();
    const r = await passkeySignIn({ ceremony_id: ceremonyId, response: b.authenticate(options) });
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toEqual({
      code: 'invalid_credentials',
      message: t('auth.passkeyFailed'),
    });
    expect(sessionCookieFrom(r)).toBeNull();
  });

  test('an owner without access cannot sign in', async () => {
    await start();
    const a = new SoftAuthenticator({ origin: ctx.deps.config.publicOrigin });
    const { me } = await setupOwner(ctx, { password: PASSWORD, passkey: a });
    await disable(me.id);

    const byPassword = await signIn(PASSWORD);
    expect(byPassword.status).toBe(403);
    expect(await errorOf(byPassword)).toEqual({
      code: 'access_denied',
      message: t('auth.accessDenied'),
    });
    const { ceremonyId, options } = await passkeyOptions();
    const byPasskey = await passkeySignIn({
      ceremony_id: ceremonyId,
      response: a.authenticate(options),
    });
    expect(byPasskey.status).toBe(403);
    expect(await errorOf(byPasskey)).toMatchObject({ code: 'access_denied' });
    for (const r of [byPassword, byPasskey]) expect(sessionCookieFrom(r)).toBeNull();

    // A wrong password does not reveal that the account is blocked.
    expect((await signIn('not the password')).status).toBe(401);
  });

  test('password in another Unicode form still signs in', async () => {
    await start();
    const pw = 'Mật khẩu của tôi ２０２６';
    await setupOwner(ctx, { password: pw.normalize('NFD') });
    for (const v of [pw.normalize('NFC'), 'Mật khẩu của tôi 2026']) {
      expect((await signIn(v)).status).toBe(200);
    }
  });

  test('password sign-in is rate limited per IP', async () => {
    await start({ PINWALL_TRUST_PROXY: 'true' });
    await setupOwner(ctx, { password: PASSWORD });
    const from = (ip: string, pw = 'wrong password') =>
      signIn(pw, { headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 10; i++) expect((await from('203.0.113.7')).status).toBe(401);

    const refused = await from('203.0.113.7', PASSWORD);
    expect(refused.status).toBe(429);
    expect(await errorOf(refused)).toMatchObject({ code: 'rate_limited' });
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(900);

    expect((await from('203.0.113.8')).status).toBe(401);
  });

  test('password sign-in also has a global limit', async () => {
    await start();
    await setupOwner(ctx, { password: PASSWORD });
    for (let i = 0; i < 100; i++) {
      await ctx.deps.rateLimiter.consume('password-global:all', 100, 3_600_000);
    }
    const r = await signIn(PASSWORD);
    expect(r.status).toBe(429);
    expect(await errorOf(r)).toMatchObject({ code: 'rate_limited' });
  });

  test('passkey endpoints are rate limited per IP', async () => {
    await start();
    await setupOwner(ctx, { password: PASSWORD });
    for (let i = 0; i < 30; i++) expect((await passkeyOptionsRequest()).status).toBe(200);
    const r = await passkeyOptionsRequest();
    expect(r.status).toBe(429);
    const signInRefused = await passkeySignIn({ ceremony_id: 'x', response: {} });
    expect(signInRefused.status).toBe(429);
  });

  test('a missing password is bad_request with issues', async () => {
    await start();
    const r = await signIn(undefined);
    expect(r.status).toBe(400);
    const error = (await errorOf(r)) as { code: string; details: { issues: { path: string }[] } };
    expect(error.code).toBe('bad_request');
    expect(error.details.issues[0]?.path).toBe('password');
  });

  test('a malformed passkey response is bad_request', async () => {
    await start();
    await setupOwner(ctx, { password: PASSWORD });
    const r = await passkeySignIn({ ceremony_id: 'x', response: { id: 'y' } });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toMatchObject({ code: 'bad_request' });
  });

  test('passkey sign-in is unavailable on a plain-http named origin', async () => {
    await start({ PINWALL_PUBLIC_ORIGIN: 'http://pinwall.lan:8080' });
    await setupOwner(ctx, { password: PASSWORD });
    const r = await passkeyOptionsRequest();
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toEqual({
      code: 'bad_request',
      message: t('auth.passkeysUnavailable'),
    });
  });
});
