import type { Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { safeReturnTo } from '../auth/oidc/return-to.ts';
import { resolveAuth } from '../auth/resolve.ts';
import { bearerResolvers } from '../auth/resolvers.ts';
import { getArtifact } from '../domain/artifacts.ts';
import { getCurrentVersion, getVersionByNumber } from '../domain/versions.ts';
import { wantsHtml } from '../http/errors.ts';
import { publicUrl } from '../http/public-url.ts';
import { unauthorized } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { contentUrl, createGrant } from './grants.ts';

/**
 * The policy of artifact bytes the app origin serves itself (thumbnails): nothing loads, nothing
 * runs, and a document opened from it gets an opaque origin.
 */
export const THUMBNAIL_CSP = "default-src 'none'; sandbox";

/** A version number in a link: digits only, so `1.5`, `01x` or `1e3` name no version. */
const VERSION_NUMBER = /^\d{1,15}$/;

/**
 * Mounts the raw links people hold: `/a/:artifactId/raw` (the current version) and
 * `/a/:artifactId/v/:n/raw` (version `n`). Each request mints a new raw grant for the caller and
 * redirects to it in the isolation mode of the moment, so the link outlives every grant and a
 * change of mode. Signed-in members only, by session cookie or bearer token; a browser without
 * a session is sent to sign in and comes back here. Mount it before the SPA.
 */
export function mountRawLinks(app: Hono<AppEnv>): void {
  const auth = resolveAuth({ bearer: bearerResolvers, cookies: true });
  app.get('/a/:artifactId/raw', auth, (c) => redirectToRaw(c, null));
  app.get('/a/:artifactId/v/:n/raw', auth, (c) => redirectToRaw(c, c.req.param('n')));
}

/**
 * Sends the caller to a fresh raw grant on version `n` of the artifact, or on its current version
 * when `n` is null. The link's query (`?source` of a Markdown file, say) goes along. The answer
 * depends on who asks, so nothing caches it. A missing artifact or version is 404 and a deleted
 * one 410, through the app's error pages, but only once the caller is known: until then nobody
 * learns whether the artifact exists.
 */
async function redirectToRaw(c: Context<AppEnv>, n: string | null): Promise<Response> {
  const { deps, auth } = c.var;
  const url = new URL(c.req.url);
  c.header('Cache-Control', 'no-store');
  if (auth === null) {
    if (!wantsHtml(c)) throw unauthorized(t('auth.signInRequired'));
    const returnTo = safeReturnTo(url.pathname + url.search, deps.config.publicOrigin);
    return c.redirect(
      publicUrl(deps.config, `/signin?return_to=${encodeURIComponent(returnTo)}`),
      302,
    );
  }

  const { db } = deps.db;
  const artifact = await getArtifact(db, c.req.param('artifactId') ?? '', deps.clock.now());
  const version =
    n === null
      ? await getCurrentVersion(db, artifact)
      : await getVersionByNumber(db, artifact, VERSION_NUMBER.test(n) ? Number(n) : Number.NaN);
  const grant = await createGrant(deps, { versionId: version.id, mode: 'raw', user: auth.user });
  return c.redirect(contentUrl(deps.config, grant.token) + url.search, 302);
}
