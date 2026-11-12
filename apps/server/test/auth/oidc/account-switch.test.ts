import { randomUUID } from 'node:crypto';
import { Me } from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { oidcRuntime } from '../../../src/auth/oidc/client.ts';
import { publicUrl } from '../../../src/http/public-url.ts';
import { InMemoryOneTimeStore } from '../../../src/infra/one-time-store.ts';
import { FixedClock } from '../../../src/lib/clock.ts';
import { t } from '../../../src/lib/i18n.ts';
import { newSecret } from '../../../src/lib/ids.ts';
import { apiInit, sessionCookieFrom } from '../../helpers/auth.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dialects } from '../../helpers/db.ts';
import {
  bindingCookieFrom,
  signInWithIdp,
  switchAccount,
  switchLinkOf,
} from '../../helpers/oidc-browser.ts';
import {
  idpBrowserAuthorize,
  idpBrowserEndSession,
  startTestIdp,
  type TestIdp,
  type TestIdpAccount,
} from '../../helpers/oidc-idp.ts';

const T = Date.UTC(2026, 10, 12);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ROLE_ENV = {
  PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins',
  PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-users',
};
const SIGNED_OUT = 'http://localhost:8080/auth/oidc/signed-out';
/** How long a refused sign-in's switch link, and the IdP sign-out it starts, stay usable. */
const TEN_MINUTES = 600_000;

/** `text` as hono/jsx writes it into a page. */
const html = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** The claims of a JWT, read without checking it. */
function claimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** An IdP with RP-Initiated Logout, like Keycloak, and one without, like Google. */
let idp: TestIdp;
let plainIdp: TestIdp;
beforeAll(async () => {
  idp = await startTestIdp();
  plainIdp = await startTestIdp({ endSession: false });
});
afterAll(async () => {
  await idp?.close();
  await plainIdp?.close();
});

describe.each(dialects)('"Use a different account" on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  /** Every line the app logs, at any level. */
  let lines: string[];
  afterEach(() => ctx?.close());

  async function start(using: TestIdp = idp): Promise<void> {
    clock = new FixedClock(T);
    lines = [];
    ctx = await createTestContext({
      dialect,
      clock,
      env: using.env(ROLE_ENV),
      log: (line) => lines.push(line),
    });
  }

  /** A new account at `using`, in `groups`. */
  function account(using: TestIdp, groups: string[]): TestIdpAccount {
    const a: TestIdpAccount = {
      sub: `user-${randomUUID()}`,
      name: 'Someone',
      email: `${randomUUID()}@example.com`,
      email_verified: true,
      groups,
    };
    using.addAccount(a);
    return a;
  }

  const home = (path: string) => publicUrl(ctx.deps.config, path);
  const roleOf = async (cookie: string | null) => {
    const r = await ctx.request('/api/v1/me', apiInit(ctx, { cookie: cookie ?? '' }));
    expect(r.status).toBe(200);
    return Me.parse(await r.json()).role;
  };
  /** How many values the one-time store holds, the refused ID tokens among them. */
  function keptValues(): number {
    const store = ctx.deps.oneTime;
    if (!(store instanceof InMemoryOneTimeStore)) throw new Error('Expected the in-memory store');
    return store.size;
  }
  /** Lines that hold `secret`. */
  const linesWith = (secret: string) => lines.filter((line) => line.includes(secret));

  /**
   * Somebody outside every group signs in at `idp` and is refused. Returns the no-access page's
   * switch link and the binding cookie the page set.
   */
  async function refused(returnTo = '/projects/p1'): Promise<{
    eve: TestIdpAccount;
    link: URL;
    cookie: string;
    setCookie: string;
  }> {
    const eve = account(idp, ['other']);
    const r = await signInWithIdp(ctx, idp, { as: eve.sub, returnTo });
    expect(r.status).toBe(403);
    const setCookie = r.headers.getSetCookie().find((c) => c.startsWith('pinwall_oidc=')) ?? '';
    const cookie = bindingCookieFrom(r);
    if (cookie === null) throw new Error('The no-access page set no binding cookie');
    return { eve, link: switchLinkOf(ctx, await r.text()), cookie, setCookie };
  }

  /** The IdP sign-out `link` starts, signed out: the URL the IdP sends the browser back to. */
  async function signOutAtIdp(link: URL, cookie: string): Promise<URL> {
    const r = await ctx.request(link.href, { headers: { cookie } });
    const location = r.headers.get('location') ?? '';
    expect(location.startsWith(`${idp.issuer}/session/end?`)).toBe(true);
    return idpBrowserEndSession(idp, location);
  }

  /**
   * Checks that `r` falls back to a fresh sign-in at the IdP's authorization endpoint, with its
   * account chooser and nowhere else; returns the authorization URL.
   */
  function expectFreshSignIn(r: Response): URL {
    expect(r.status).toBe(302);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const url = new URL(r.headers.get('location') ?? '');
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/auth`);
    expect(url.searchParams.get('prompt')?.split(' ')).toContain('select_account');
    expect(bindingCookieFrom(r)).not.toBeNull();
    return url;
  }

  /** Finishes the sign-in at `authorizeUrl` as a new member; returns where Pinwall sends them. */
  async function finishAsMember(r: Response, authorizeUrl: URL): Promise<string | null> {
    const member = account(idp, ['pinwall-users']);
    idp.signInAs(member.sub);
    const callback = await idpBrowserAuthorize(idp, authorizeUrl.href);
    const done = await ctx.request(`${callback.pathname}${callback.search}`, {
      headers: { cookie: bindingCookieFrom(r) ?? '' },
    });
    expect(done.status).toBe(302);
    return done.headers.get('location');
  }

  test('signs out at the IdP with the refused ID token, then asks the IdP again', async () => {
    await start();
    const { eve, link, cookie, setCookie } = await refused('/projects/p1');
    expect(link.pathname).toBe('/auth/oidc/switch');
    expect([...link.searchParams.keys()].sort()).toEqual(['return_to', 'ticket']);
    expect(link.searchParams.get('return_to')).toBe('/projects/p1');
    const ticket = link.searchParams.get('ticket') ?? '';
    expect(ticket).toMatch(TOKEN);
    // The page renews the binding cookie, so it lasts as long as the ticket.
    for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) {
      expect(setCookie).toContain(part);
    }

    const switched = await ctx.request(link.href, { headers: { cookie } });
    expect(switched.status).toBe(302);
    expect(switched.headers.get('cache-control')).toBe('no-store');
    const logout = new URL(switched.headers.get('location') ?? '');
    expect(logout.origin + logout.pathname).toBe(`${idp.issuer}/session/end`);
    // Exactly these four, none of them from the request.
    expect([...logout.searchParams.keys()].sort()).toEqual([
      'client_id',
      'id_token_hint',
      'post_logout_redirect_uri',
      'state',
    ]);
    expect(logout.searchParams.get('client_id')).toBe('pinwall');
    expect(logout.searchParams.get('post_logout_redirect_uri')).toBe(SIGNED_OUT);
    const state = logout.searchParams.get('state') ?? '';
    expect(state).toMatch(TOKEN);
    expect(state).not.toBe(ticket);
    const idToken = logout.searchParams.get('id_token_hint') ?? '';
    expect(claimsOf(idToken)).toMatchObject({ iss: idp.issuer, sub: eve.sub, aud: 'pinwall' });

    // The IdP takes the hint and comes back to the fixed route with the state, and only that.
    const back = await idpBrowserEndSession(idp, logout.href);
    expect(back.origin + back.pathname).toBe(SIGNED_OUT);
    expect([...back.searchParams]).toEqual([['state', state]]);
    expect(idp.endSessionRequests.at(-1)?.get('id_token_hint')).toBe(idToken);

    const signedOut = await ctx.request(back.href, { headers: { cookie } });
    const authorize = expectFreshSignIn(signedOut);
    expect(authorize.searchParams.get('state')).not.toBe(state);
    // Someone else signs in, and lands where the refused sign-in was going.
    expect(await finishAsMember(signedOut, authorize)).toBe(home('/projects/p1'));

    // None of it reached a log line, though the capture saw the switch.
    expect(linesWith(idToken)).toEqual([]);
    expect(linesWith(ticket)).toEqual([]);
    expect(linesWith(state)).toEqual([]);
    expect(lines.join('')).toContain('"msg":"oidc account switch: signing out at the IdP"');
  });

  test('the whole switch, as a browser takes it, lets a member in', async () => {
    await start();
    const { link, cookie } = await refused('/x');
    const member = account(idp, ['pinwall-users']);
    const r = await switchAccount(ctx, idp, { link, cookie, as: member.sub });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(home('/x'));
    expect(await roleOf(sessionCookieFrom(r))).toBe('member');
    expect(idp.endSessionRequests.length).toBeGreaterThan(0);
  });

  test('the switch link works once, only in the refused browser, for ten minutes', async () => {
    await start();
    const signOuts = () => idp.endSessionRequests.length;

    // Used once, then not again.
    const once = await refused();
    await signOutAtIdp(once.link, once.cookie);
    const before = signOuts();
    expectFreshSignIn(await ctx.request(once.link.href, { headers: { cookie: once.cookie } }));

    // Another browser, or none, never gets the ID token.
    const other = await refused();
    const elsewhere = await ctx.request(other.link.href, {
      headers: { cookie: `pinwall_oidc=${newSecret()}` },
    });
    expect(elsewhere.headers.get('location')).not.toContain('id_token_hint');
    expectFreshSignIn(elsewhere);
    const bare = await refused();
    expectFreshSignIn(await ctx.request(bare.link.href));

    // Ten minutes later the ticket is gone; the fallback keeps the link's return_to.
    const late = await refused('/projects/p2');
    clock.advance(TEN_MINUTES);
    const expired = await ctx.request(late.link.href, { headers: { cookie: late.cookie } });
    expect(await finishAsMember(expired, expectFreshSignIn(expired))).toBe(home('/projects/p2'));

    // A ticket nobody issued, malformed or not, with a return_to trick.
    for (const ticket of [newSecret(), 'x', '']) {
      const forged = await ctx.request(
        `/auth/oidc/switch?return_to=${encodeURIComponent('//evil.example')}&ticket=${ticket}`,
        { headers: { cookie: once.cookie } },
      );
      expect(await finishAsMember(forged, expectFreshSignIn(forged))).toBe(home('/'));
    }
    expect(signOuts()).toBe(before);

    // Each fallback is logged with its reason, never with its ticket.
    for (const { link } of [once, other, bare, late]) {
      expect(linesWith(link.searchParams.get('ticket') ?? '')).toEqual([]);
    }
    const fallbacks = lines
      .map((line) => JSON.parse(line) as { msg?: string; step?: string; reason?: string })
      .filter((entry) => entry.msg === 'oidc account switch fell back');
    expect(fallbacks.map(({ step, reason }) => `${step} ${reason}`)).toEqual([
      'switch expired',
      'switch other_browser',
      'switch other_browser',
      'switch expired',
      'switch expired',
      'switch expired',
      'switch expired',
    ]);
  });

  test('the signed-out route needs its state, once, in the browser that left', async () => {
    await start();

    // Replayed after it was used: a fresh sign-in that forgets where the first was going.
    const used = await refused('/projects/p1');
    const back = await signOutAtIdp(used.link, used.cookie);
    expectFreshSignIn(await ctx.request(back.href, { headers: { cookie: used.cookie } }));
    const replay = await ctx.request(back.href, { headers: { cookie: used.cookie } });
    expect(await finishAsMember(replay, expectFreshSignIn(replay))).toBe(home('/'));

    // Arriving in another browser.
    const other = await refused('/projects/p1');
    const otherBack = await signOutAtIdp(other.link, other.cookie);
    const elsewhere = await ctx.request(otherBack.href, {
      headers: { cookie: `pinwall_oidc=${newSecret()}` },
    });
    expect(await finishAsMember(elsewhere, expectFreshSignIn(elsewhere))).toBe(home('/'));

    // Ten minutes after the sign-out began.
    const slow = await refused('/projects/p1');
    const slowBack = await signOutAtIdp(slow.link, slow.cookie);
    clock.advance(TEN_MINUTES);
    const late = await ctx.request(slowBack.href, { headers: { cookie: slow.cookie } });
    expect(await finishAsMember(late, expectFreshSignIn(late))).toBe(home('/'));

    // No state, or one nobody issued.
    for (const query of ['', '?state=', `?state=${newSecret()}`, '?state=x&return_to=/projects']) {
      const r = await ctx.request(`/auth/oidc/signed-out${query}`, {
        headers: { cookie: used.cookie },
      });
      expect(await finishAsMember(r, expectFreshSignIn(r))).toBe(home('/'));
    }
  });

  test('a sign-out that cannot be built falls back to the account chooser', async () => {
    await start();
    const { link, cookie } = await refused('/projects/p1');
    const signOuts = idp.endSessionRequests.length;
    // Discovery is kept once it succeeds, so this stands for anything that keeps the end-session
    // URL from being built.
    vi.spyOn(oidcRuntime(ctx.deps), 'configuration').mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );
    const r = await ctx.request(link.href, { headers: { cookie } });
    expect(r.headers.get('location')).not.toContain('id_token_hint');
    expect(await finishAsMember(r, expectFreshSignIn(r))).toBe(home('/projects/p1'));
    expect(idp.endSessionRequests).toHaveLength(signOuts);
    const fallbacks = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'oidc account switch fell back');
    expect(fallbacks).toMatchObject([
      { step: 'switch', reason: 'end_session_failed', code: 'TypeError' },
    ]);
  });

  test('an IdP without end_session_endpoint gets prompt=select_account and the hint', async () => {
    await start(plainIdp);
    const eve = account(plainIdp, ['other']);
    const r = await signInWithIdp(ctx, plainIdp, { as: eve.sub, returnTo: '/projects/p1' });
    expect(r.status).toBe(403);
    expect(bindingCookieFrom(r)).toBeNull();
    const page = await r.text();
    expect(page).toContain(
      'href="/auth/oidc/start?return_to=%2Fprojects%2Fp1&amp;prompt=select_account"',
    );
    // No ID token is kept for a switch that cannot use it.
    expect(keptValues()).toBe(0);

    // The IdP picks Eve again: the page says how to get out of that.
    const again = await switchAccount(ctx, plainIdp, {
      link: switchLinkOf(ctx, page),
      cookie: '',
      as: eve.sub,
    });
    expect(again.status).toBe(403);
    expect(await again.text()).toContain(html(t('oidc.noAccess.retryHint', { idp: 'Test IdP' })));
    expect(plainIdp.endSessionRequests).toEqual([]);
  });

  test('a sign-in that is let in keeps no ID token', async () => {
    await start();
    const member = account(idp, ['pinwall-users']);
    const r = await signInWithIdp(ctx, idp, { as: member.sub });
    expect(r.status).toBe(302);
    expect(keptValues()).toBe(0);
  });
});
