import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Env, Hono } from 'hono';
import type { Logger } from '../lib/logger.ts';
import { wantsHtml } from './errors.ts';

/** Vite puts content-hashed files here, so they never change under the same name. */
const IMMUTABLE_PREFIX = '/assets/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

/**
 * Where the built SPA lives when `PINWALL_WEB_DIR` is unset: `web/` beside the bundled
 * `main.mjs` (the server bundle is one file, so this module's URL is the bundle's).
 */
export function defaultWebDir(): string {
  return fileURLToPath(new URL('./web', import.meta.url));
}

/**
 * Serves the SPA from `dir`: its files as they are (hashed assets cached for a year, the rest
 * revalidated), and `index.html` for any other GET from a browser asking for a page. Mount it
 * after every other route. API paths and non-browser clients fall through to the 404 handler.
 * Without `index.html` in `dir` nothing is mounted and browsers get the HTML 404 page.
 */
export function mountSpa<E extends Env>(app: Hono<E>, dir: string, logger: Logger): void {
  const indexFile = join(dir, 'index.html');
  if (!existsSync(indexFile)) {
    logger.warn(
      { web_dir: dir },
      'The web app is not available: index.html is missing. Set PINWALL_WEB_DIR to the built SPA.',
    );
    return;
  }

  const files = serveStatic<E>({ root: dir });
  // Hono answers HEAD with the GET routes, so these cover both.
  app.get('*', async (c, next) => {
    const found = await files(c, next);
    // `files` returns a Response only when it served a file; otherwise it already ran `next`.
    if (found instanceof Response) {
      found.headers.set(
        'Cache-Control',
        c.req.path.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE : REVALIDATE,
      );
    }
    return found;
  });
  app.get('*', async (c, next) => {
    if (!wantsHtml(c)) return next();
    const page = await readFile(indexFile, 'utf8');
    return c.html(page, 200, { 'Cache-Control': REVALIDATE });
  });
}
