import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Gives every request a fresh id, as `c.var.requestId` and the `X-Request-Id` response header.
 * An id sent by the client is not reused: it would let anyone write into the server's logs.
 */
export function requestId(): MiddlewareHandler<{ Variables: { requestId: string } }> {
  return async (c, next) => {
    const id = randomUUID();
    c.set('requestId', id);
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, id);
  };
}
