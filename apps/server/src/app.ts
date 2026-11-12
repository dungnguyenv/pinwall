import { Hono } from 'hono';
import { buildApiRouter } from './api/router.ts';
import { buildOidcRouter } from './auth/oidc/routes.ts';
import { resolveAuth } from './auth/resolve.ts';
import { bearerResolvers } from './auth/resolvers.ts';
import { type ContentHooks, contentHooks } from './content/hooks.ts';
import { mountRawLinks } from './content/raw-links.ts';
import { mountContent } from './content/routes.ts';
import { mountShareLinks } from './content/share-route.ts';
import type { UserRow } from './db/schema.ts';
import type { AppDeps } from './deps.ts';
import { errorHandler, notFoundHandler } from './http/errors.ts';
import { requestLogger } from './http/logging.ts';
import { originCheck } from './http/origin-check.ts';
import { requestId } from './http/request-id.ts';
import { appSecurityHeaders } from './http/security-headers.ts';
import { defaultWebDir, mountSpa } from './http/spa.ts';
import { mountMcp } from './mcp/route.ts';
import { mountOAuth } from './oauth/routes.ts';
import { httpMetrics } from './ops/metrics.ts';
import { PAGES_CSS, PAGES_CSS_PATH } from './pages/pages.css.ts';
import { mountUploadRoute } from './publish/upload-route.ts';

/** Who is making the request, once `resolveAuth` has run. */
export interface AuthContext {
  user: UserRow;
  via: 'session' | 'api_token' | 'oauth';
  sessionId?: string;
}

export type AppEnv = {
  Variables: { requestId: string; deps: AppDeps; auth: AuthContext | null };
};

/** A readiness check that hangs counts as failed instead of holding the probe open. */
const CHECK_TIMEOUT_MS = 5_000;

async function withTimeout(probe: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No answer within ${CHECK_TIMEOUT_MS} ms`)),
      CHECK_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function mountHealth(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get('/healthz', (c) => c.json({ status: 'ok' }, 200, { 'Cache-Control': 'no-store' }));

  app.get('/readyz', async (c) => {
    const probes = { database: () => deps.db.ping(), storage: () => deps.blobs.check() };
    const results = await Promise.all(
      Object.entries(probes).map(async ([name, probe]) => {
        try {
          await withTimeout(probe());
          return [name, 'ok'] as const;
        } catch (err) {
          deps.logger.warn({ err, check: name }, `Readiness check failed: ${name}`);
          return [name, 'failed'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const ready = Object.values(checks).every((result) => result === 'ok');
    return c.json({ status: ready ? 'ok' : 'unavailable', checks }, ready ? 200 : 503, {
      'Cache-Control': 'no-store',
    });
  });
}

/**
 * The app origin. Middleware runs in this order: request id, request log, deps injection, HTTP
 * metrics, the content router (which answers content requests itself, so they never get app
 * headers or have their cookies read), security headers; then health checks, the pages
 * stylesheet, the API router behind the CSRF origin check and auth resolution, later
 * milestones' routers, and the SPA last, since it answers every remaining browser GET.
 * `opts.contentHooks` replaces the shipped content hooks (tests).
 */
export function buildApp(deps: AppDeps, opts: { contentHooks?: ContentHooks } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(requestLogger(deps.logger, deps.config));
  app.use(async (c, next) => {
    c.set('deps', deps);
    c.set('auth', null);
    await next();
  });
  // After deps injection and before the content router, so content requests are counted too.
  app.use(httpMetrics(deps.metrics, deps.config));
  mountContent(app, opts.contentHooks ?? contentHooks);
  app.use(appSecurityHeaders(deps.config));

  mountHealth(app, deps);
  app.get(PAGES_CSS_PATH, (c) =>
    c.body(PAGES_CSS, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      // Pages link it with a content hash in the query, so a year is safe.
      'Cache-Control': 'public, max-age=31536000, immutable',
    }),
  );

  app.use(
    '/api/v1/*',
    originCheck(deps.config),
    resolveAuth({ bearer: bearerResolvers, cookies: true }),
  );
  app.route('/api/v1', buildApiRouter());
  // The upload token is its only credential: no origin check, no cookie or bearer auth.
  mountUploadRoute(app);
  app.route('/auth/oidc', buildOidcRouter());
  // `/a/:id/raw` and `/a/:id/v/:n/raw` take a cookie or a bearer token; the SPA owns `/a/:id`.
  mountRawLinks(app);
  // `/s/:token` needs no account; links that open the share viewer fall through to the SPA.
  mountShareLinks(app);
  // OAuth metadata and `/oauth/*`: no cookies on its machine endpoints, no origin check.
  mountOAuth(app);
  // `/mcp`: bearer only (OAuth access token or API token), never cookies.
  mountMcp(app);

  mountSpa(app, deps.config.webDir ?? defaultWebDir(), deps.logger);

  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  return app;
}
