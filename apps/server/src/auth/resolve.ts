import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, AuthContext } from '../app.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, unauthorized } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hasAccess } from './roles.ts';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from './session-cookie.ts';
import { deleteSession, resolveSession } from './sessions.ts';

/** Turns one kind of bearer token (API token, OAuth access token) into an `AuthContext`. */
export interface BearerResolver {
  name: string;
  /** Whether the token is this resolver's kind, by its prefix; no I/O. */
  matches(token: string): boolean;
  /** The caller, or `null` when the token is unknown, expired or revoked. */
  resolve(deps: AppDeps, token: string): Promise<AuthContext | null>;
}

/** One scheme, one space, one token with no whitespace (RFC 6750 §2.1). */
const BEARER_HEADER = /^Bearer (\S+)$/i;

/** RFC 6750 §3: the challenge says why the token was refused. */
function bearerRefused(c: Context<AppEnv>, error: 'invalid_request' | 'invalid_token'): AppError {
  c.header('WWW-Authenticate', `Bearer error="${error}"`);
  return unauthorized(t('auth.invalidToken'));
}

async function authFromBearer(
  c: Context<AppEnv>,
  resolvers: readonly BearerResolver[],
  header: string,
): Promise<AuthContext> {
  const token = BEARER_HEADER.exec(header)?.[1];
  if (token === undefined) throw bearerRefused(c, 'invalid_request');
  const resolver = resolvers.find((r) => r.matches(token));
  const auth = resolver ? await resolver.resolve(c.var.deps, token) : null;
  if (!auth) throw bearerRefused(c, 'invalid_token');
  // M3 puts its IdP access gate (no inline re-check) here, before hasAccess.
  if (!hasAccess(auth.user)) {
    throw new AppError('access_denied', 403, t('auth.accessDenied'));
  }
  return auth;
}

async function authFromCookie(c: Context<AppEnv>): Promise<AuthContext | null> {
  const secret = readSessionCookie(c);
  if (secret === undefined) return null;
  const { deps } = c.var;
  const found = await resolveSession(deps, secret);
  if (!found) {
    clearSessionCookie(c);
    return null;
  }
  // M3 puts its IdP access gate (inline re-check when due) here, before hasAccess.
  if (!hasAccess(found.user)) {
    await deleteSession(deps, found.session.id_hash);
    clearSessionCookie(c);
    return null;
  }
  if (found.refreshed) setSessionCookie(c, secret);
  return { user: found.user, via: 'session', sessionId: found.session.id_hash };
}

/**
 * Sets `c.var.auth` from the request's credentials; `null` means anonymous, and guards decide
 * what that may do. An `Authorization` header wins outright: it must be a bearer token one of
 * `bearer` accepts, or the request is refused, and cookies are then never read. Otherwise, with
 * `cookies` on, the session cookie is used; a dead session's cookie is cleared. `/mcp` passes
 * `cookies: false` with its own resolver list.
 */
export function resolveAuth(opts: {
  bearer: readonly BearerResolver[];
  cookies: boolean;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    let auth: AuthContext | null = null;
    if (header !== undefined) auth = await authFromBearer(c, opts.bearer, header);
    else if (opts.cookies) auth = await authFromCookie(c);
    c.set('auth', auth);
    await next();
  };
}
