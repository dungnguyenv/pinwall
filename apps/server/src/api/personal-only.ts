import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { notFoundHandler } from '../http/errors.ts';

/**
 * For the routes that exist only in `personal` mode (project members, purges): in `team` mode
 * they answer exactly as an unknown route does, before authentication, so no caller can tell one
 * from a route that is not there. It goes first in a route's middleware.
 */
export const personalOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.deps.config.visibility !== 'personal') return notFoundHandler(c);
  await next();
};
