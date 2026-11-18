import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { methodNotAllowed } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { runDownload } from './download.ts';

/**
 * `GET /download/:token`: the one-time download URL `create_download_session` makes. The token in
 * the path is the only credential, as on `/upload/:token`: the route reads neither cookies nor
 * `Authorization`, and sets no cookie. The body is a tar.gz of the version, streamed as the client
 * takes it. Errors are JSON (`wantsHtml` leaves `/download/` out), and the route is not
 * rate-limited, since each token works once.
 *
 * A HEAD request is refused: Hono would run this handler for it, and a link preview or a
 * prefetch must not use the URL up.
 */
export function mountDownloadRoute(app: Hono<AppEnv>): void {
  app.get('/download/:token', async (c) => {
    if (c.req.method === 'HEAD') {
      c.header('Allow', 'GET');
      throw methodNotAllowed(t('download.method'));
    }
    const { body, filename } = await runDownload(c.var.deps, c.req.param('token'));
    return c.body(Readable.toWeb(body) as ReadableStream<Uint8Array>, 200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
}
