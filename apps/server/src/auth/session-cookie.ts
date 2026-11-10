import type { Context } from 'hono';
import { generateCookie, getCookie } from 'hono/cookie';
import type { AppEnv } from '../app.ts';
import type { Config } from '../config/types.ts';
import type { UserRow } from '../db/schema.ts';
import { clientIp } from '../http/client-ip.ts';
import { hashSecret } from '../lib/ids.ts';
import { type AuthMethod, createSession, deleteSession } from './sessions.ts';

/** Browsers refuse a cookie lifetime above 400 days (RFC 6265bis), and Hono throws on one. */
const MAX_COOKIE_AGE_S = 400 * 86_400;

/**
 * `__Host-` on an https public origin, so only this exact origin can set or read it. The name
 * comes from the configuration, never from the request's scheme: behind a TLS-terminating proxy
 * the server sees plain http.
 */
export function sessionCookieName(config: Config): '__Host-pinwall_session' | 'pinwall_session' {
  return config.publicHttps ? '__Host-pinwall_session' : 'pinwall_session';
}

/** The session secret the browser sent, if any. */
export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  const value = getCookie(c, sessionCookieName(c.var.deps.config));
  return value === '' ? undefined : value;
}

/**
 * Puts the session cookie on the response, replacing one set earlier in the same request (a
 * renewal followed by sign-out, say): a response must not set the same cookie twice.
 */
function writeSessionCookie(c: Context<AppEnv>, value: string, maxAgeSeconds: number): void {
  const { config } = c.var.deps;
  const name = sessionCookieName(config);
  const others = c.res.headers.getSetCookie().filter((cookie) => !cookie.startsWith(`${name}=`));
  c.header('Set-Cookie', undefined);
  for (const cookie of others) c.header('Set-Cookie', cookie, { append: true });
  const cookie = generateCookie(name, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.publicHttps,
    maxAge: maxAgeSeconds,
  });
  c.header('Set-Cookie', cookie, { append: true });
}

export function setSessionCookie(c: Context<AppEnv>, secret: string): void {
  const ttlSeconds = Math.ceil(c.var.deps.config.ttl.sessionMs / 1000);
  writeSessionCookie(c, secret, Math.min(ttlSeconds, MAX_COOKIE_AGE_S));
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  writeSessionCookie(c, '', 0);
}

/**
 * Signs the browser in as `user`: ends the session it presented (so a session planted before
 * sign-in never becomes an authenticated one), creates a new session, sets its cookie and makes
 * it this request's `auth`. Checking that the user may sign in is the caller's job.
 */
export async function startSession(
  c: Context<AppEnv>,
  user: UserRow,
  method: AuthMethod,
): Promise<void> {
  const { deps } = c.var;
  const presented = readSessionCookie(c);
  if (presented !== undefined) await deleteSession(deps, hashSecret(presented));
  const { secret, idHash } = await createSession(deps, user.id, method, {
    ip: clientIp(c, deps.config.trustProxy),
    userAgent: c.req.header('user-agent') ?? null,
  });
  setSessionCookie(c, secret);
  c.set('auth', { user, via: 'session', sessionId: idHash });
}
