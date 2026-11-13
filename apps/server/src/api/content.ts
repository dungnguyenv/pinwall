import { Readable } from 'node:stream';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { ContentGrant, ErrorBody, PreviewQuery } from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { authOf, requireAuth } from '../auth/guards.ts';
import { perUser, RATE_RULES } from '../auth/rate-limits.ts';
import { contentUrl, createGrant } from '../content/grants.ts';
import { hasRasterSignature, isRasterImage, RASTER_SIGNATURE_BYTES } from '../content/mime.ts';
import { THUMBNAIL_CSP } from '../content/raw-links.ts';
import { noneMatch } from '../content/serve.ts';
import type { VersionFileRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { getArtifact, recordView } from '../domain/artifacts.ts';
import { type Scope, scopeOf } from '../domain/spaces.ts';
import { getCurrentVersion, getVersionByNumber } from '../domain/versions.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { IdParam, VersionNumber } from './pagination.ts';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const security: Record<string, string[]>[] = [{ session: [] }, { bearer: [] }];
const authErrors = {
  401: error('Not signed in'),
  403: error('A cross-site request with the session cookie (`forbidden`)'),
};

const previewRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/versions/{n}/preview',
  tags: ['versions'],
  summary: 'Get a short-lived URL to the files of a version',
  description:
    'Issues a new content URL for version `n`, valid until `expires_at` (`PINWALL_PREVIEW_TTL`, and never past the end of your identity-provider access). `mode=review` (the default) is what the review page frames and counts as opening the artifact; `mode=raw` serves the stored files as they are. The URL depends on the isolation mode the server runs in, so do not store it: link to the artifact instead. Limited to 600 previews and raw links per user per hour.',
  middleware: [requireAuth, perUser(RATE_RULES.grant)] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam.extend({ n: VersionNumber }), query: PreviewQuery },
  responses: {
    200: {
      description: 'The content URL',
      content: { 'application/json': { schema: ContentGrant } },
    },
    400: error('A bad `n` or `mode`'),
    ...authErrors,
    404: error('The artifact or the version does not exist (`not_found`)'),
    410: error('The artifact or the version was deleted (`gone`)'),
    429: error('Over the limit of previews and raw links (`rate_limited`)'),
  },
});

/** A response body of raw bytes, as OpenAPI describes one. */
const binary = { schema: { type: 'string' as const, format: 'binary' } };

const thumbnailRoute = createRoute({
  method: 'get',
  path: '/artifacts/{id}/thumbnail',
  tags: ['artifacts'],
  summary: "The thumbnail image of an artifact's current version",
  description:
    "The image the current version's entry page names in `og:image`, else its first image, when that is a PNG, JPEG, WebP, GIF or AVIF file whose bytes are of that type. SVG and other files are never served here; without a thumbnail, show a generated card.",
  middleware: [requireAuth] as MiddlewareHandler<AppEnv>[],
  security,
  request: { params: IdParam },
  responses: {
    200: {
      description: 'The image, as stored',
      content: {
        'image/png': binary,
        'image/jpeg': binary,
        'image/webp': binary,
        'image/gif': binary,
        'image/avif': binary,
      },
    },
    304: { description: 'Unchanged since the `ETag` sent in `If-None-Match`' },
    ...authErrors,
    404: error('The artifact does not exist or has no raster thumbnail (`not_found`)'),
    410: error('The artifact was deleted (`gone`)'),
  },
});

/**
 * The thumbnail file of the current version of an artifact `scope` sees, when it can be served
 * from the app origin: a raster type by its name, and bytes that start the way that type does. A
 * file named `.png` that holds HTML or SVG is never served under an image type here, where it
 * would share the app's origin.
 */
async function thumbnailFile(
  deps: AppDeps,
  scope: Scope,
  artifactId: string,
): Promise<VersionFileRow> {
  const { db } = deps.db;
  const artifact = await getArtifact(db, scope, artifactId, deps.clock.now());
  const version = await getCurrentVersion(db, artifact);
  const file =
    version.thumbnail_path === null
      ? undefined
      : await db
          .selectFrom('version_files')
          .selectAll()
          .where('version_id', '=', version.id)
          .where('path', '=', version.thumbnail_path)
          .executeTakeFirst();
  if (file === undefined || !isRasterImage(file.content_type) || file.size === 0) {
    throw notFound(t('artifact.noThumbnail'));
  }
  const head = await openBlob(deps, file.sha256, {
    start: 0,
    end: Math.min(file.size, RASTER_SIGNATURE_BYTES) - 1,
  });
  if (!hasRasterSignature(file.content_type, Buffer.concat(await head.toArray()))) {
    throw notFound(t('artifact.noThumbnail'));
  }
  return file;
}

/**
 * A stored file's bytes. A blob a version still lists is never missing unless storage lost it,
 * so the store's `not_found` becomes a server error here, logged, not a 404 that reads as "no
 * thumbnail".
 */
async function openBlob(
  deps: AppDeps,
  sha256: string,
  range?: { start: number; end: number },
): Promise<Readable> {
  try {
    return await deps.blobs.get(sha256, range);
  } catch (error) {
    if (error instanceof AppError) {
      throw new Error(`The stored thumbnail ${sha256} cannot be read`, { cause: error });
    }
    throw error;
  }
}

const noStore = { 'Cache-Control': 'no-store' };

export function registerContentRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(previewRoute, async (c) => {
    const { deps } = c.var;
    const { user } = authOf(c);
    const { id, n } = c.req.valid('param');
    const { mode } = c.req.valid('query');
    const artifact = await getArtifact(deps.db.db, scopeOf(c), id, deps.clock.now());
    const version = await getVersionByNumber(deps.db.db, artifact, n);
    const grant = await createGrant(deps, { versionId: version.id, mode, user });
    if (mode === 'review') await recordView(deps, user.id, artifact.id);
    const body: ContentGrant = {
      url: contentUrl(deps.config, grant.token),
      mode,
      expires_at: grant.expires_at,
      isolation: deps.config.isolation.mode,
    };
    return c.json(body, 200, noStore);
  });

  api.openapi(thumbnailRoute, async (c) => {
    const { deps } = c.var;
    const file = await thumbnailFile(deps, scopeOf(c), c.req.valid('param').id);
    const etag = `"${file.sha256}"`;
    const headers = {
      'Content-Security-Policy': THUMBNAIL_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
    };
    if (noneMatch(c.req.header('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    const full = {
      ...headers,
      'Content-Type': file.content_type,
      'Content-Length': String(file.size),
    };
    // HEAD never opens the blob: an unread stream would hold its file or connection.
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: full });
    const stream = await openBlob(deps, file.sha256);
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: full,
    });
  });
}
