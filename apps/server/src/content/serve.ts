import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import type { Config } from '../config/types.ts';
import type { VersionFileRow, VersionRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { loggablePath } from '../http/logging.ts';
import { AppError } from '../lib/errors.ts';
import { RESERVED_DIR } from '../publish/paths.ts';
import { type ContentErrorKind, renderContentErrorPage } from './error-page.ts';
import { contentBaseUrl, type ResolvedGrant, resolveGrant } from './grants.ts';
import type { ContentHooks } from './hooks.ts';
import {
  MARKDOWN_RENDER_MAX_BYTES,
  renderMarkdownPage,
  renderMarkdownTooLargePage,
} from './markdown.ts';
import { isHtmlType, isMarkdownType } from './mime.ts';

/** Single-domain mode: content runs in an opaque origin, never the app's (no allow-same-origin). */
export const CONTENT_SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';

const HTML = 'text/html; charset=utf-8';

/** Invalid UTF-8 becomes U+FFFD and a BOM is dropped, so a stored Markdown file always renders. */
const utf8 = new TextDecoder('utf-8');

const ERROR_STATUS: Record<ContentErrorKind, number> = {
  not_found: 404,
  gone: 410,
  expired: 410,
  error: 500,
  framed_only: 403,
};

/** Directory requests try these, in order. */
const INDEX_NAMES = ['index.html', 'index.md'] as const;

/** What a content URL answers to; `OPTIONS` only as a CORS preflight. */
const ALLOW = 'GET, HEAD, OPTIONS';

/** A comma-separated list of header names, as `Access-Control-Request-Headers` carries it. */
const HEADER_NAMES = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:[ \t]*,[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+)*$/;

/**
 * The headers of every content response, errors and redirects included: nothing of the app's
 * (no `X-Frame-Options`, no cookie). The sandbox policy is added in single-domain mode, where
 * content shares the app's origin. A response for a `framedOnly` grant also carries
 * `frame-ancestors 'self' <app origin>`, so only Pinwall's own pages, and the artifact's own
 * nested frames, can frame it; in single-domain mode it joins the sandbox policy. An error
 * response (`status` 400 or more) is never cached: the file, the grant or the blob it lacks may
 * be back a moment later.
 *
 * Every response allows any origin to read it (CORS). A document sandboxed without
 * `allow-same-origin` has an opaque origin, so its requests for its own files (module scripts,
 * fonts, `fetch`) are cross-origin with `Origin: null`, and the browser would block them. The URL
 * is the capability and content never reads cookies, so `*` lets nobody read more than what the
 * URL already gives; credentials are never allowed.
 */
export function contentHeaders(
  config: Config,
  status = 200,
  framedOnly = false,
): Record<string, string> {
  const policies = [
    ...(config.isolation.mode === 'single-domain' ? [CONTENT_SANDBOX_CSP] : []),
    ...(framedOnly ? [`frame-ancestors 'self' ${config.publicOrigin}`] : []),
  ];
  return {
    'Cache-Control':
      status >= 400 ? 'no-store, no-transform' : 'private, max-age=300, no-transform',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, ETag',
    ...(policies.length === 0 ? {} : { 'Content-Security-Policy': policies.join('; ') }),
  };
}

/**
 * Answers a request for `rawPath` (the request path after the grant's base, still
 * percent-encoded) inside the grant `token`. Only the token authorizes it: cookies and
 * `Authorization` are never read, and nothing sets a cookie. Every error is answered here with a
 * content error page, so the app's error pages and headers never appear on content. Every answer
 * for a framed-only grant carries its `frame-ancestors` policy.
 */
export function serveContent(
  c: Context<AppEnv>,
  token: string,
  rawPath: string,
  hooks: ContentHooks,
): Promise<Response> {
  return guarded(c, async () => {
    const resolved = await grantOrErrorPage(c, token);
    if (resolved instanceof Response) return resolved;
    const framed = resolved.framedOnly === true;

    const segments = decodePath(rawPath);
    if (segments === null) return contentErrorResponse(c, 'not_found', framed);
    if (segments[0] === RESERVED_DIR) {
      return reservedAsset(c, hooks, segments.slice(1).join('/'), framed);
    }

    const path = segments.join('/');
    const found = await findFile(c.var.deps, resolved.version, path);
    if (found === 'missing') return contentErrorResponse(c, 'not_found', framed);
    if (found === 'directory') {
      // Relative, so it works under `/c/<token>/` and on a content host alike. Encoding the
      // segment again keeps a name like `x:y` from reading as a scheme.
      const location = `${encodeURIComponent(segments.at(-1) ?? '')}/${new URL(c.req.url).search}`;
      return reply(c, 308, { Location: location }, null, framed);
    }
    return serveFile(c, resolved, found, path, hooks);
  });
}

/** `/c/<token>` without its slash, in single-domain mode: 308 to the grant's root once it is good. */
export function redirectToGrantRoot(c: Context<AppEnv>, token: string): Promise<Response> {
  return guarded(c, async () => {
    const resolved = await grantOrErrorPage(c, token);
    if (resolved instanceof Response) return resolved;
    const location = `${token}/${new URL(c.req.url).search}`;
    return reply(c, 308, { Location: location }, null, resolved.framedOnly === true);
  });
}

/**
 * A content error page with the content headers, and the `frame-ancestors` policy when it answers
 * for a `framedOnly` grant; HEAD gets the headers alone.
 */
export function contentErrorResponse(
  c: Context<AppEnv>,
  kind: ContentErrorKind,
  framedOnly = false,
): Response {
  const page = renderContentErrorPage(kind, c.var.deps.config.abuseContact);
  return reply(c, ERROR_STATUS[kind], { 'Content-Type': HTML }, page, framedOnly);
}

/** What an app page may open content as in single-domain mode: a page or a frame. */
const APP_DESTINATIONS = new Set(['document', 'iframe', 'frame']);

/**
 * Whether an app page is loading content as a subresource of its own, in single-domain mode.
 *
 * There, content shares the app's origin, so the app's `script-src 'self'` would also let
 * `<script src="/c/<token>/x.js">`, injected into any app page, run an artifact's JavaScript with
 * the app's session; any member can host such a file. App pages must never load artifact code as
 * a script, a stylesheet, a worker or through `fetch`. Fetch metadata tells these apart: the
 * content's own loads come from its sandboxed, opaque origin and are `cross-site`; the review
 * frame and a raw link opened from the app are `same-origin` with destination `iframe` or
 * `document`; a typed URL is `none`. Any other `same-origin` request can only be an app page
 * using artifact files as its own, and is refused. A request without these headers (an older
 * browser, curl) is served: this is defense in depth behind the app's CSP.
 */
function isAppSubresource(c: Context<AppEnv>): boolean {
  if (c.var.deps.config.isolation.mode !== 'single-domain') return false;
  if (c.req.header('sec-fetch-site') !== 'same-origin') return false;
  const destination = c.req.header('sec-fetch-dest');
  return destination === undefined || !APP_DESTINATIONS.has(destination);
}

/**
 * Refuses an app page's subresource load (403), serves GET and HEAD, answers a CORS preflight
 * (`OPTIONS`), refuses other methods, and turns anything `serve` throws into the content 500
 * page.
 */
async function guarded(c: Context<AppEnv>, serve: () => Promise<Response>): Promise<Response> {
  if (isAppSubresource(c)) return reply(c, 403, {}, null);
  if (c.req.method === 'OPTIONS') return preflight(c);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return reply(c, 405, { Allow: ALLOW }, null);
  }
  try {
    return await serve();
  } catch (err) {
    c.var.deps.logger.error(
      {
        err,
        request_id: c.var.requestId,
        method: c.req.method,
        path: loggablePath(c.req.path),
      },
      'A content request failed',
    );
    return contentErrorResponse(c, 'error');
  }
}

/**
 * The answer to a CORS preflight: reading is allowed, with whatever request headers the page
 * asks for (content ignores all but `Range` and the conditional ones, so allowing more grants
 * nothing). It never looks the grant up: the request that follows does, and answers for it.
 */
function preflight(c: Context<AppEnv>): Response {
  const headers: Record<string, string> = {
    Allow: ALLOW,
    'Access-Control-Allow-Methods': 'GET, HEAD',
    Vary: 'Access-Control-Request-Headers',
  };
  const requested = c.req.header('access-control-request-headers')?.trim();
  if (requested !== undefined && HEADER_NAMES.test(requested)) {
    headers['Access-Control-Allow-Headers'] = requested;
  }
  return reply(c, 204, headers, null);
}

/**
 * The grant, or the page that says why it does not answer this request: there is none (404, 410
 * gone, 410 expired), or it is `framedOnly` and this is a top-level load (403), refused before
 * any file is looked up.
 */
async function grantOrErrorPage(
  c: Context<AppEnv>,
  token: string,
): Promise<ResolvedGrant | Response> {
  let resolved: ResolvedGrant;
  try {
    resolved = await resolveGrant(c.var.deps, token);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.status === 404) return contentErrorResponse(c, 'not_found');
    if (err.status === 410) {
      return contentErrorResponse(c, err.details?.expired === true ? 'expired' : 'gone');
    }
    throw err;
  }
  if (resolved.framedOnly === true && isTopLevel(c)) {
    return contentErrorResponse(c, 'framed_only', true);
  }
  return resolved;
}

/**
 * Whether the request loads content as a page of its own rather than inside a frame:
 * `Sec-Fetch-Dest: document`, or no fetch metadata at all (an older browser, curl), which cannot
 * be told apart from one. The content's own loads (images, scripts, `fetch`) and the frames that
 * show it name their destination.
 */
function isTopLevel(c: Context<AppEnv>): boolean {
  const destination = c.req.header('sec-fetch-dest');
  return destination === undefined || destination === 'document';
}

/**
 * The segments of the stored path a request path names: each segment percent-decoded, then NFC
 * (stored paths are NFC; macOS sends NFD). Null when no stored path can match: a malformed
 * escape, a `.` or `..` segment, or a segment that decodes to `/`, `\` or NUL, so an encoded
 * slash never joins segments into another path.
 */
function decodePath(rawPath: string): string[] | null {
  const segments: string[] = [];
  for (const raw of rawPath.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw).normalize('NFC');
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
    if (segment === '.' || segment === '..' || /[/\\\0]/.test(segment)) return null;
    segments.push(segment);
  }
  return segments;
}

function reservedAsset(
  c: Context<AppEnv>,
  hooks: ContentHooks,
  name: string,
  framedOnly: boolean,
): Response {
  const assets = hooks.reservedAssets ?? {};
  const asset = Object.hasOwn(assets, name) ? assets[name] : undefined;
  if (asset === undefined) return contentErrorResponse(c, 'not_found', framedOnly);
  const body = asset.body();
  return reply(
    c,
    200,
    { 'Content-Type': asset.contentType, 'Content-Length': String(body.length) },
    body,
    framedOnly,
  );
}

/**
 * The file `path` names: `''` is the entry, a path ending in `/` the directory's index. A path
 * that is no file but a directory with an index is `'directory'`, for a redirect.
 */
async function findFile(
  deps: AppDeps,
  version: VersionRow,
  path: string,
): Promise<VersionFileRow | 'directory' | 'missing'> {
  const filesAt = (paths: string[]) =>
    deps.db.db
      .selectFrom('version_files')
      .selectAll()
      .where('version_id', '=', version.id)
      .where('path', 'in', paths)
      .execute();
  if (path === '') return (await filesAt([version.entry_path]))[0] ?? 'missing';

  const isDirectory = path.endsWith('/');
  const indexes = INDEX_NAMES.map((name) => (isDirectory ? path : `${path}/`) + name);
  const byPath = new Map(
    (await filesAt(isDirectory ? indexes : [path, ...indexes])).map((row) => [row.path, row]),
  );
  const exact = isDirectory ? undefined : byPath.get(path);
  if (exact !== undefined) return exact;
  const index = indexes.map((p) => byPath.get(p)).find((row) => row !== undefined);
  if (index === undefined) return 'missing';
  return isDirectory ? index : 'directory';
}

/**
 * Serves one stored file. Two kinds of response are not the stored bytes, so they take no range
 * and carry an ETag of their own (SHA-256 of the body): a Markdown file as a rendered page (the
 * stored file itself is `?source`), and, in a review grant, an HTML page after
 * `transformReviewHtml`. `requestPath` is the path the request named; `''` is the grant's root.
 */
async function serveFile(
  c: Context<AppEnv>,
  { grant, version, framedOnly }: ResolvedGrant,
  file: VersionFileRow,
  requestPath: string,
  hooks: ContentHooks,
): Promise<Response> {
  const { deps } = c.var;
  const framed = framedOnly === true;
  const transform = grant.mode === 'review' ? hooks.transformReviewHtml : undefined;
  const asPage =
    isMarkdownType(file.content_type) && !new URL(c.req.url).searchParams.has('source');
  if (asPage || (transform !== undefined && isHtmlType(file.content_type))) {
    // The page's stylesheet link is relative to the URL it is requested at: the root of the
    // grant for an entry in a folder, the file's own path otherwise.
    const pagePath = requestPath === '' ? (file.path.split('/').at(-1) ?? file.path) : file.path;
    let body: Buffer;
    if (asPage && file.size > MARKDOWN_RENDER_MAX_BYTES) {
      // Never read: a file of up to `PINWALL_MAX_FILE_BYTES`, escaped into a page, would cost
      // several times its size in memory and block the event loop for every request.
      body = Buffer.from(renderMarkdownTooLargePage(pagePath));
    } else {
      const stored = Buffer.concat(await (await deps.blobs.get(file.sha256)).toArray());
      body = asPage ? Buffer.from(renderMarkdownPage(utf8.decode(stored), pagePath)) : stored;
    }
    if (transform !== undefined) {
      body = await transform(body, {
        grant,
        version,
        path: file.path,
        baseUrl: contentBaseUrl(deps.config, grant.token),
      });
    }
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    if (noneMatch(c.req.header('if-none-match'), etag)) {
      return reply(c, 304, { ETag: etag }, null, framed);
    }
    const headers = {
      'Content-Type': asPage ? HTML : file.content_type,
      'Content-Length': String(body.length),
      ETag: etag,
    };
    return reply(c, 200, headers, body, framed);
  }

  const etag = `"${file.sha256}"`;
  if (noneMatch(c.req.header('if-none-match'), etag)) {
    return reply(c, 304, { ETag: etag }, null, framed);
  }
  const ifRange = c.req.header('if-range');
  const range =
    ifRange === undefined || ifRange.trim() === etag
      ? parseRange(c.req.header('range'), file.size)
      : null;
  if (range === 'unsatisfiable') {
    return reply(c, 416, { 'Content-Range': `bytes */${file.size}` }, null, framed);
  }

  const headers: Record<string, string> = {
    'Content-Type': file.content_type,
    ETag: etag,
    'Accept-Ranges': 'bytes',
  };
  if (range !== null) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
  } else {
    headers['Content-Length'] = String(file.size);
  }
  const status = range === null ? 200 : 206;
  // HEAD never opens the blob: an unread stream would hold its file or connection.
  if (c.req.method === 'HEAD') return reply(c, status, headers, null, framed);
  const stream = await deps.blobs.get(file.sha256, range ?? undefined);
  const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  return reply(c, status, headers, body, framed);
}

/**
 * The one byte range `header` asks for within `size` bytes (RFC 9110 §14): `a-b`, `a-` or `-n`.
 * Null serves the whole file: no header, another unit, a malformed or invalid range, several
 * ranges, or an empty file. `'unsatisfiable'` when the range starts at or past the end.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined || size === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (match === null) return null;
  const [, first = '', last = ''] = match;
  if (first === '') {
    if (last === '') return null;
    const suffix = Number(last);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== '' && Number(last) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}

/** Whether `If-None-Match` names `etag`, compared weakly (RFC 9110 §13.1.2), or is `*`. */
export function noneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

/**
 * A response with the content headers (`framedOnly` for an answer about a framed-only grant), plus
 * `headers`. A HEAD request gets no body.
 */
function reply(
  c: Context<AppEnv>,
  status: number,
  headers: Record<string, string>,
  body: string | Uint8Array | ReadableStream<Uint8Array> | null,
  framedOnly = false,
): Response {
  return new Response(c.req.method === 'HEAD' ? null : body, {
    status,
    headers: { ...contentHeaders(c.var.deps.config, status, framedOnly), ...headers },
  });
}
