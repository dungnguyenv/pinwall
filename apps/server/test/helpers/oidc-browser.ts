import type { UserRow } from '../../src/db/schema.ts';
import { sessionCookieFrom } from './auth.ts';
import type { TestContext } from './context.ts';
import { idpBrowserAuthorize, type TestIdp, type TestIdpAccount } from './oidc-idp.ts';

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
  const binding = start.headers
    .getSetCookie()
    .map((line) => BINDING_SET_COOKIE.exec(line))
    .find((match) => match?.[2]);

  idp.signInAs(o.as);
  const callback = await idpBrowserAuthorize(idp, location);
  const cookie = [binding && `${binding[1]}=${binding[2]}`, o.cookie].filter(Boolean).join('; ');
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
