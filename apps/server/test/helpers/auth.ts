import type { Role } from '../../src/auth/roles.ts';
import { sessionCookieName } from '../../src/auth/session-cookie.ts';
import { type AuthMethod, createSession } from '../../src/auth/sessions.ts';
import type { RoleOverride, UserRow } from '../../src/db/schema.ts';
import { newId } from '../../src/lib/ids.ts';
import type { TestContext } from './context.ts';

/**
 * A `RequestInit` for an API call. A `body` is sent as JSON and makes the method POST unless one
 * is given. Methods other than GET and HEAD carry `Origin: <public origin>` unless `origin` says
 * otherwise; `origin: null` leaves the header out.
 */
export function apiInit(
  ctx: TestContext,
  o: {
    method?: string;
    body?: unknown;
    cookie?: string;
    bearer?: string;
    origin?: string | null;
    headers?: Record<string, string>;
  } = {},
): RequestInit {
  const method = (o.method ?? (o.body === undefined ? 'GET' : 'POST')).toUpperCase();
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.cookie !== undefined) headers.cookie = o.cookie;
  if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
  const safe = method === 'GET' || method === 'HEAD';
  const origin = o.origin === undefined && !safe ? ctx.deps.config.publicOrigin : o.origin;
  if (typeof origin === 'string') headers.origin = origin;
  Object.assign(headers, o.headers);
  return {
    method,
    headers,
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  };
}

const SESSION_SET_COOKIE = /^((?:__Host-)?pinwall_session)=([^;]*)/;

/** `name=value` of the first session cookie `res` sets with a value, or null if none. */
export function sessionCookieFrom(res: Response): string | null {
  for (const header of res.headers.getSetCookie()) {
    const match = SESSION_SET_COOKIE.exec(header);
    if (match?.[2]) return `${match[1]}=${match[2]}`;
  }
  return null;
}

/**
 * Inserts a user and a session for them, as a finished sign-in would leave things, and returns
 * the cookie to send. Defaults: the owner, named "Ada"; an `oidc` user is a member with a
 * verified email unless told otherwise.
 */
export async function createSignedInUser(
  ctx: TestContext,
  o: {
    kind?: 'owner' | 'oidc';
    idpRole?: Role | null;
    roleOverride?: RoleOverride | null;
    name?: string;
    method?: AuthMethod;
  } = {},
): Promise<{ user: UserRow; cookie: string }> {
  const { db } = ctx.deps.db;
  const kind = o.kind ?? 'owner';
  const id = newId('usr');
  const oidc = kind === 'oidc';
  await db
    .insertInto('users')
    .values({
      id,
      kind,
      name: o.name ?? 'Ada',
      email: oidc ? `${id}@example.test` : null,
      email_verified: oidc ? 1 : 0,
      idp_role: o.idpRole === undefined ? (oidc ? 'member' : null) : o.idpRole,
      role_override: o.roleOverride ?? null,
      oidc_issuer: oidc ? 'https://idp.example.test' : null,
      oidc_subject: oidc ? id : null,
      idp_checked_at: oidc ? ctx.deps.clock.now() : null,
      created_at: ctx.deps.clock.now(),
    })
    .execute();
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const { secret } = await createSession(ctx.deps, id, o.method ?? 'password', {
    ip: '127.0.0.1',
    userAgent: 'vitest',
  });
  return { user, cookie: `${sessionCookieName(ctx.deps.config)}=${secret}` };
}
