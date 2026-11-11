import type { Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { Config } from '../config/types.ts';
import { notFoundHandler } from '../http/errors.ts';
import { appSecurityHeaders } from '../http/security-headers.ts';
import { isContentToken } from './grants.ts';
import type { ContentHooks } from './hooks.ts';
import { contentErrorResponse, redirectToGrantRoot, serveContent } from './serve.ts';

/**
 * What `hostname` is in content-domain mode: a grant's own host (its token), a name under the
 * content host that carries no valid token (`'unknown'`: the bare content host, a deeper or
 * malformed label), or not a content host at all (null, always in single-domain mode). Host
 * names compare without case and without a trailing dot.
 */
export function contentHostToken(config: Config, hostname: string): string | 'unknown' | null {
  if (config.isolation.mode !== 'content-domain') return null;
  const contentHost = withoutTrailingDot(config.isolation.contentOrigin.host.toLowerCase());
  const name = withoutTrailingDot(hostname.toLowerCase());
  if (name === contentHost) return 'unknown';
  if (!name.endsWith(`.${contentHost}`)) return null;
  const label = name.slice(0, -(contentHost.length + 1));
  return isContentToken(label) ? label : 'unknown';
}

function withoutTrailingDot(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

/**
 * Mounts the content router. `buildApp` calls it before the app-page headers and every route,
 * so content answers before anything that could add app headers or read a cookie, and nothing
 * after it ever sees a content request.
 *
 * - Content-domain mode: every request to a host under the content host is content, whatever
 *   its path; the host comes from the request URL, which `@hono/node-server` builds from `Host`
 *   (never `X-Forwarded-Host`). `/c/*` on any other host is the app's 404.
 * - Single-domain mode: `/c/<token>/…` is content, and `/c/<token>` redirects to its root.
 *
 * The isolation mode is read from the config on each request; it is fixed for the process.
 */
export function mountContent(app: Hono<AppEnv>, hooks: ContentHooks): void {
  app.use('*', async (c, next) => {
    const { config } = c.var.deps;
    if (config.isolation.mode !== 'content-domain') return next();
    const url = new URL(c.req.url);
    const token = contentHostToken(config, url.hostname);
    if (token === null) return next();
    if (token === 'unknown') return contentErrorResponse(c, 'not_found');
    return serveContent(c, token, url.pathname.slice(1), hooks);
  });

  app.all('/c/*', async (c) => {
    if (c.var.deps.config.isolation.mode === 'content-domain') return appNotFound(c);
    const [, , token = '', ...rest] = new URL(c.req.url).pathname.split('/');
    if (rest.length === 0) return redirectToGrantRoot(c, token);
    return serveContent(c, token, rest.join('/'), hooks);
  });
}

/**
 * The app's own 404, app-page headers included, for `/c/*` on the app host in content-domain
 * mode. This route runs before `appSecurityHeaders` is reached, so it applies it itself.
 */
async function appNotFound(c: Context<AppEnv>): Promise<Response> {
  await appSecurityHeaders(c.var.deps.config)(c, async () => {
    c.res = await notFoundHandler(c);
  });
  return c.res;
}
