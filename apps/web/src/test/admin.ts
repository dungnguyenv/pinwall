import { HttpResponse, http } from 'msw';
import { AdminConfig, AdminUser, ConfigEntry, type RevokeResult } from '../api/dto.ts';
import { fx } from './fixtures.ts';
import { API, apiError, server } from './server.ts';
import type { Call } from './settings.ts';

// Noon UTC, so a date reads the same in every time zone.
const CREATED = Date.UTC(2026, 10, 1, 12);

/** The messages the real server answers a refused role change with. */
export const OWN_ROLE_MESSAGE = 'You cannot change your own role.';
export const OWNER_ROLE_MESSAGE =
  'The owner account is always an admin. Its role cannot be changed or blocked.';

/**
 * A user as the admin API lists them. `effective_role` follows the server's
 * rule (the owner is always an admin, a block always applies, and another
 * override replaces the identity provider's role only while it gives one)
 * unless the test states it.
 */
export function fxAdminUser(o: Partial<AdminUser> = {}): AdminUser {
  const base = {
    id: 'usr_2',
    kind: 'oidc' as const,
    name: 'Grace Hopper',
    email: 'grace@example.com',
    email_verified: true,
    avatar_url: null,
    idp_role: 'member' as const,
    role_override: null,
    disabled_at: null,
    disabled_reason: null,
    created_at: CREATED,
    last_seen_at: null,
    ...o,
  };
  const effective =
    base.kind === 'owner'
      ? 'admin'
      : base.role_override === 'blocked'
        ? 'blocked'
        : base.idp_role === null
          ? null
          : (base.role_override ?? base.idp_role);
  return AdminUser.parse({ effective_role: effective, ...base });
}

/** The signed-in owner (`fx.me()`), as the admin API lists them. */
export function fxOwnerRow(o: Partial<AdminUser> = {}): AdminUser {
  const me = fx.me();
  return fxAdminUser({
    id: me.id,
    kind: 'owner',
    name: me.name,
    email: me.email,
    idp_role: null,
    ...o,
  });
}

export interface AdminUsersState {
  users: AdminUser[];
}

/**
 * Serves the admin user routes with the rules the real server enforces: you
 * cannot change your own role (`actorId`), nobody can change the owner's, and
 * an unknown user is a 404. Lists are paged by `pageSize` with an index as the
 * cursor. `requests` holds the query string of each list request, `calls`
 * every write, in order.
 */
export function serveAdminUsers(
  o: {
    users: AdminUser[];
    /** Who is signed in; default `fx.me().id`. */
    actorId?: string;
    pageSize?: number;
    /** What "Revoke now" ended; default 2 sessions, 1 API token, 1 OAuth grant. */
    revoked?: RevokeResult;
  } = { users: [] },
): { state: AdminUsersState; calls: Call[]; requests: string[] } {
  const actorId = o.actorId ?? fx.me().id;
  const state: AdminUsersState = { users: o.users };
  const calls: Call[] = [];
  const requests: string[] = [];
  const revoked = o.revoked ?? { sessions: 2, api_tokens: 1, oauth_grants: 1 };
  const find = (id: string) => state.users.find((u) => u.id === id);

  server.use(
    http.get(`${API}/admin/users`, ({ request }) => {
      const url = new URL(request.url);
      requests.push(url.search);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const size = o.pageSize ?? Number(url.searchParams.get('limit') ?? 50);
      const items = state.users.slice(start, start + size);
      const next = start + size < state.users.length ? String(start + size) : null;
      return HttpResponse.json(fx.page(items, next));
    }),
    http.put(`${API}/admin/users/:id/role`, async ({ request, params }) => {
      const body = (await request.json()) as { role_override: AdminUser['role_override'] };
      calls.push({
        method: 'PUT',
        path: `/admin/users/${String(params.id)}/role`,
        body,
      });
      if (params.id === actorId) return apiError(403, 'forbidden', OWN_ROLE_MESSAGE);
      const user = find(String(params.id));
      if (!user) return apiError(404, 'not_found', 'This user does not exist.');
      if (user.kind === 'owner') return apiError(403, 'forbidden', OWNER_ROLE_MESSAGE);
      const { effective_role: _old, ...rest } = user;
      const updated = fxAdminUser({ ...rest, role_override: body.role_override });
      state.users = state.users.map((u) => (u.id === user.id ? updated : u));
      return HttpResponse.json(updated);
    }),
    http.post(`${API}/admin/users/:id/revoke`, ({ params }) => {
      calls.push({
        method: 'POST',
        path: `/admin/users/${String(params.id)}/revoke`,
        body: undefined,
      });
      if (!find(String(params.id))) return apiError(404, 'not_found', 'This user does not exist.');
      return HttpResponse.json(revoked);
    }),
  );
  return { state, calls, requests };
}

/** A configuration entry; a secret never carries a value. */
export function fxConfigEntry(o: Partial<ConfigEntry> & Pick<ConfigEntry, 'env'>): ConfigEntry {
  const value = o.secret ? null : (o.value ?? null);
  return ConfigEntry.parse({
    section: 'general',
    secret: false,
    ...o,
    value,
    set: o.set ?? (o.secret ? false : value !== null),
  });
}

/** The effective configuration as `GET /admin/config` describes it. */
export function fxAdminConfig(o: Partial<AdminConfig> = {}): AdminConfig {
  return AdminConfig.parse({
    isolation: 'single-domain',
    content_origin: null,
    warnings: [],
    entries: [
      fxConfigEntry({ env: 'PINWALL_PUBLIC_ORIGIN', value: 'https://pinwall.example' }),
      fxConfigEntry({ env: 'PINWALL_PORT', value: '8080' }),
      fxConfigEntry({ env: 'PINWALL_SECRET_KEY', secret: true, set: true }),
      fxConfigEntry({ section: 'isolation', env: 'PINWALL_ISOLATION', value: 'single-domain' }),
      fxConfigEntry({ section: 'isolation', env: 'PINWALL_CONTENT_ORIGIN' }),
      fxConfigEntry({ section: 'storage', env: 'PINWALL_STORAGE', value: 's3' }),
      fxConfigEntry({
        section: 'storage',
        env: 'PINWALL_S3_SECRET_ACCESS_KEY',
        secret: true,
        set: true,
      }),
      fxConfigEntry({ section: 'sign_in', env: 'PINWALL_OIDC_ISSUER' }),
      fxConfigEntry({ section: 'limits', env: 'PINWALL_MAX_UPLOAD_BYTES', value: '95000000' }),
      fxConfigEntry({ section: 'limits', env: 'PINWALL_MAX_EXPANSION_RATIO', value: '100' }),
      fxConfigEntry({ section: 'lifetimes', env: 'PINWALL_SESSION_TTL', value: '30d' }),
    ],
    ...o,
  });
}

export function serveAdminConfig(config: AdminConfig = fxAdminConfig()): void {
  server.use(http.get(`${API}/admin/config`, () => HttpResponse.json(config)));
}
