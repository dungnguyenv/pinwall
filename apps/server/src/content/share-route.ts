import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../app.ts';
import { enforceRateLimit } from '../auth/rate-limits.ts';
import {
  readUnlockCookie,
  resolveShare,
  SHARE_RATES,
  type ShareState,
  shareGrant,
  touchShareLink,
} from '../domain/share-access.ts';
import { shareUrl } from '../domain/shares.ts';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { renderErrorPage } from '../pages/error-page.tsx';
import { contentUrl } from './grants.ts';

/**
 * Mounts `GET /s/:token`, the page a share link opens, and `GET /s/:token/original`, the share
 * viewer's "Open original". No account is involved: the token and the unlock cookie are the only
 * credentials. `/s/:token`, in order:
 * 1. the open counts against `SHARE_RATES.open` (per address);
 * 2. a link that cannot be opened answers an HTML page (404, or 410 for one revoked, expired or
 *    deleted), whatever the client accepts: people follow these links;
 * 3. its last use is recorded;
 * 4. a link still locked by its password, or one open to comments, gets the SPA's share viewer
 *    (the next route serves `index.html`);
 * 5. any other link redirects to a new raw grant, which serves the stored bytes unchanged.
 * `/s/:token/original` makes the same checks, sends a locked link to `/s/:token` (the password
 * page, whose unlock cookie also covers this path), and redirects any other link to a new raw
 * grant, so a link with comments, whose viewer frames a review grant with the annotator, still
 * has a byte-for-byte path. Nothing either answers may be cached: each answer depends on the
 * link's state at that moment. Mount them before the SPA.
 */
export function mountShareLinks(app: Hono<AppEnv>): void {
  app.get('/s/:token', async (c, next) => {
    const state = await openLink(c);
    if (state instanceof Response) return state;
    await touchShareLink(c.var.deps, state.link);

    if (state.locked || state.link.allow_comments === 1) {
      await next();
      c.res.headers.set('Cache-Control', 'no-store');
      return;
    }
    return redirectToRaw(c, state);
  });

  app.get('/s/:token/original', async (c) => {
    const state = await openLink(c);
    if (state instanceof Response) return state;
    if (state.locked) return c.redirect(shareUrl(c.var.deps.config, c.req.param('token')), 302);
    await touchShareLink(c.var.deps, state.link);
    return redirectToRaw(c, state);
  });
}

/**
 * The link the request's token names, once the open has counted against `SHARE_RATES.open`; or
 * the HTML page that answers a link that cannot be opened, or an open over the limit.
 */
async function openLink(c: Context<AppEnv>): Promise<ShareState | Response> {
  c.header('Cache-Control', 'no-store');
  try {
    await enforceRateLimit(c, SHARE_RATES.open);
    return await resolveShare(c.var.deps, c.req.param('token') ?? '', readUnlockCookie(c));
  } catch (err) {
    return linkErrorPage(c, err);
  }
}

/** A redirect to a new raw grant to what `state` shows: the stored bytes, unchanged. */
async function redirectToRaw(c: Context<AppEnv>, state: ShareState): Promise<Response> {
  let token: string;
  try {
    token = (await shareGrant(c.var.deps, state, 'raw')).token;
  } catch (err) {
    // The link was revoked, expired or deleted after it was read.
    return linkErrorPage(c, err);
  }
  return c.redirect(contentUrl(c.var.deps.config, token), 302);
}

/**
 * The HTML page for a share link that cannot be opened, or an open refused by the rate limit.
 * The copy speaks of the link only. Anything that is not a 4xx `AppError` goes on to the app's
 * error handler.
 */
function linkErrorPage(c: Context<AppEnv>, err: unknown): Response {
  if (!(err instanceof AppError) || err.status < 400 || err.status >= 500) throw err;
  const copy =
    err.status === 404
      ? 'share.notFound'
      : err.status === 410
        ? err.details?.reason === 'expired'
          ? 'share.expired'
          : 'share.gone'
        : null;
  const retryAfter = err.details?.retry_after_seconds;
  if (err.code === 'rate_limited' && typeof retryAfter === 'number') {
    c.header('Retry-After', String(retryAfter));
  }
  const page = renderErrorPage({
    status: err.status,
    title: copy === null ? t('error.client.title') : t(`${copy}.title`),
    message: copy === null ? err.message : t(`${copy}.message`),
    requestId: c.var.requestId,
    // Only the pages that say the link is missing or ended.
    ...(err.status === 404 || err.status === 410
      ? { abuseContact: c.var.deps.config.abuseContact }
      : {}),
  });
  return c.html(page, err.status as ContentfulStatusCode);
}
