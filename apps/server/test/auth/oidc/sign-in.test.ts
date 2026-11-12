import { randomUUID } from 'node:crypto';
import { Me } from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createShareLink } from '../../../src/domain/shares.ts';
import { publicUrl } from '../../../src/http/public-url.ts';
import { FixedClock } from '../../../src/lib/clock.ts';
import { t } from '../../../src/lib/i18n.ts';
import { newSecret } from '../../../src/lib/ids.ts';
import { apiInit, createSignedInUser, sessionCookieFrom } from '../../helpers/auth.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dialects } from '../../helpers/db.ts';
import { authorizeAtIdp, signInOidcUser, signInWithIdp } from '../../helpers/oidc-browser.ts';
import { startTestIdp, type TestIdp, type TestIdpAccount } from '../../helpers/oidc-idp.ts';
import { publishFiles } from '../../helpers/publish.ts';

const T = Date.UTC(2026, 10, 10);
const ROLE_ENV = {
  PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins',
  PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-users',
};
const IDP = { idp: 'Test IdP' };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** `text` as hono/jsx writes it into a page. */
const html = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

let idp: TestIdp;
beforeAll(async () => {
  idp = await startTestIdp();
});
afterAll(() => idp?.close());

describe.each(dialects)('OIDC sign-in on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(async () => {
    idp.setReachable(true);
    idp.failTokenRequests(null);
    await ctx?.close();
  });

  /** A fresh app (so rate-limit counters start at zero), with OIDC on unless `oidc` is false. */
  async function start(env: Record<string, string> = {}, oidc = true): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({
      dialect,
      clock,
      env: oidc ? idp.env({ ...ROLE_ENV, ...env }) : env,
    });
    return ctx;
  }

  /** A new IdP account with a random subject; a member unless told otherwise. */
  function account(o: Partial<TestIdpAccount> = {}): TestIdpAccount {
    const a: TestIdpAccount = {
      sub: `user-${randomUUID()}`,
      name: 'Ada Example',
      email: 'ada@example.com',
      email_verified: true,
      groups: ['pinwall-users'],
      ...o,
    };
    idp.addAccount(a);
    return a;
  }

  const home = (path: string) => publicUrl(ctx.deps.config, path);
  const sessions = () => ctx.deps.db.db.selectFrom('sessions').selectAll().execute();
  const userBySub = (sub: string) =>
    ctx.deps.db.db
      .selectFrom('users')
      .selectAll()
      .where('oidc_subject', '=', sub)
      .executeTakeFirst();
  const me = async (cookie: string | null) => {
    const r = await ctx.request('/api/v1/me', apiInit(ctx, { cookie: cookie ?? '' }));
    expect(r.status).toBe(200);
    return Me.parse(await r.json());
  };

  /** Checks an HTML page answer and that it shows each of `texts`; returns the body. */
  async function expectPage(r: Response, status: number, ...texts: string[]): Promise<string> {
    expect(r.status).toBe(status);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.text();
    for (const text of texts) expect(body).toContain(html(text));
    return body;
  }

  test('start redirects to the IdP with PKCE, state and nonce', async () => {
    await start();
    const r = await ctx.request('/auth/oidc/start?return_to=/projects/p1');
    expect(r.status).toBe(302);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const url = new URL(r.headers.get('location') ?? '');
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/auth`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    for (const k of ['state', 'nonce', 'code_challenge']) {
      expect(url.searchParams.get(k)).toMatch(TOKEN);
    }
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/auth/oidc/callback');
    expect(url.searchParams.get('prompt')).toBeNull();
    const sc = r.headers.getSetCookie().find((c) => c.startsWith('pinwall_oidc=')) ?? '';
    expect(sc).toMatch(/^pinwall_oidc=[A-Za-z0-9_-]{43};/);
    for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) {
      expect(sc).toContain(part);
    }
    expect(sc).not.toContain('Secure');
  });

  test('the binding cookie is reused while it is well-formed', async () => {
    await start();
    const binding = (r: Response) =>
      r.headers
        .getSetCookie()
        .find((c) => c.startsWith('pinwall_oidc='))
        ?.split(';')[0];
    const held = newSecret();
    const kept = await ctx.request('/auth/oidc/start', {
      headers: { cookie: `pinwall_oidc=${held}` },
    });
    expect(binding(kept)).toBe(`pinwall_oidc=${held}`);
    const replaced = await ctx.request('/auth/oidc/start', {
      headers: { cookie: 'pinwall_oidc=short' },
    });
    expect(binding(replaced)).toMatch(/^pinwall_oidc=[A-Za-z0-9_-]{43}$/);
    expect(binding(replaced)).not.toBe('pinwall_oidc=short');
  });

  test('a member signs in and lands on return_to with a session', async () => {
    await start();
    const a = account();
    const r = await signInWithIdp(ctx, idp, { as: a.sub, returnTo: '/projects/p1' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(home('/projects/p1'));
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await me(sessionCookieFrom(r))).toMatchObject({
      kind: 'oidc',
      role: 'member',
      via: 'session',
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada Example',
      credentials: null,
    });
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.auth_method).toBe('oidc');
    const user = await userBySub(a.sub);
    expect(user?.oidc_issuer).toBe(idp.issuer);
    expect(user?.idp_refresh_token).not.toBeNull();
  });

  test('an admin group member is an admin', async () => {
    await start();
    const { cookie } = await signInOidcUser(ctx, idp, {
      sub: `user-${randomUUID()}`,
      name: 'Grace',
      email: 'grace@example.com',
      email_verified: true,
      groups: ['pinwall-admins'],
    });
    expect(await me(cookie)).toMatchObject({ kind: 'oidc', role: 'admin', name: 'Grace' });
  });

  test('an unadmitted identity gets the no-access page and no session', async () => {
    await start();
    const { sub } = account({
      name: 'Eve Example',
      email: 'eve@example.com',
      email_verified: true,
      groups: ['other'],
    });
    const r = await signInWithIdp(ctx, idp, { as: sub, returnTo: '/projects/p1' });
    const body = await expectPage(
      r,
      403,
      'Eve Example',
      'eve@example.com',
      t('oidc.noAccess.title'),
      t('oidc.noAccess.switch'),
      t('oidc.noAccess.signedInAs', IDP),
      t('oidc.noAccess.message'),
    );
    // The test IdP signs people out (RP-Initiated Logout), so the link goes through that first.
    expect(body).toMatch(
      /href="\/auth\/oidc\/switch\?return_to=%2Fprojects%2Fp1&amp;ticket=[A-Za-z0-9_-]{43}"/,
    );
    expect(body).not.toContain(html(t('oidc.noAccess.retryHint', IDP)));
    expect(body).not.toContain(html(t('oidc.noAccess.unverified')));
    expect(sessionCookieFrom(r)).toBeNull();
    expect(await sessions()).toHaveLength(0);
    const user = await userBySub(sub);
    expect(user).toMatchObject({ kind: 'oidc', idp_role: null, idp_refresh_token: null });
  });

  test('a sign-in the IdP no longer admits revokes what the person shared', async () => {
    await start();
    const ada = account();
    const { user } = await signInOidcUser(ctx, idp, ada);
    const { artifact } = await publishFiles(ctx, user, { 'index.html': '<p>một</p>' });
    const share = () =>
      createShareLink(ctx.deps, user, artifact.id, {
        versionId: null,
        password: null,
        expiresAt: null,
        allowComments: true,
      });
    const opens = async (token: string) => (await ctx.request(`/api/v1/share/${token}`)).status;
    const revokedAt = async () =>
      (
        await ctx.deps.db.db
          .selectFrom('share_links')
          .select('revoked_at')
          .executeTakeFirstOrThrow()
      ).revoked_at;

    // An answer without the roles claim proves nothing: refused, and the link is only suspended
    // while the person has no role, not revoked: admitted again, it opens again.
    const kept = await share();
    idp.setGroups(ada.sub, undefined);
    expect((await signInWithIdp(ctx, idp, { as: ada.sub })).status).toBe(403);
    expect(await opens(kept.token)).toBe(410);
    expect(await revokedAt()).toBeNull();
    idp.setGroups(ada.sub, ['pinwall-users']);
    await signInOidcUser(ctx, idp, { ...ada, groups: ['pinwall-users'] });
    expect(await opens(kept.token)).toBe(200);

    // Groups that no longer earn a role: the person is out, and what they shared is revoked.
    clock.advance(1000);
    idp.setGroups(ada.sub, ['other']);
    expect((await signInWithIdp(ctx, idp, { as: ada.sub })).status).toBe(403);
    expect(await opens(kept.token)).toBe(410);
    expect(await revokedAt()).toBe(clock.now());
  });

  test('a sign-in token without the roles claim is logged once, by the claim name only', async () => {
    await start();
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    const aboutTheClaim = () =>
      warn.mock.calls.filter(([, msg]) => typeof msg === 'string' && msg.includes('roles claim'));
    await signInOidcUser(ctx, idp, account());
    expect(aboutTheClaim()).toEqual([]);

    for (const groupless of [account({ groups: undefined }), account({ groups: undefined })]) {
      expect((await signInWithIdp(ctx, idp, { as: groupless.sub })).status).toBe(403);
    }
    expect(aboutTheClaim()).toEqual([
      [
        { claim: 'groups' },
        'An OIDC sign-in token had no roles claim, so no group rule can match that person. ' +
          'If nobody gets in by group, make the identity provider send the claim that ' +
          'PINWALL_OIDC_ROLES_CLAIM names. Logged once.',
      ],
    ]);
  });

  test('use a different account restarts with prompt=select_account and keeps return_to', async () => {
    await start();
    const eve = account({ name: 'Eve', groups: ['other'] });
    const denied = await signInWithIdp(ctx, idp, { as: eve.sub, returnTo: '/projects/p1' });
    expect(denied.status).toBe(403);

    const ada = account();
    const r = await signInWithIdp(ctx, idp, {
      as: ada.sub,
      returnTo: '/projects/p1',
      selectAccount: true,
    });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(home('/projects/p1'));
    const prompt = idp.authorizationRequests.at(-1)?.get('prompt') ?? '';
    expect(new Set(prompt.split(' '))).toEqual(new Set(['select_account', 'consent']));
    expect((await userBySub(ada.sub))?.idp_refresh_token).not.toBeNull();
  });

  test('a retry that lands on the same unadmitted account shows the sign-out hint', async () => {
    await start();
    const { sub } = account({ groups: ['other'] });
    const r = await signInWithIdp(ctx, idp, { as: sub, returnTo: '/x', selectAccount: true });
    await expectPage(r, 403, t('oidc.noAccess.retryHint', IDP));
  });

  test('an unverified email is shown as unverified', async () => {
    await start({ PINWALL_MEMBER_DOMAINS: 'example.com' });
    const { sub } = account({ email: 'ann@example.com', email_verified: false, groups: [] });
    const r = await signInWithIdp(ctx, idp, { as: sub });
    await expectPage(r, 403, 'ann@example.com', t('oidc.noAccess.unverified'));
  });

  test('an identity without an email says so', async () => {
    await start();
    const { sub } = account({ name: 'Nobody', email: undefined, groups: ['other'] });
    const r = await signInWithIdp(ctx, idp, { as: sub });
    await expectPage(r, 403, 'Nobody', t('oidc.noAccess.noEmail'));
  });

  test('claims are escaped on the no-access page', async () => {
    await start();
    const { sub } = account({ name: '<script>alert(1)</script>', groups: ['other'] });
    const r = await signInWithIdp(ctx, idp, { as: sub });
    const body = await expectPage(r, 403);
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(body).not.toContain('<script>alert');
  });

  test('return_to tricks fall back to /', async () => {
    await start();
    const a = account();
    for (const trick of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      '/auth/oidc/start',
    ]) {
      const r = await signInWithIdp(ctx, idp, { as: a.sub, returnTo: trick });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(home('/'));
    }
  });

  test('a callback without its pending login is an HTML error page', async () => {
    await start();
    const r = await ctx.request('/auth/oidc/callback?state=unknown&code=x', {
      headers: { accept: 'application/json' },
    });
    await expectPage(r, 400, t('oidc.expired.title'), t('oidc.expired.message'));
    const bare = await ctx.request('/auth/oidc/callback', {
      headers: { accept: 'application/json' },
    });
    await expectPage(bare, 400, t('oidc.expired.title'));
  });

  test('a callback replay is refused', async () => {
    await start();
    const a = account();
    const { url, init } = await authorizeAtIdp(ctx, idp, { as: a.sub });
    expect((await ctx.request(url, init)).status).toBe(302);
    await expectPage(await ctx.request(url, init), 400, t('oidc.expired.title'));
    expect(await sessions()).toHaveLength(1);
  });

  test('a pending login expires after ten minutes', async () => {
    await start();
    const a = account();
    const { url, init } = await authorizeAtIdp(ctx, idp, { as: a.sub });
    clock.advance(600_001);
    await expectPage(await ctx.request(url, init), 400, t('oidc.expired.title'));
    expect(await sessions()).toHaveLength(0);
  });

  test('a callback from another browser is refused', async () => {
    await start();
    const a = account();
    const first = await authorizeAtIdp(ctx, idp, { as: a.sub, returnTo: '/projects/p1' });
    const r = await ctx.request(first.url);
    const body = await expectPage(r, 400, t('oidc.otherBrowser.message'));
    expect(body).toContain('href="/auth/oidc/start?return_to=%2Fprojects%2Fp1"');

    const second = await authorizeAtIdp(ctx, idp, { as: a.sub });
    const wrong = await ctx.request(second.url, {
      headers: { cookie: `pinwall_oidc=${newSecret()}` },
    });
    await expectPage(wrong, 400, t('oidc.otherBrowser.title'));

    expect(await userBySub(a.sub)).toBeUndefined();
    expect(await sessions()).toHaveLength(0);
  });

  test('a cancelled sign-in is an HTML page with try again', async () => {
    await start();
    const a = account();
    idp.cancelNextSignIn();
    const r = await signInWithIdp(ctx, idp, { as: a.sub, returnTo: '/projects/p1' });
    const body = await expectPage(
      r,
      400,
      t('oidc.cancelled.title'),
      t('oidc.cancelled.message', IDP),
      t('oidc.tryAgain'),
    );
    expect(body).toContain('href="/auth/oidc/start?return_to=%2Fprojects%2Fp1"');
    expect(body).not.toContain('cancelled the sign-in');
    expect(await userBySub(a.sub)).toBeUndefined();
  });

  test('a refused token request is a failed page, an IdP 5xx an unavailable one', async () => {
    await start();
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    const a = account();
    idp.failTokenRequests({ status: 400, error: 'invalid_grant' });
    const failed = await signInWithIdp(ctx, idp, { as: a.sub });
    await expectPage(failed, 400, t('oidc.failed.title'), t('oidc.failed.message', IDP));

    idp.failTokenRequests({ status: 503, error: 'temporarily_unavailable' });
    const down = await signInWithIdp(ctx, idp, { as: a.sub });
    await expectPage(down, 502, t('oidc.unavailable.title', IDP));
    expect(await sessions()).toHaveLength(0);
    // The log names each failure with a fixed error code, for the admin to look up. A 5xx has
    // no OAuth error body that openid-client reads, so it is named by openid-client's code.
    expect(warn.mock.calls.filter(([, message]) => message === 'oidc sign-in failed')).toEqual([
      [{ failure: 'failed', code: 'invalid_grant' }, 'oidc sign-in failed'],
      [{ failure: 'unavailable', code: 'OAUTH_RESPONSE_IS_NOT_CONFORM' }, 'oidc sign-in failed'],
    ]);
  });

  test('an unreachable IdP is an HTML 502 page', async () => {
    await start();
    idp.setReachable(false);
    const r = await ctx.request('/auth/oidc/start?return_to=/projects/p1');
    const body = await expectPage(
      r,
      502,
      t('oidc.unavailable.title', IDP),
      t('oidc.unavailable.message', IDP),
    );
    expect(body).toContain('href="/auth/oidc/start?return_to=%2Fprojects%2Fp1"');
  });

  test('OIDC routes are 404 pages when OIDC is off', async () => {
    await start({}, false);
    for (const path of [
      '/auth/oidc/start',
      '/auth/oidc/callback?state=x&code=y',
      '/auth/oidc/switch?ticket=x',
      '/auth/oidc/signed-out?state=x',
    ]) {
      const r = await ctx.request(path, { headers: { accept: 'application/json' } });
      await expectPage(r, 404, t('oidc.notConfigured.title'), t('oidc.notConfigured.message'));
    }
  });

  test('behind a TLS proxy the redirect URI and cookies use the public origin', async () => {
    await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
    const internal = 'http://internal:8080';
    const begun = await ctx.request(`${internal}/auth/oidc/start`, {
      headers: { host: 'internal:8080' },
    });
    expect(begun.status).toBe(302);
    const binding = begun.headers.getSetCookie().find((c) => c.includes('pinwall_oidc=')) ?? '';
    expect(binding).toMatch(/^__Host-pinwall_oidc=[A-Za-z0-9_-]{43};/);
    expect(binding).toContain('Secure');

    const a = account();
    const r = await signInWithIdp(ctx, idp, { as: a.sub, baseUrl: internal, returnTo: '/x' });
    expect(idp.authorizationRequests.at(-1)?.get('redirect_uri')).toBe(
      'https://pinwall.test/auth/oidc/callback',
    );
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://pinwall.test/x');
    const session = r.headers.getSetCookie().find((c) => c.includes('pinwall_session=')) ?? '';
    expect(session).toMatch(/^__Host-pinwall_session=/);
    expect(session).toContain('Secure');
  });

  test('sign-in replaces the session presented with the request', async () => {
    await start();
    const earlier = await createSignedInUser(ctx);
    const a = account();
    const r = await signInWithIdp(ctx, idp, { as: a.sub, cookie: earlier.cookie });
    expect(r.status).toBe(302);
    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe((await userBySub(a.sub))?.id);
  });

  test('start and callback are rate limited per IP', async () => {
    await start();
    for (let i = 0; i < 60; i++) {
      expect((await ctx.request('/auth/oidc/start')).status).toBe(302);
    }
    const r = await ctx.request('/auth/oidc/start');
    await expectPage(r, 429, t('oidc.rateLimited.title'));
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    // The account switch's routes start sign-ins too, and count with /start.
    for (const path of ['/auth/oidc/switch', '/auth/oidc/signed-out']) {
      await expectPage(await ctx.request(path), 429, t('oidc.rateLimited.title'));
    }

    for (let i = 0; i < 30; i++) {
      expect((await ctx.request('/auth/oidc/callback?state=x&code=y')).status).toBe(400);
    }
    const c = await ctx.request('/auth/oidc/callback?state=x&code=y');
    await expectPage(c, 429, t('oidc.rateLimited.title'));
    expect(c.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
