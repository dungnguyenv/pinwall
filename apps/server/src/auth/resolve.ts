import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, AuthContext } from '../app.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, unauthorized } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { gateUser } from './oidc/gate.ts';
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
function bearerRefused(
  c: Context<AppEnv>,
  error: 'invalid_request' | 'invalid_token',
  message = t('auth.invalidToken'),
): AppError {
  c.header('WWW-Authenticate', `Bearer error="${error}"`);
  return unauthorized(message);
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
  // Never waits on the IdP: a token whose user's last IdP check is too old is refused.
  const gate = await gateUser(c.var.deps, auth.user, { inline: false });
  if (!gate.ok) throw bearerRefused(c, 'invalid_token', t('oidc.recheckRequired'));
  if (!hasAccess(gate.user)) {
    throw new AppError('access_denied', 403, t('auth.accessDenied'));
  }
  return { ...auth, user: gate.user };
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
  // A due IdP user is re-checked with the IdP before this request is answered.
  const gate = await gateUser(deps, found.user, { inline: true });
  if (!gate.ok || !hasAccess(gate.user)) {
    await deleteSession(deps, found.session.id_hash);
    clearSessionCookie(c);
    return null;
  }
  if (found.refreshed) setSessionCookie(c, secret);
  return { user: gate.user, via: 'session', sessionId: found.session.id_hash };
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
