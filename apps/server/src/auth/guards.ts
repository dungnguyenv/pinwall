import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, AuthContext } from '../app.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { effectiveRole } from './roles.ts';

/**
 * Who is calling. Meant for handlers behind a guard; without one, an anonymous request still
 * gets the 401 a guard would have given.
 */
export function authOf(c: Context<AppEnv>): AuthContext {
  const auth = c.var.auth;
  if (!auth) throw unauthorized(t('auth.signInRequired'));
  return auth;
}

/** A guard that, once someone is signed in, refuses them with a 403 unless `allowed`. */
function guard(
  allowed: (auth: AuthContext) => boolean,
  messageKey: string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!allowed(authOf(c))) throw forbidden(t(messageKey));
    await next();
  };
}

/** Anyone signed in, by session or token. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  authOf(c);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = guard(
  (auth) => effectiveRole(auth.user) === 'admin',
  'auth.adminOnly',
);

/** Browser sessions only: what API and OAuth tokens must never do (managing tokens, consent). */
export const requireSession: MiddlewareHandler<AppEnv> = guard(
  (auth) => auth.via === 'session',
  'auth.sessionRequired',
);

/** The built-in owner account only (its password and passkeys). */
export const requireOwner: MiddlewareHandler<AppEnv> = guard(
  (auth) => auth.user.kind === 'owner',
  'auth.ownerOnly',
);
