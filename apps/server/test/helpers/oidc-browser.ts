import type { UserRow } from '../../src/db/schema.ts';
import { sessionCookieFrom } from './auth.ts';
import type { TestContext } from './context.ts';
import {
  idpBrowserAuthorize,
  idpBrowserEndSession,
  type TestIdp,
  type TestIdpAccount,
} from './oidc-idp.ts';

const BINDING_SET_COOKIE = /^((?:__Host-)?pinwall_oidc)=([^;]*)/;

export interface OidcBrowserOptions {
  /** The IdP account to sign in as. */
  as: string;
  /** Sent as `return_to` when given. */
  returnTo?: string;
  /** Asks for `prompt=select_account`, as "Use a different account" does. */
  selectAccount?: boolean;
  /**
   * Where the browser's requests reach Pinwall, default the public origin; with another origin
   * they also carry its `Host`, as behind a proxy that forwards to an internal address.
   */
  baseUrl?: string;
  /** Cookies the browser already holds for Pinwall, sent with both Pinwall requests. */
  cookie?: string;
}

/** The binding cookie `r` sets, as the `name=value` pair the browser sends back; else null. */
export function bindingCookieFrom(r: Response): string | null {
  const match = r.headers
    .getSetCookie()
    .map((line) => BINDING_SET_COOKIE.exec(line))
    .find((m) => m?.[2]);
  return match ? `${match[1]}=${match[2]}` : null;
}

/** The "Use a different account" link of a no-access page, on the public origin. */
export function switchLinkOf(ctx: TestContext, page: string): URL {
  const href = /<a class="pw-button pw-button-primary" href="([^"]*)"/.exec(page)?.[1];
  if (href === undefined) throw new Error('The page has no "Use a different account" link');
  return new URL(href.replaceAll('&amp;', '&'), ctx.deps.config.publicOrigin);
}

/** The `Location` of a 302 answer; throws on any other answer. */
async function redirectTarget(r: Response, what: string): Promise<string> {
  const location = r.headers.get('location');
  if (r.status !== 302 || location === null) {
    throw new Error(`${what} answered ${r.status}: ${await r.text()}`);
  }
  return location;
}

/**
 * Takes "Use a different account" as a browser holding `cookie` would, and signs in as `as`:
 * Pinwall's link; when it leads to the IdP's sign-out, that sign-out and Pinwall's signed-out
 * route; then the IdP's sign-in. Returns the callback response.
 */
export async function switchAccount(
  ctx: TestContext,
  idp: TestIdp,
  o: { link: URL; cookie: string; as: string },
): Promise<Response> {
  const switched = await ctx.request(o.link.href, { headers: { cookie: o.cookie } });
  let location = await redirectTarget(switched, `GET ${o.link.pathname}`);
  let cookie = bindingCookieFrom(switched) ?? o.cookie;
  if (location.startsWith(`${idp.issuer}/session/end?`)) {
    const back = await idpBrowserEndSession(idp, location);
    const signedOut = await ctx.request(back.href, { headers: { cookie } });
    location = await redirectTarget(signedOut, `GET ${back.pathname}`);
    cookie = bindingCookieFrom(signedOut) ?? cookie;
  }
  idp.signInAs(o.as);
  const callback = await idpBrowserAuthorize(idp, location);
  return ctx.request(`${callback.pathname}${callback.search}`, { headers: { cookie } });
}

/**
 * The browser half of a sign-in, up to the callback: `GET /auth/oidc/start`, then the IdP's
 * redirects. Returns the callback request to send, carrying the binding cookie the start set.
 */
export async function authorizeAtIdp(
  ctx: TestContext,
  idp: TestIdp,
  o: OidcBrowserOptions,
): Promise<{ url: string; init: RequestInit }> {
  const base = o.baseUrl ?? ctx.deps.config.publicOrigin;
  const host: Record<string, string> =
    o.baseUrl === undefined ? {} : { host: new URL(o.baseUrl).host };
  const query = new URLSearchParams();
  if (o.returnTo !== undefined) query.set('return_to', o.returnTo);
  if (o.selectAccount) query.set('prompt', 'select_account');

  const start = await ctx.request(`${base}/auth/oidc/start?${query}`, {
    headers: { ...host, ...(o.cookie === undefined ? {} : { cookie: o.cookie }) },
  });
  const location = start.headers.get('location');
  if (start.status !== 302 || location === null) {
    throw new Error(`GET /auth/oidc/start answered ${start.status}: ${await start.text()}`);
  }
  const binding = bindingCookieFrom(start);

  idp.signInAs(o.as);
  const callback = await idpBrowserAuthorize(idp, location);
  const cookie = [binding, o.cookie].filter(Boolean).join('; ');
  return {
    url: `${base}${callback.pathname}${callback.search}`,
    init: { headers: { ...host, ...(cookie === '' ? {} : { cookie }) } },
  };
}

/**
 * Signs in at Pinwall through `idp` as `o.as`, the way a browser would: start, the IdP, then the
 * callback with the binding cookie. Returns the callback response.
 */
export async function signInWithIdp(
  ctx: TestContext,
  idp: TestIdp,
  o: OidcBrowserOptions,
): Promise<Response> {
  const { url, init } = await authorizeAtIdp(ctx, idp, o);
  return ctx.request(url, init);
}

/** Adds `a` to the IdP and signs in as it; fails unless Pinwall let it in. */
export async function signInOidcUser(
  ctx: TestContext,
  idp: TestIdp,
  a: TestIdpAccount,
): Promise<{ user: UserRow; cookie: string }> {
  idp.addAccount(a);
  const r = await signInWithIdp(ctx, idp, { as: a.sub });
  if (r.status !== 302) {
    throw new Error(`The OIDC callback answered ${r.status}, expected 302: ${await r.text()}`);
  }
  const cookie = sessionCookieFrom(r);
  if (cookie === null) throw new Error('The OIDC callback set no session cookie');
  const user = await ctx.deps.db.db
    .selectFrom('users')
    .selectAll()
    .where('oidc_issuer', '=', idp.issuer)
    .where('oidc_subject', '=', a.sub)
    .executeTakeFirstOrThrow();
  return { user, cookie };
}
