import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppDeps } from '../deps.ts';
import { AppError, type ErrorCode } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { renderErrorPage } from '../pages/error-page.tsx';
import { loggablePath } from './logging.ts';
import { publicUrl } from './public-url.ts';

/** Paths only programs call: their errors are JSON whatever `Accept` says. */
const MACHINE_PATHS = [
  '/api',
  '/mcp',
  '/oauth/token',
  '/oauth/register',
  '/oauth/revoke',
  '/.well-known',
  '/upload',
];

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** True when the client is a browser asking for a page, so an error must be an HTML page. */
export function wantsHtml(c: Context): boolean {
  const accept = c.req.header('accept') ?? '';
  if (!accept.includes('text/html')) return false;
  return !MACHINE_PATHS.some((prefix) => isUnder(c.req.path, prefix));
}

const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
};

interface ErrorReply {
  status: ContentfulStatusCode;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** What may be shown for `err`. Anything that is not a 4xx we raised on purpose stays private. */
function toReply(err: Error, requestId: string): ErrorReply {
  if (err instanceof AppError && err.status >= 400 && err.status < 500) {
    return {
      status: err.status as ContentfulStatusCode,
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    };
  }
  // Hono's own middleware (validators, body limits) throws these with framework messages.
  if (err instanceof HTTPException && err.status >= 400 && err.status < 500) {
    return {
      status: err.status as ContentfulStatusCode,
      code: CODE_BY_STATUS[err.status] ?? 'bad_request',
      message: err.message,
    };
  }
  return {
    status: 500,
    code: 'internal',
    message: t('error.server.message'),
    details: { request_id: requestId },
  };
}

/** Deps are missing only on a bare app (tests) that skipped the injection middleware. */
function depsOf(c: Context): AppDeps | undefined {
  return c.get('deps') as AppDeps | undefined;
}

function requestIdOf(c: Context): string {
  return (c.get('requestId') as string | undefined) ?? 'unknown';
}

function homeActions(c: Context) {
  const deps = depsOf(c);
  return [{ label: t('error.goHome'), href: deps ? publicUrl(deps.config, '/') : '/' }];
}

function htmlTitle(reply: ErrorReply): string {
  if (reply.status === 404) return t('error.notFound.title');
  if (reply.status >= 500) return t('error.server.title');
  return t('error.client.title');
}

function respond(c: Context, reply: ErrorReply): Response {
  c.header('Cache-Control', 'no-store');
  const retryAfter = reply.details?.retry_after_seconds;
  if (reply.code === 'rate_limited' && typeof retryAfter === 'number') {
    c.header('Retry-After', String(retryAfter));
  }
  if (wantsHtml(c)) {
    const page = renderErrorPage({
      status: reply.status,
      title: htmlTitle(reply),
      message: reply.message,
      requestId: requestIdOf(c),
      actions: homeActions(c),
    });
    return c.html(page, reply.status);
  }
  const { code, message, details } = reply;
  return c.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    reply.status,
  );
}

/**
 * `app.onError`: an HTML page for browsers, `{ error: { code, message, details? } }` for
 * everyone else. 4xx `AppError`s show their message; anything else is logged in full and
 * answered with a generic 500 that names only the request id.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = requestIdOf(c);
  const reply = toReply(err, requestId);
  if (reply.status >= 500) {
    const fields = {
      err,
      request_id: requestId,
      method: c.req.method,
      path: loggablePath(c.req.path),
    };
    const logger = depsOf(c)?.logger;
    if (logger) logger.error(fields, 'Request failed with an unexpected error');
    else console.error('Request failed with an unexpected error', fields);
  }
  return respond(c, reply);
};

/** `app.notFound`: the 404 page for browsers, JSON `not_found` for everyone else. */
export const notFoundHandler: NotFoundHandler = (c) =>
  respond(c, { status: 404, code: 'not_found', message: t('error.notFound.message') });
