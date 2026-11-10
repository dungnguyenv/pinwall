import { Hono } from 'hono';
import { buildApiRouter } from './api/router.ts';
import type { UserRow } from './db/schema.ts';
import type { AppDeps } from './deps.ts';
import { errorHandler, notFoundHandler } from './http/errors.ts';
import { requestLogger } from './http/logging.ts';
import { requestId } from './http/request-id.ts';
import { appSecurityHeaders } from './http/security-headers.ts';
import { defaultWebDir, mountSpa } from './http/spa.ts';
import { PAGES_CSS, PAGES_CSS_PATH } from './pages/pages.css.ts';

/** Who is making the request, once authentication has run (M2). */
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
 * The app origin. Middleware runs in this order: request id, request log, deps injection,
 * security headers; then health checks, the pages stylesheet, the API router, later milestones'
 * routers, and the SPA last, since it answers every remaining browser GET.
 */
export function buildApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(requestLogger(deps.logger, deps.config));
  app.use(async (c, next) => {
    c.set('deps', deps);
    c.set('auth', null);
    await next();
  });
  app.use(appSecurityHeaders(deps.config));

  mountHealth(app, deps);
  app.get(PAGES_CSS_PATH, (c) =>
    c.body(PAGES_CSS, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      // Pages link it with a content hash in the query, so a year is safe.
      'Cache-Control': 'public, max-age=31536000, immutable',
    }),
  );

  app.route('/api/v1', buildApiRouter());

  mountSpa(app, deps.config.webDir ?? defaultWebDir(), deps.logger);

  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  return app;
}
