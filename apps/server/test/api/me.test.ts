import { Me } from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createSession,
  deleteUserSessions,
  purgeExpiredSessions,
} from '../../src/auth/sessions.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, createSignedInUser, sessionCookieFrom } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const DAY_MS = 86_400_000;
const TTL_S = 30 * 86_400;

describe.each(dialects)('sessions and /me on %s', (dialect) => {
  let ctx: TestContext | undefined;
  let clock: FixedClock;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  async function start(env: Record<string, string> = {}): Promise<TestContext> {
    clock = new FixedClock(Date.UTC(2026, 10, 10));
    ctx = await createTestContext({ dialect, clock, env });
    return ctx;
  }

  const me = (c: TestContext, cookie?: string) =>
    c.request('/api/v1/me', apiInit(c, cookie === undefined ? {} : { cookie }));

  const sessionCount = async (c: TestContext) =>
    (await c.deps.db.db.selectFrom('sessions').select('id_hash').execute()).length;

  /** The Set-Cookie headers that clear the session cookie. */
  const clearedCookies = (r: Response) =>
    r.headers.getSetCookie().filter((sc) => /^(__Host-)?pinwall_session=;/.test(sc));

  test('a session cookie resolves to the user', async () => {
    const c = await start();
    const { user, cookie } = await createSignedInUser(c);
    const r = await me(c, cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body).toEqual({
      id: user.id,
      kind: 'owner',
      name: 'Ada',
      email: null,
      email_verified: false,
      avatar_url: null,
      role: 'admin',
      via: 'session',
      credentials: { password: false, passkeys: 0 },
      created_at: clock.now(),
    });
    expect(Me.parse(body)).toEqual(body);
  });

  test('the credentials block counts the owner password and passkeys', async () => {
    const c = await start();
    const { user, cookie } = await createSignedInUser(c);
    const { db } = c.deps.db;
    await db
      .insertInto('password_credentials')
      .values({ user_id: user.id, hash: 'scrypt$x', updated_at: clock.now() })
      .execute();
    for (const n of [1, 2]) {
      await db
        .insertInto('passkeys')
        .values({
          id: `pky_${n}`,
          user_id: user.id,
          credential_id: `cred-${n}`,
          public_key: 'pk',
          counter: 0,
          transports: '[]',
          name: `Key ${n}`,
          created_at: clock.now(),
        })
        .execute();
    }
    const body = Me.parse(await (await me(c, cookie)).json());
    expect(body.credentials).toEqual({ password: true, passkeys: 2 });
  });

  test('no credentials is 401 unauthorized', async () => {
    const c = await start();
    const r = await me(c);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({
      error: { code: 'unauthorized', message: t('auth.signInRequired') },
    });
  });

  test('an oidc member has role member and no credentials block', async () => {
    const c = await start();
    const { user, cookie } = await createSignedInUser(c, { kind: 'oidc', name: 'Bao' });
    const body = await (await me(c, cookie)).json();
    expect(body).toMatchObject({
      id: user.id,
      kind: 'oidc',
      name: 'Bao',
      email: user.email,
      email_verified: true,
      role: 'member',
      via: 'session',
      credentials: null,
    });
  });

  test('a role override wins over the IdP role', async () => {
    const c = await start();
    const { cookie } = await createSignedInUser(c, {
      kind: 'oidc',
      idpRole: 'member',
      roleOverride: 'admin',
    });
    expect(Me.parse(await (await me(c, cookie)).json()).role).toBe('admin');
  });

  test('the session slides', async () => {
    const c = await start();
    const { cookie } = await createSignedInUser(c);

    clock.advance(29 * DAY_MS);
    const first = await me(c, cookie);
    expect(first.status).toBe(200);
    expect(sessionCookieFrom(first)).toBe(cookie);

    clock.advance(29 * DAY_MS);
    expect((await me(c, cookie)).status).toBe(200);

    clock.advance(30 * DAY_MS + 1);
    const expired = await me(c, cookie);
    expect(expired.status).toBe(401);
    expect(clearedCookies(expired)).toHaveLength(1);
    expect(await sessionCount(c)).toBe(0);
  });

  test('a renewal moves the expiry and records when the user was last seen', async () => {
    const c = await start();
    const { user, cookie } = await createSignedInUser(c);
    clock.advance(300_000);
    await me(c, cookie);
    const { db } = c.deps.db;
    const session = await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(session.last_seen_at).toBe(clock.now());
    expect(session.expires_at).toBe(clock.now() + 30 * DAY_MS);
    const row = await db
      .selectFrom('users')
      .select('last_seen_at')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.last_seen_at).toBe(clock.now());
  });

  test('requests within five minutes do not re-set the cookie', async () => {
    const c = await start();
    const { cookie } = await createSignedInUser(c);
    clock.advance(60_000);
    const r = await me(c, cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  test('refreshed cookie is Secure and __Host- on an https origin although the request is http', async () => {
    const c = await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
    const { cookie } = await createSignedInUser(c);
    clock.advance(300_000);
    const r = await c.app.request('http://internal:8080/api/v1/me', apiInit(c, { cookie }));
    expect(r.status).toBe(200);
    const sc = r.headers.getSetCookie()[0] ?? '';
    expect(sc).toMatch(/^__Host-pinwall_session=[A-Za-z0-9_-]{43};/);
    for (const part of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${TTL_S}`]) {
      expect(sc).toContain(part);
    }
  });

  test('a plain-http origin uses pinwall_session without Secure', async () => {
    const c = await start();
    const { cookie } = await createSignedInUser(c);
    expect(cookie).toMatch(/^pinwall_session=/);
    clock.advance(300_000);
    const r = await me(c, cookie);
    const sc = r.headers.getSetCookie()[0] ?? '';
    expect(sc).toMatch(/^pinwall_session=[A-Za-z0-9_-]{43};/);
    for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${TTL_S}`]) {
      expect(sc).toContain(part);
    }
    expect(sc).not.toContain('Secure');
  });

  test('an https origin ignores a cookie without the __Host- prefix', async () => {
    const c = await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
    const { cookie } = await createSignedInUser(c);
    const unprefixed = cookie.replace(/^__Host-/, '');
    expect((await me(c, unprefixed)).status).toBe(401);
  });

  test('sign-out deletes the session and clears the cookie', async () => {
    const c = await start();
    const { cookie } = await createSignedInUser(c);
    const r = await c.request('/api/v1/auth/sign-out', apiInit(c, { method: 'POST', cookie }));
    expect(r.status).toBe(204);
    const cleared = clearedCookies(r);
    expect(cleared).toHaveLength(1);
    expect(r.headers.getSetCookie()).toHaveLength(1);
    expect(cleared[0]).toContain('Max-Age=0');
    expect(cleared[0]).toContain('Path=/');
    expect((await me(c, cookie)).status).toBe(401);
    expect(await sessionCount(c)).toBe(0);
  });

  test('sign-out sends one Set-Cookie even when the session was due for renewal', async () => {
    const c = await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
    const { cookie } = await createSignedInUser(c);
    clock.advance(300_000);
    const r = await c.request('/api/v1/auth/sign-out', apiInit(c, { method: 'POST', cookie }));
    expect(r.status).toBe(204);
    const all = r.headers.getSetCookie();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatch(/^__Host-pinwall_session=;/);
    for (const part of ['Max-Age=0', 'Secure', 'Path=/']) expect(all[0]).toContain(part);
    expect(await sessionCount(c)).toBe(0);
  });

  test('sign-out without a session is 204', async () => {
    const c = await start();
    const r = await c.request('/api/v1/auth/sign-out', apiInit(c, { method: 'POST' }));
    expect(r.status).toBe(204);
    expect(clearedCookies(r)).toHaveLength(1);
  });

  test('an unknown session cookie is cleared', async () => {
    const c = await start();
    const r = await me(c, `pinwall_session=${'A'.repeat(43)}`);
    expect(r.status).toBe(401);
    expect(clearedCookies(r)).toHaveLength(1);
  });

  test("a blocked user's session ends at once", async () => {
    const c = await start();
    const { user, cookie } = await createSignedInUser(c, { kind: 'oidc' });
    await c.deps.db.db
      .updateTable('users')
      .set({ role_override: 'blocked' })
      .where('id', '=', user.id)
      .execute();
    const r = await me(c, cookie);
    expect(r.status).toBe(401);
    expect(clearedCookies(r)).toHaveLength(1);
    expect(await sessionCount(c)).toBe(0);
  });

  test("a disabled user's session ends at once", async () => {
    const c = await start();
    const { user, cookie } = await createSignedInUser(c, { kind: 'oidc' });
    await c.deps.db.db
      .updateTable('users')
      .set({ disabled_at: clock.now(), disabled_reason: 'test' })
      .where('id', '=', user.id)
      .execute();
    const r = await me(c, cookie);
    expect(r.status).toBe(401);
    expect(clearedCookies(r)).toHaveLength(1);
    expect(await sessionCount(c)).toBe(0);
  });

  test('an oidc user without an IdP role has no access', async () => {
    const c = await start();
    const { cookie } = await createSignedInUser(c, { kind: 'oidc', idpRole: null });
    expect((await me(c, cookie)).status).toBe(401);
    expect(await sessionCount(c)).toBe(0);
  });

  test('purgeExpiredSessions removes only expired sessions', async () => {
    const c = await start();
    const { user } = await createSignedInUser(c);
    clock.advance(DAY_MS);
    const later = await createSession(c.deps, user.id, 'passkey', { ip: '::1', userAgent: null });
    clock.advance(29 * DAY_MS);
    expect(await purgeExpiredSessions(c.deps)).toBe(1);
    const left = await c.deps.db.db.selectFrom('sessions').select('id_hash').execute();
    expect(left).toEqual([{ id_hash: later.idHash }]);
  });

  test('createSession stores only the hash, the client and a cut user agent', async () => {
    const c = await start();
    const { user } = await createSignedInUser(c);
    const created = await createSession(c.deps, user.id, 'passkey', {
      ip: '203.0.113.8',
      userAgent: 'x'.repeat(600),
    });
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.expiresAt).toBe(clock.now() + 30 * DAY_MS);
    const row = await c.deps.db.db
      .selectFrom('sessions')
      .selectAll()
      .where('id_hash', '=', created.idHash)
      .executeTakeFirstOrThrow();
    expect(row.id_hash).not.toBe(created.secret);
    expect(row).toMatchObject({
      user_id: user.id,
      auth_method: 'passkey',
      ip: '203.0.113.8',
      created_at: clock.now(),
      last_seen_at: clock.now(),
    });
    expect(row.user_agent).toHaveLength(512);
  });

  test('deleteUserSessions can keep one session', async () => {
    const c = await start();
    const { user } = await createSignedInUser(c);
    const kept = await createSession(c.deps, user.id, 'password', { ip: '::1', userAgent: null });
    await createSession(c.deps, user.id, 'password', { ip: '::1', userAgent: null });
    expect(await deleteUserSessions(c.deps, user.id, { exceptIdHash: kept.idHash })).toBe(2);
    expect(await sessionCount(c)).toBe(1);
    expect(await deleteUserSessions(c.deps, user.id)).toBe(1);
    expect(await sessionCount(c)).toBe(0);
  });
});
