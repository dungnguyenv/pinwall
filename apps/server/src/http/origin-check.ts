import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import type { Config } from '../config/types.ts';
import { forbidden } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The `Authorization` scheme that skips the check; scheme names are case-insensitive. */
const BEARER_SCHEME = /^Bearer\s/i;

/**
 * CSRF defence for cookie-authenticated requests: a request that can change something must say
 * it comes from the public origin itself. `Origin` must equal `PINWALL_PUBLIC_ORIGIN` (a missing
 * or `null` Origin fails), and `Sec-Fetch-Site`, when sent, must be `same-origin`. Requests with
 * an `Authorization: Bearer` header are exempt: `resolveAuth` never reads their cookies, and a
 * page on another site cannot add that header without a CORS preflight Pinwall never grants. Any
 * other scheme is not: a browser sends Basic credentials by itself, like a cookie.
 */
export function originCheck(config: Config): MiddlewareHandler<AppEnv> {
  const expected = config.publicOrigin;
  return async (c, next) => {
    const bearer = BEARER_SCHEME.test(c.req.header('authorization') ?? '');
    if (!SAFE_METHODS.has(c.req.method) && !bearer) {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      if (origin !== expected || (site !== undefined && site !== 'same-origin')) {
        throw forbidden(t('auth.crossOrigin', { origin: origin ?? '(none)', expected }), {
          origin: origin ?? null,
          expected_origin: expected,
        });
      }
    }
    await next();
  };
}
