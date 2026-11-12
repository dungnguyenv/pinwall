import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../app.ts';
import type { Config } from '../../config/types.ts';
import { loggablePath } from '../../http/logging.ts';
import { publicUrl } from '../../http/public-url.ts';
import { AppError } from '../../lib/errors.ts';
import { t } from '../../lib/i18n.ts';
import { newSecret } from '../../lib/ids.ts';
import { renderErrorPage } from '../../pages/error-page.tsx';
import { renderNoAccessPage } from '../../pages/no-access.tsx';
import { enforceRateLimit, type RateRule } from '../rate-limits.ts';
import { startSession } from '../session-cookie.ts';
import { beginAccountSwitch, finishAccountSwitch } from './account-switch.ts';
import { safeReturnTo } from './return-to.ts';
import {
  beginOidcSignIn,
  finishOidcSignIn,
  type OidcFailure,
  OidcFlowError,
  PENDING_LOGIN_TTL_MS,
} from './sign-in.ts';

export const OIDC_START_RATE: RateRule = { name: 'oidc-start', limit: 60, windowMs: 900_000 };
export const OIDC_CALLBACK_RATE: RateRule = { name: 'oidc-callback', limit: 30, windowMs: 900_000 };

/** A binding secret as `newSecret()` makes them. */
const BINDING_SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * The cookie that ties a sign-in to the browser that started it (login CSRF defense): `__Host-`
 * on an https public origin, decided by the configuration, never by the request's scheme.
 */
export function oidcBindingCookieName(config: Config): '__Host-pinwall_oidc' | 'pinwall_oidc' {
  return config.publicHttps ? '__Host-pinwall_oidc' : 'pinwall_oidc';
}

/** The path that starts a sign-in leading back to `returnTo`. */
export function startPath(returnTo: string, selectAccount: boolean): string {
  const query = new URLSearchParams({ return_to: returnTo });
  if (selectAccount) query.set('prompt', 'select_account');
  return `/auth/oidc/start?${query}`;
}

/**
 * The path of "Use a different account" on the no-access page: through the IdP's sign-out when
 * the refused sign-in kept a `ticket` for it, else straight to the IdP's account chooser.
 * `return_to` serves only when the ticket can no longer be used.
 */
export function switchPath(returnTo: string, ticket: string | null): string {
  if (ticket === null) return startPath(returnTo, true);
  return `/auth/oidc/switch?${new URLSearchParams({ return_to: returnTo, ticket })}`;
}

/** The browser's binding secret, when it holds one Pinwall could have minted. */
function heldBindingSecret(c: Context<AppEnv>): string | undefined {
  const value = getCookie(c, oidcBindingCookieName(c.var.deps.config));
  return value !== undefined && BINDING_SECRET.test(value) ? value : undefined;
}

/** Sets the binding cookie, or renews it, for the next ten minutes. */
function setBindingCookie(c: Context<AppEnv>, browserSecret: string): void {
  const { config } = c.var.deps;
  setCookie(c, oidcBindingCookieName(config), browserSecret, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.publicHttps,
    maxAge: PENDING_LOGIN_TTL_MS / 1000,
  });
}

/** Redirects to the IdP to sign in, leading back to `returnTo`, which must already be safe. */
async function redirectToSignIn(
  c: Context<AppEnv>,
  p: { returnTo: string; selectAccount: boolean },
): Promise<Response> {
  // One secret per browser, so sign-ins started in several tabs all finish.
  const browserSecret = heldBindingSecret(c) ?? newSecret();
  const location = await beginOidcSignIn(c.var.deps, { ...p, browserSecret });
  setBindingCookie(c, browserSecret);
  return c.redirect(location, 302);
}

const FAILURE_PAGES: Record<OidcFailure, { status: ContentfulStatusCode; keys: string }> = {
  not_configured: { status: 404, keys: 'oidc.notConfigured' },
  unavailable: { status: 502, keys: 'oidc.unavailable' },
  expired: { status: 400, keys: 'oidc.expired' },
  other_browser: { status: 400, keys: 'oidc.otherBrowser' },
  cancelled: { status: 400, keys: 'oidc.cancelled' },
  failed: { status: 400, keys: 'oidc.failed' },
};

/**
 * The HTML page for anything a sign-in route throws, whatever the request accepts: the page of
 * a sign-in failure, the rate limit, or the generic server error, which is logged in full. No
 * text from the IdP ever reaches it.
 */
function errorPage(c: Context<AppEnv>, err: unknown): Response {
  const { deps, requestId } = c.var;
  const idp = deps.config.oidc?.displayName ?? '';
  const home = { label: t('error.goHome'), href: '/' };
  let page: {
    status: ContentfulStatusCode;
    title: string;
    message: string;
    actions?: (typeof home)[];
  };
  if (err instanceof OidcFlowError) {
    const { status, keys } = FAILURE_PAGES[err.failure];
    page = {
      status,
      title: t(`${keys}.title`, { idp }),
      message: t(`${keys}.message`, { idp }),
      actions:
        err.failure === 'not_configured'
          ? [home]
          : [{ label: t('oidc.tryAgain'), href: startPath(err.returnTo, false) }],
    };
  } else if (err instanceof AppError && err.code === 'rate_limited') {
    const retryAfter = err.details?.retry_after_seconds;
    if (typeof retryAfter === 'number') c.header('Retry-After', String(retryAfter));
    page = { status: 429, title: t('oidc.rateLimited.title'), message: err.message };
  } else {
    deps.logger.error(
      { err, request_id: requestId, method: c.req.method, path: loggablePath(c.req.path) },
      'Request failed with an unexpected error',
    );
    page = {
      status: 500,
      title: t('error.server.title'),
      message: t('error.server.message'),
      actions: [home],
    };
  }
  return c.html(renderErrorPage({ ...page, requestId }), page.status);
}

/** Runs a sign-in route: never cached, and every failure is an HTML page. */
function signInRoute(handler: (c: Context<AppEnv>) => Promise<Response>) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    c.header('Cache-Control', 'no-store');
    try {
      return await handler(c);
    } catch (err) {
      return errorPage(c, err);
    }
  };
}

/**
 * The browser half of OIDC sign-in: `GET /auth/oidc/start` and `GET /auth/oidc/callback`, and
 * for "Use a different account" `GET /auth/oidc/switch` and `GET /auth/oidc/signed-out`.
 */
export function buildOidcRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get(
    '/start',
    signInRoute(async (c) => {
      const { config } = c.var.deps;
      if (config.oidc === null) throw new OidcFlowError('not_configured', '/');
      await enforceRateLimit(c, OIDC_START_RATE);
      return redirectToSignIn(c, {
        returnTo: safeReturnTo(c.req.query('return_to'), config.publicOrigin),
        selectAccount: c.req.query('prompt') === 'select_account',
      });
    }),
  );

  // The no-access page's "Use a different account": signs out at the IdP first when it can,
  // else asks the IdP for its account chooser, as `/start?prompt=select_account` does.
  router.get(
    '/switch',
    signInRoute(async (c) => {
      const { deps } = c.var;
      const { config } = deps;
      if (config.oidc === null) throw new OidcFlowError('not_configured', '/');
      await enforceRateLimit(c, OIDC_START_RATE);
      const browserSecret = heldBindingSecret(c);
      const location = await beginAccountSwitch(deps, {
        ticket: c.req.query('ticket'),
        browserSecret,
      });
      if (location !== null && browserSecret !== undefined) {
        // The browser must still hold it when the IdP sends it back.
        setBindingCookie(c, browserSecret);
        return c.redirect(location, 302);
      }
      return redirectToSignIn(c, {
        returnTo: safeReturnTo(c.req.query('return_to'), config.publicOrigin),
        selectAccount: true,
      });
    }),
  );

  // The IdP's post-logout redirect: a fresh sign-in, leading where the refused one was going
  // when the return is the one this browser started, else home.
  router.get(
    '/signed-out',
    signInRoute(async (c) => {
      const { deps } = c.var;
      const { config } = deps;
      if (config.oidc === null) throw new OidcFlowError('not_configured', '/');
      await enforceRateLimit(c, OIDC_START_RATE);
      const returnTo = await finishAccountSwitch(deps, {
        state: c.req.query('state'),
        browserSecret: heldBindingSecret(c),
      });
      return redirectToSignIn(c, {
        returnTo: safeReturnTo(returnTo ?? '/', config.publicOrigin),
        selectAccount: true,
      });
    }),
  );

  router.get(
    '/callback',
    signInRoute(async (c) => {
      const { deps } = c.var;
      const { config } = deps;
      if (config.oidc === null) throw new OidcFlowError('not_configured', '/');
      await enforceRateLimit(c, OIDC_CALLBACK_RATE);
      const browserSecret = heldBindingSecret(c);
      const outcome = await finishOidcSignIn(deps, {
        query: new URL(c.req.url).search,
        browserSecret,
      });
      if (outcome.kind === 'admitted') {
        await startSession(c, outcome.user, 'oidc');
        // Absolute, on the public origin, and checked again: the pending login stored a safe path.
        return c.redirect(
          publicUrl(config, safeReturnTo(outcome.returnTo, config.publicOrigin)),
          302,
        );
      }
      const page = renderNoAccessPage({
        idp: config.oidc.displayName,
        name: outcome.identity.name,
        email: outcome.identity.email,
        emailVerified: outcome.identity.emailVerified,
        switchHref: switchPath(outcome.returnTo, outcome.switchTicket),
        retried: outcome.selectAccount,
        requestId: c.var.requestId,
      });
      // The switch link needs the binding cookie for as long as its ticket lasts.
      if (outcome.switchTicket !== null && browserSecret !== undefined) {
        setBindingCookie(c, browserSecret);
      }
      return c.html(page, 403);
    }),
  );

  return router;
}
