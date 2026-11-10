import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config/types.ts';
import type { Logger } from '../lib/logger.ts';
import { clientIp } from './client-ip.ts';

/** Path segments that are bearer secrets: whoever reads the log could use them. */
const SECRET_SEGMENT = /^\/(c|s|upload)\/[^/]+/;

/** Probes hit these every few seconds; they are logged only at debug level. */
const PROBES = new Set(['/healthz', '/readyz']);

/**
 * The path as it may appear in a log: no query string (setup tokens, OAuth codes) and no
 * content, share or upload token.
 */
export function loggablePath(path: string): string {
  return path.replace(SECRET_SEGMENT, '/$1/:token');
}

/** One `request` log line per response, after it is complete. */
export function requestLogger(
  logger: Logger,
  config: Pick<Config, 'trustProxy'>,
): MiddlewareHandler<{ Variables: { requestId: string } }> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const line = {
      request_id: c.get('requestId'),
      method: c.req.method,
      path: loggablePath(c.req.path),
      status: c.res.status,
      duration_ms: Math.round(performance.now() - started),
      ip: clientIp(c, config.trustProxy),
    };
    if (PROBES.has(c.req.path)) logger.debug(line, 'request');
    else logger.info(line, 'request');
  };
}
