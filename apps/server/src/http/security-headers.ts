import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config/types.ts';

const HSTS = 'max-age=31536000';

/** Where the review frame may point: this origin, or every artifact host under the content origin. */
function frameSource(isolation: Config['isolation']): string {
  if (isolation.mode === 'single-domain') return "'self'";
  const { scheme, host, port } = isolation.contentOrigin;
  return `${scheme}://*.${host}${port === undefined ? '' : `:${port}`}`;
}

/** The app-page headers of the security model, computed once per configuration. */
function appSecurityHeaderValues(config: Config): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    `frame-src ${frameSource(config.isolation)}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(config.publicHttps ? { 'Strict-Transport-Security': HSTS } : {}),
  };
}

/**
 * Adds the app-page security headers to every response that passes through it, error pages
 * included. A header the route already set on purpose (a stricter CSP on an image, say) is kept.
 * Content responses are served before this middleware and never get these headers.
 */
export function appSecurityHeaders(config: Config): MiddlewareHandler {
  const headers = Object.entries(appSecurityHeaderValues(config));
  return async (c, next) => {
    await next();
    for (const [name, value] of headers) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}
