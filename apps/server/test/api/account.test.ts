import { setTimeout as sleep } from 'node:timers/promises';
import { CeremonyOptions, Me, Passkey, PasskeyList } from '@pinwall/shared';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { afterEach, describe, expect, test } from 'vitest';
import { lockUser } from '../../src/auth/account.ts';
import { insertPasskey } from '../../src/auth/passkeys.ts';
import { RATE_RULES } from '../../src/auth/rate-limits.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
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
const NEW_PASSWORD = 'a brand new passphrase';

describe.each(dialects)('owner account on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(() => ctx.close());

  async function start(env: Record<string, string> = {}): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    return ctx;
  }

  const authenticator = () => new SoftAuthenticator({ origin: ctx.deps.config.publicOrigin });

  const call = (
    method: string,
    path: string,
    o: { cookie?: string; bearer?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => ctx.request(`/api/v1${path}`, apiInit(ctx, { method, ...o }));
  const errorOf = async (r: Response) => ((await r.json()) as { error: unknown }).error;

  const meOf = async (cookie: string) => {
    const r = await call('GET', '/me', { cookie });
    expect(r.status).toBe(200);
    return Me.parse(await r.json());
  };
  const passkeysOf = async (cookie: string) => {
    const r = await call('GET', '/me/passkeys', { cookie });
    expect(r.status).toBe(200);
    return PasskeyList.parse(await r.json()).items;
  };
  const signIn = (password: string) =>
    call('POST', '/auth/password/sign-in', { body: { password } });

  /** Signs in by passkey through the real endpoints. */
  async function signInWithPasskey(a: SoftAuthenticator): Promise<Response> {
    const begun = await call('POST', '/auth/passkey/options');
    const ceremony = CeremonyOptions.parse(await begun.json());
    const options = ceremony.options as unknown as PublicKeyCredentialRequestOptionsJSON;
    return call('POST', '/auth/passkey/sign-in', {
      body: { ceremony_id: ceremony.ceremony_id, response: a.authenticate(options) },
    });
  }

  async function beginAdd(cookie: string) {
    const r = await call('POST', '/me/passkeys/options', { cookie });
    expect(r.status).toBe(200);
    const body = CeremonyOptions.parse(await r.json());
    return {
      ceremonyId: body.ceremony_id,
      options: body.options as unknown as PublicKeyCredentialCreationOptionsJSON,
    };
  }
  async function addPasskey(cookie: string, a: SoftAuthenticator, name?: string) {
    const { ceremonyId, options } = await beginAdd(cookie);
    return call('POST', '/me/passkeys', {
      cookie,
      body: {
        ceremony_id: ceremonyId,
        response: a.register(options),
        ...(name === undefined ? {} : { name }),
      },
    });
  }

  /** The owner with a password and one passkey, as setup leaves them. */
  async function ownerWithBoth() {
    const a = authenticator();
    const owner = await setupOwner(ctx, { password: PASSWORD, passkey: a });
    return { ...owner, a };
  }

  /** Every account route, with a body that would be valid for it. */
  const accountRoutes: { method: string; path: string; body?: unknown; session: boolean }[] = [
    { method: 'PATCH', path: '/me', body: { name: 'New' }, session: false },
    { method: 'GET', path: '/me/passkeys', session: false },
    { method: 'PUT', path: '/me/password', body: { new_password: NEW_PASSWORD }, session: true },
    { method: 'DELETE', path: '/me/password', session: true },
    { method: 'POST', path: '/me/passkeys/options', session: true },
    { method: 'POST', path: '/me/passkeys', body: { ceremony_id: 'c' }, session: true },
    { method: 'PATCH', path: '/me/passkeys/pky_x', body: { name: 'New' }, session: true },
    { method: 'DELETE', path: '/me/passkeys/pky_x', session: true },
  ];

  test('the owner updates name and email', async () => {
    await start();
    const { me, cookie } = await setupOwner(ctx, { password: PASSWORD });
    expect(me.email).toBeNull();

    const first = await call('PATCH', '/me', { cookie, body: { email: 'ada@example.test' } });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(Me.parse(await first.json())).toMatchObject({ name: 'Ada', email: 'ada@example.test' });

    const r = await call('PATCH', '/me', { cookie, body: { name: ' Ada L. ', email: null } });
    expect(r.status).toBe(200);
    const body = Me.parse(await r.json());
    expect(body).toMatchObject({ id: me.id, name: 'Ada L.', email: null, via: 'session' });
    expect(body.credentials).toEqual({ password: true, passkeys: 0 });
    expect(await meOf(cookie)).toEqual(body);
    const row = await ctx.deps.db.db
      .selectFrom('users')
      .select(['name', 'email'])
      .where('id', '=', me.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ name: 'Ada L.', email: null });
  });

  test('an omitted field is left as it was', async () => {
    await start();
    const { cookie } = await setupOwner(ctx, { password: PASSWORD });
    await call('PATCH', '/me', { cookie, body: { email: 'ada@example.test' } });
    const nameOnly = await call('PATCH', '/me', { cookie, body: { name: 'Ada B.' } });
    expect(Me.parse(await nameOnly.json())).toMatchObject({
      name: 'Ada B.',
      email: 'ada@example.test',
    });
    const nothing = await call('PATCH', '/me', { cookie, body: {} });
    expect(nothing.status).toBe(200);
    expect(Me.parse(await nothing.json())).toMatchObject({
      name: 'Ada B.',
      email: 'ada@example.test',
    });
  });

  test('a bad name or email is bad_request and changes nothing', async () => {
    await start();
    const { cookie } = await setupOwner(ctx, { password: PASSWORD });
    const bodies = [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 7 },
      { email: 'not an email' },
      { email: `${'a'.repeat(250)}@example.test` },
      { email: '' },
    ];
    for (const body of bodies) {
      const r = await call('PATCH', '/me', { cookie, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await errorOf(r)).toMatchObject({ code: 'bad_request' });
    }
    expect(await meOf(cookie)).toMatchObject({ name: 'Ada', email: null });
  });

  test('an API token may update the profile, since it needs no credential', async () => {
    await start();
    const { me } = await setupOwner(ctx, { password: PASSWORD });
    const bearer = await createUserToken(ctx, me.id);
    const r = await call('PATCH', '/me', { bearer, body: { name: 'Via token' } });
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json())).toMatchObject({ name: 'Via token', via: 'api_token' });
  });

  test('account routes are owner-only', async () => {
    await start();
    const { cookie } = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bao' });
    for (const { method, path, body } of accountRoutes) {
      const r = await call(method, path, { cookie, body });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await errorOf(r), `${method} ${path}`).toEqual({
        code: 'forbidden',
        message: t('auth.ownerOnly'),
      });
    }
  });

  test('account routes need a sign-in', async () => {
    await start();
    for (const { method, path, body } of accountRoutes) {
      const r = await call(method, path, { body });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(await errorOf(r)).toEqual({ code: 'unauthorized', message: t('auth.signInRequired') });
    }
  });

  test('credential changes need a browser session', async () => {
    await start();
    const { me, cookie } = await ownerWithBoth();
    const bearer = await createUserToken(ctx, me.id);
    const passkeyId = (await passkeysOf(cookie))[0]?.id ?? '';
    for (const { method, path, body, session } of accountRoutes) {
      if (!session) continue;
      const r = await call(method, path.replace('pky_x', passkeyId), { bearer, body });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(await errorOf(r), `${method} ${path}`).toEqual({
        code: 'forbidden',
        message: t('auth.sessionRequired'),
      });
    }
    // Nothing changed, and reading the list is fine with a token.
    expect(await meOf(cookie)).toMatchObject({ credentials: { password: true, passkeys: 1 } });
    expect((await signIn(PASSWORD)).status).toBe(200);
    const listed = await call('GET', '/me/passkeys', { bearer });
    expect(listed.status).toBe(200);
    expect(PasskeyList.parse(await listed.json()).items).toHaveLength(1);
  });

  test('a cookie request from another origin changes nothing', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const passkeyId = (await passkeysOf(cookie))[0]?.id ?? '';
    for (const { method, path, body } of accountRoutes) {
      if (method === 'GET') continue; // reads change nothing, and the check is for writes
      const r = await ctx.request(
        `/api/v1${path.replace('pky_x', passkeyId)}`,
        apiInit(ctx, { method, cookie, body, origin: 'https://evil.example' }),
      );
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(await meOf(cookie)).toMatchObject({
      name: 'Ada',
      credentials: { password: true, passkeys: 1 },
    });
    expect((await signIn(PASSWORD)).status).toBe(200);
  });

  test('changing the password ends other sessions and keeps this one', async () => {
    await start();
    const { me, cookie: s1 } = await setupOwner(ctx, { password: PASSWORD });
    const second = await signIn(PASSWORD);
    expect(second.status).toBe(200);
    const s2 = sessionCookieFrom(second) ?? '';
    expect(s2).not.toBe(s1);
    const bearer = await createUserToken(ctx, me.id);

    const r = await call('PUT', '/me/password', {
      cookie: s1,
      body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect((await call('GET', '/me', { cookie: s2 })).status).toBe(401);
    expect((await call('GET', '/me', { cookie: s1 })).status).toBe(200);
    const sessions = await ctx.deps.db.db.selectFrom('sessions').select('user_id').execute();
    expect(sessions).toEqual([{ user_id: me.id }]);

    expect((await signIn(PASSWORD)).status).toBe(401);
    expect((await signIn(NEW_PASSWORD)).status).toBe(200);
    // API tokens are separate credentials and stay valid.
    expect((await call('GET', '/me', { bearer })).status).toBe(200);
  });

  test('the new password is stored in its normalized form', async () => {
    await start();
    const { cookie } = await setupOwner(ctx, { password: PASSWORD });
    const typed = 'Mật khẩu mới của tôi ２０２６'.normalize('NFD');
    const r = await call('PUT', '/me/password', {
      cookie,
      body: { current_password: PASSWORD, new_password: typed },
    });
    expect(r.status).toBe(204);
    expect((await signIn('Mật khẩu mới của tôi 2026'.normalize('NFC'))).status).toBe(200);
  });

  test('a wrong current password is refused', async () => {
    await start();
    const { cookie: s1 } = await setupOwner(ctx, { password: PASSWORD });
    const s2 = sessionCookieFrom(await signIn(PASSWORD)) ?? '';

    const bodies = [
      { current_password: 'not the password', new_password: NEW_PASSWORD },
      { new_password: NEW_PASSWORD }, // a password exists, so the current one is required
    ];
    for (const body of bodies) {
      const r = await call('PUT', '/me/password', { cookie: s1, body });
      expect(r.status).toBe(401);
      expect(await errorOf(r)).toEqual({
        code: 'invalid_credentials',
        message: t('auth.wrongPassword'),
      });
    }
    // Nothing happened: same password, other session alive.
    expect((await signIn(PASSWORD)).status).toBe(200);
    expect((await signIn(NEW_PASSWORD)).status).toBe(401);
    expect((await call('GET', '/me', { cookie: s2 })).status).toBe(200);
  });

  test('a passkey-only owner adds a password without a current one', async () => {
    await start();
    const { cookie } = await setupOwner(ctx, { passkey: authenticator() });
    expect(await meOf(cookie)).toMatchObject({ credentials: { password: false, passkeys: 1 } });
    expect((await signIn(NEW_PASSWORD)).status).toBe(401);

    const r = await call('PUT', '/me/password', { cookie, body: { new_password: NEW_PASSWORD } });
    expect(r.status).toBe(204);
    expect(await meOf(cookie)).toMatchObject({ credentials: { password: true, passkeys: 1 } });
    expect((await signIn(NEW_PASSWORD)).status).toBe(200);

    // From now on the password protects itself: changing it needs the current one.
    const again = await call('PUT', '/me/password', {
      cookie,
      body: { new_password: 'yet another passphrase' },
    });
    expect(again.status).toBe(401);
  });

  test('the new password policy applies', async () => {
    await start();
    const { cookie: s1 } = await setupOwner(ctx, { password: PASSWORD });
    const s2 = sessionCookieFrom(await signIn(PASSWORD)) ?? '';

    const short = await call('PUT', '/me/password', {
      cookie: s1,
      body: { current_password: PASSWORD, new_password: 'short' },
    });
    expect(short.status).toBe(400);
    expect(await errorOf(short)).toMatchObject({
      code: 'bad_request',
      message: t('auth.passwordTooShort', { min: 12 }),
    });
    const long = await call('PUT', '/me/password', {
      cookie: s1,
      body: { current_password: PASSWORD, new_password: 'x'.repeat(257) },
    });
    expect(long.status).toBe(400);
    expect(await errorOf(long)).toMatchObject({ message: t('auth.passwordTooLong', { max: 256 }) });
    const empty = await call('PUT', '/me/password', {
      cookie: s1,
      body: { current_password: PASSWORD, new_password: '' },
    });
    expect(empty.status).toBe(400);

    // A refused change ends no session and changes no password.
    expect((await signIn(PASSWORD)).status).toBe(200);
    expect((await call('GET', '/me', { cookie: s2 })).status).toBe(200);
  });

  test('a short first password is refused for a passkey-only owner too', async () => {
    await start();
    const { cookie } = await setupOwner(ctx, { passkey: authenticator() });
    const r = await call('PUT', '/me/password', { cookie, body: { new_password: 'short' } });
    expect(r.status).toBe(400);
    expect(await meOf(cookie)).toMatchObject({ credentials: { password: false } });
  });

  test('changing the password is rate limited like sign-in', async () => {
    await start({ PINWALL_TRUST_PROXY: 'true' });
    const { cookie } = await setupOwner(ctx, { password: PASSWORD });
    const guess = (ip: string, current = 'wrong password') =>
      call('PUT', '/me/password', {
        cookie,
        headers: { 'x-forwarded-for': ip },
        body: { current_password: current, new_password: NEW_PASSWORD },
      });
    for (let i = 0; i < RATE_RULES.password.limit; i++) {
      expect((await guess('203.0.113.7')).status).toBe(401);
    }
    const refused = await guess('203.0.113.7', PASSWORD);
    expect(refused.status).toBe(429);
    expect(await errorOf(refused)).toMatchObject({ code: 'rate_limited' });
    expect((await signIn(PASSWORD)).status).toBe(200); // the password did not change
    expect((await guess('203.0.113.8', PASSWORD)).status).toBe(204);
  });

  test('add, list, rename and delete passkeys', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    clock.advance(1000);
    const added = await addPasskey(cookie, authenticator(), 'Phone');
    expect(added.status).toBe(201);
    expect(added.headers.get('cache-control')).toBe('no-store');
    const created = Passkey.parse(await added.json());
    expect(created).toEqual({
      id: expect.stringMatching(/^pky_/),
      name: 'Phone',
      transports: ['internal'],
      created_at: clock.now(),
      last_used_at: null,
    });
    expect(Object.keys(created).sort()).toEqual([
      'created_at',
      'id',
      'last_used_at',
      'name',
      'transports',
    ]);

    const listed = await call('GET', '/me/passkeys', { cookie });
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const body = PasskeyList.parse(await listed.json());
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((p) => p.name)).toEqual(['Passkey 1', 'Phone']); // oldest first
    expect(await meOf(cookie)).toMatchObject({ credentials: { password: true, passkeys: 2 } });

    const renamed = await call('PATCH', `/me/passkeys/${created.id}`, {
      cookie,
      body: { name: ' Work phone ' },
    });
    expect(renamed.status).toBe(200);
    expect(Passkey.parse(await renamed.json())).toEqual({ ...created, name: 'Work phone' });
    expect((await passkeysOf(cookie)).map((p) => p.name)).toEqual(['Passkey 1', 'Work phone']);

    const removed = await call('DELETE', `/me/passkeys/${created.id}`, { cookie });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect((await passkeysOf(cookie)).map((p) => p.name)).toEqual(['Passkey 1']);
  });

  test('a passkey added here signs in', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const phone = authenticator();
    expect((await addPasskey(cookie, phone, 'Phone')).status).toBe(201);
    const r = await signInWithPasskey(phone);
    expect(r.status).toBe(200);
    expect(Me.parse(await r.json()).kind).toBe('owner');
  });

  test('a passkey without a name is called "Passkey <count + 1>"', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    clock.advance(1000);
    const second = Passkey.parse(await (await addPasskey(cookie, authenticator())).json());
    clock.advance(1000);
    const third = Passkey.parse(await (await addPasskey(cookie, authenticator())).json());
    expect([second.name, third.name]).toEqual(['Passkey 2', 'Passkey 3']);
  });

  test('the add ceremony excludes registered passkeys', async () => {
    await start();
    const { cookie, a } = await ownerWithBoth();
    clock.advance(1000);
    await addPasskey(cookie, authenticator(), 'Phone');

    const { options } = await beginAdd(cookie);
    const stored = await ctx.deps.db.db.selectFrom('passkeys').select('credential_id').execute();
    expect(options.excludeCredentials?.map((c) => c.id).sort()).toEqual(
      stored.map((row) => row.credential_id).sort(),
    );
    expect(options.excludeCredentials).toHaveLength(2);
    expect(options.rp).toMatchObject({ id: 'localhost', name: 'Pinwall' });
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    // The user handle is the owner's id, as for the passkey made at setup.
    const me = await meOf(cookie);
    expect(Buffer.from(options.user.id, 'base64url').toString('utf8')).toBe(me.id);
    // An authenticator that already holds one of them refuses to register again.
    expect(() => a.register(options)).toThrow(/InvalidStateError/);
  });

  test('a registration ceremony finishes once', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const { ceremonyId, options } = await beginAdd(cookie);
    const body = { ceremony_id: ceremonyId, response: authenticator().register(options) };
    expect((await call('POST', '/me/passkeys', { cookie, body })).status).toBe(201);
    const replay = await call('POST', '/me/passkeys', { cookie, body });
    expect(replay.status).toBe(401);
    expect(await errorOf(replay)).toEqual({
      code: 'invalid_credentials',
      message: t('auth.passkeyFailed'),
    });
    expect(await passkeysOf(cookie)).toHaveLength(2);
  });

  test('a registration from another origin is refused and stores nothing', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const { ceremonyId, options } = await beginAdd(cookie);
    const response = authenticator().register(options, { origin: 'https://evil.example' });
    const r = await call('POST', '/me/passkeys', {
      cookie,
      body: { ceremony_id: ceremonyId, response, name: 'Phone' },
    });
    expect(r.status).toBe(401);
    expect(await errorOf(r)).toMatchObject({ code: 'invalid_credentials' });
    expect(await passkeysOf(cookie)).toHaveLength(1);
  });

  test('an unknown ceremony is refused', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const { options } = await beginAdd(cookie);
    const r = await call('POST', '/me/passkeys', {
      cookie,
      body: { ceremony_id: 'no-such-ceremony', response: authenticator().register(options) },
    });
    expect(r.status).toBe(401);
    expect(await passkeysOf(cookie)).toHaveLength(1);
  });

  test('a credential that is registered already is a conflict', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const { ceremonyId, options } = await beginAdd(cookie);
    const response = authenticator().register(options);
    const { user: other } = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bao' });
    await insertPasskey(ctx.deps.db.db, {
      userId: other.id,
      credentialId: response.id,
      publicKey: 'pk',
      counter: 0,
      transports: [],
      name: 'Theirs',
      now: T,
    });
    const r = await call('POST', '/me/passkeys', {
      cookie,
      body: { ceremony_id: ceremonyId, response },
    });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({ code: 'conflict', message: t('auth.passkeyDuplicate') });
    expect(await passkeysOf(cookie)).toHaveLength(1);
  });

  test('a bad passkey name or body is bad_request', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const id = (await passkeysOf(cookie))[0]?.id ?? '';
    for (const name of ['', '   ', 'x'.repeat(101), 5]) {
      const r = await call('PATCH', `/me/passkeys/${id}`, { cookie, body: { name } });
      expect(r.status, String(name)).toBe(400);
    }
    const noResponse = await call('POST', '/me/passkeys', { cookie, body: { ceremony_id: 'c' } });
    expect(noResponse.status).toBe(400);
    expect((await passkeysOf(cookie))[0]?.name).toBe('Passkey 1');
  });

  test('passkeys cannot be added where browsers refuse them', async () => {
    await start({ PINWALL_PUBLIC_ORIGIN: 'http://pinwall.lan:8080' });
    const { cookie } = await setupOwner(ctx, { password: PASSWORD });
    const r = await call('POST', '/me/passkeys/options', { cookie });
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toEqual({
      code: 'bad_request',
      message: t('auth.passkeysUnavailable'),
    });
  });

  test('the last credential cannot be removed: password and one passkey', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const id = (await passkeysOf(cookie))[0]?.id ?? '';
    expect((await call('DELETE', `/me/passkeys/${id}`, { cookie })).status).toBe(204);

    const r = await call('DELETE', '/me/password', { cookie });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({ code: 'conflict', message: t('auth.lastCredential') });
    expect(await meOf(cookie)).toMatchObject({ credentials: { password: true, passkeys: 0 } });
    expect((await signIn(PASSWORD)).status).toBe(200);
  });

  test('the last credential cannot be removed: the passkey after the password', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    expect((await call('DELETE', '/me/password', { cookie })).status).toBe(204);
    expect(await meOf(cookie)).toMatchObject({ credentials: { password: false, passkeys: 1 } });
    expect((await signIn(PASSWORD)).status).toBe(401);

    const id = (await passkeysOf(cookie))[0]?.id ?? '';
    const r = await call('DELETE', `/me/passkeys/${id}`, { cookie });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({ code: 'conflict', message: t('auth.lastCredential') });
    expect(await passkeysOf(cookie)).toHaveLength(1);
  });

  test('the last credential cannot be removed: two passkeys and no password', async () => {
    await start();
    const { cookie } = await setupOwner(ctx, { passkey: authenticator() });
    clock.advance(1000);
    expect((await addPasskey(cookie, authenticator(), 'Phone')).status).toBe(201);
    const [first, second] = await passkeysOf(cookie);

    expect((await call('DELETE', `/me/passkeys/${first?.id}`, { cookie })).status).toBe(204);
    const r = await call('DELETE', `/me/passkeys/${second?.id}`, { cookie });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({ code: 'conflict', message: t('auth.lastCredential') });
    expect((await passkeysOf(cookie)).map((p) => p.id)).toEqual([second?.id]);
  });

  test('removing a password the owner does not have changes nothing', async () => {
    await start();
    const { cookie } = await setupOwner(ctx, { passkey: authenticator() });
    expect((await call('DELETE', '/me/password', { cookie })).status).toBe(204);
    expect(await meOf(cookie)).toMatchObject({ credentials: { password: false, passkeys: 1 } });
  });

  test('two concurrent removals cannot leave the owner without a credential', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const id = (await passkeysOf(cookie))[0]?.id ?? '';
    const results = await Promise.all([
      call('DELETE', '/me/password', { cookie }),
      call('DELETE', `/me/passkeys/${id}`, { cookie }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    const { credentials } = await meOf(cookie);
    expect((credentials?.password ? 1 : 0) + (credentials?.passkeys ?? 0)).toBe(1);
  });

  test('lockUser makes a second transaction on the same user wait', async () => {
    await start();
    const { me } = await setupOwner(ctx, { password: PASSWORD });
    const { db, dialect: kind } = ctx.deps.db;
    const events: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked = () => {};
    const firstLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const first = db.transaction().execute(async (trx) => {
      await lockUser(trx, kind, me.id);
      events.push('first locked');
      signalLocked();
      await held;
      events.push('first done');
    });
    await firstLocked;
    const second = db.transaction().execute(async (trx) => {
      await lockUser(trx, kind, me.id);
      events.push('second locked');
    });
    try {
      await sleep(150); // time enough for the second one to get in if nothing held it back
      expect(events).toEqual(['first locked']);
    } finally {
      release(); // also when the expectation failed, so the transaction does not hang
    }
    await Promise.all([first, second]);
    expect(events).toEqual(['first locked', 'first done', 'second locked']);
  });

  test('an unknown passkey id is not_found', async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const rename = await call('PATCH', '/me/passkeys/pky_doesnotexist', {
      cookie,
      body: { name: 'Gone' },
    });
    expect(rename.status).toBe(404);
    expect(await errorOf(rename)).toEqual({
      code: 'not_found',
      message: t('auth.passkeyNotFound'),
    });
    const remove = await call('DELETE', '/me/passkeys/pky_doesnotexist', { cookie });
    expect(remove.status).toBe(404);
    expect(await errorOf(remove)).toEqual({
      code: 'not_found',
      message: t('auth.passkeyNotFound'),
    });
    expect(await passkeysOf(cookie)).toHaveLength(1);
  });

  test("another user's passkey is not_found and stays untouched", async () => {
    await start();
    const { cookie } = await ownerWithBoth();
    const { user: other } = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bao' });
    const theirs = await insertPasskey(ctx.deps.db.db, {
      userId: other.id,
      credentialId: 'their-credential',
      publicKey: 'pk',
      counter: 0,
      transports: [],
      name: 'Theirs',
      now: T,
    });
    expect(
      (await call('PATCH', `/me/passkeys/${theirs.id}`, { cookie, body: { name: 'x' } })).status,
    ).toBe(404);
    expect((await call('DELETE', `/me/passkeys/${theirs.id}`, { cookie })).status).toBe(404);
    const row = await ctx.deps.db.db
      .selectFrom('passkeys')
      .select('name')
      .where('id', '=', theirs.id)
      .executeTakeFirstOrThrow();
    expect(row.name).toBe('Theirs');
    expect(await passkeysOf(cookie)).toHaveLength(1); // the list holds the owner's own only
  });

  test('the OpenAPI document lists the account routes with their guards', async () => {
    await start();
    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, { security?: unknown }>>;
    };
    const sessionOnly = [{ session: [] }];
    expect(doc.paths['/me']?.patch).toBeDefined();
    expect(doc.paths['/me/password']?.put?.security).toEqual(sessionOnly);
    expect(doc.paths['/me/password']?.delete?.security).toEqual(sessionOnly);
    expect(doc.paths['/me/passkeys']?.get).toBeDefined();
    expect(doc.paths['/me/passkeys']?.post?.security).toEqual(sessionOnly);
    expect(doc.paths['/me/passkeys/options']?.post?.security).toEqual(sessionOnly);
    expect(doc.paths['/me/passkeys/{id}']?.patch?.security).toEqual(sessionOnly);
    expect(doc.paths['/me/passkeys/{id}']?.delete?.security).toEqual(sessionOnly);
  });
});
