import { HttpResponse, http } from 'msw';
import {
  AdminConfig,
  AdminLookup,
  AdminPerson,
  AdminShareLink,
  AdminUsage,
  AdminUser,
  ConfigEntry,
  type EndGrantsResult,
  type PurgeResult,
  type RevokeResult,
  type UpdateAdminUserRequest,
} from '../api/dto.ts';
import i18n from '../i18n.ts';
import { fx } from './fixtures.ts';
import { API, apiError, server } from './server.ts';
import type { Call } from './settings.ts';

// Noon UTC, so a date reads the same in every time zone.
const CREATED = Date.UTC(2026, 10, 1, 12);

/** The messages the real server answers a refused role change with. */
export const OWN_ROLE_MESSAGE = 'You cannot change your own role.';
export const OWNER_ROLE_MESSAGE =
  'The owner account is always an admin. Its role cannot be changed or blocked.';

/** What a person's space holds; by default nothing, and never published. */
export function fxUsage(o: Partial<AdminUsage> = {}): AdminUsage {
  return AdminUsage.parse({
    projects: 0,
    artifacts: 0,
    versions: 0,
    bytes: 0,
    share_links: 0,
    last_published_at: null,
    ...o,
  });
}

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
    usage: fxUsage(),
    share_approved: false,
    quota_bytes: null,
    quota_artifacts: null,
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
 * every write, in order. A patch merges into the user as the server does, and
 * a purge needs the typed email (the id when there is none) and then empties
 * the user's space.
 */
export function serveAdminUsers(
  o: {
    users: AdminUser[];
    /** Who is signed in; default `fx.me().id`. */
    actorId?: string;
    pageSize?: number;
    /** What "Revoke now" ended; default 2 sessions, 1 API token, 1 OAuth grant. */
    revoked?: RevokeResult;
    /** What a purge deleted; default 1 project and 2 artifacts. */
    purged?: PurgeResult;
  } = { users: [] },
): { state: AdminUsersState; calls: Call[]; requests: string[] } {
  const actorId = o.actorId ?? fx.me().id;
  const state: AdminUsersState = { users: o.users };
  const calls: Call[] = [];
  const requests: string[] = [];
  const revoked = o.revoked ?? { sessions: 2, api_tokens: 1, oauth_grants: 1 };
  const purged = o.purged ?? { projects: 1, artifacts: 2 };
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
    http.patch(`${API}/admin/users/:id`, async ({ request, params }) => {
      const body = (await request.json()) as UpdateAdminUserRequest;
      calls.push({ method: 'PATCH', path: `/admin/users/${String(params.id)}`, body });
      const user = find(String(params.id));
      if (!user) return apiError(404, 'not_found', 'This user does not exist.');
      const { effective_role: _old, ...rest } = user;
      const updated = fxAdminUser({ ...rest, ...body });
      state.users = state.users.map((u) => (u.id === user.id ? updated : u));
      return HttpResponse.json(updated);
    }),
    http.post(`${API}/admin/users/:id/purge`, async ({ request, params }) => {
      const body = (await request.json()) as { confirm_email: string };
      calls.push({ method: 'POST', path: `/admin/users/${String(params.id)}/purge`, body });
      const user = find(String(params.id));
      if (!user) return apiError(404, 'not_found', 'This user does not exist.');
      if (body.confirm_email.trim().toLowerCase() !== (user.email || user.id).toLowerCase()) {
        return apiError(400, 'bad_request', i18n.t('purge.confirm'));
      }
      const { effective_role: _old, ...rest } = user;
      const emptied = fxAdminUser({
        ...rest,
        usage: fxUsage({ last_published_at: user.usage?.last_published_at ?? null }),
      });
      state.users = state.users.map((u) => (u.id === user.id ? emptied : u));
      return HttpResponse.json(purged);
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

/** A person as moderation names them: the name, else the email. Bob unless the test says. */
export function fxAdminPerson(o: Partial<AdminPerson> = {}): AdminPerson {
  return AdminPerson.parse({
    id: 'usr_b',
    name: 'Bob Example',
    email: 'bob@example.test',
    ...o,
  });
}

/**
 * A share link as an admin sees it: Bob's, on the latest version, with no password, no comments
 * and no expiry, made by the owner himself, never used.
 */
export function fxAdminShareLink(o: Partial<AdminShareLink> = {}): AdminShareLink {
  const bob = fxAdminPerson();
  return AdminShareLink.parse({
    id: 'shr_1',
    artifact: { id: 'art_1', name: 'Pricing' },
    owner: bob,
    created_by: bob,
    version: null,
    has_password: false,
    allow_comments: false,
    created_at: CREATED,
    expires_at: null,
    last_used_at: null,
    ...o,
  });
}

/**
 * What looking up `https://pinwall.test/s/abc` answers: Bob's share link, shown at version 2 of
 * Pricing in the project Website. A test changes `kind`, `share_link` and `grant` to look up
 * other addresses.
 */
export function fxLookup(o: Partial<AdminLookup> = {}): AdminLookup {
  const bob = fxAdminPerson();
  return AdminLookup.parse({
    kind: 'share_link',
    artifact: {
      id: 'art_1',
      name: 'Pricing',
      project: { id: 'prj_1', name: 'Website' },
      owner: bob,
    },
    version: { id: 'ver_2', number: 2, published_by: bob },
    share_link: fxAdminShareLink(),
    grant: null,
    ...o,
  });
}

export interface ModerationState {
  links: AdminShareLink[];
}

/**
 * Serves the moderation routes. The link list is paged by `pageSize` with an index as the
 * cursor, and a revoke or a deletion takes the links it ends out of it, as the server does.
 * `lookup` answers `POST /admin/lookup` with whatever response it builds from the pasted address
 * (default: `fxLookup()`); a test that wants a different answer the second time keeps its own
 * count. `grants` is how many grants "end open pages" ended (default 3). `requests` holds the
 * query string of each list request, `calls` every write and look-up, in order.
 */
export function serveModeration(
  o: {
    links?: AdminShareLink[];
    lookup?: (url: string) => Response;
    pageSize?: number;
    grants?: number;
  } = {},
): { state: ModerationState; calls: Call[]; requests: string[] } {
  const state: ModerationState = { links: o.links ?? [] };
  const calls: Call[] = [];
  const requests: string[] = [];
  const ended: EndGrantsResult = { grants: o.grants ?? 3 };

  server.use(
    http.get(`${API}/admin/share-links`, ({ request }) => {
      const url = new URL(request.url);
      requests.push(url.search);
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const size = o.pageSize ?? Number(url.searchParams.get('limit') ?? 50);
      const items = state.links.slice(start, start + size);
      const next = start + size < state.links.length ? String(start + size) : null;
      return HttpResponse.json(fx.page(items, next));
    }),
    http.delete(`${API}/admin/share-links/:id`, ({ params }) => {
      calls.push({
        method: 'DELETE',
        path: `/admin/share-links/${String(params.id)}`,
        body: undefined,
      });
      if (!state.links.some((l) => l.id === params.id)) {
        return apiError(404, 'not_found', 'This share link does not exist.');
      }
      state.links = state.links.filter((l) => l.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/admin/lookup`, async ({ request }) => {
      const body = (await request.json()) as { url: string };
      calls.push({ method: 'POST', path: '/admin/lookup', body });
      return o.lookup ? o.lookup(body.url) : HttpResponse.json(fxLookup());
    }),
    http.delete(`${API}/admin/artifacts/:id`, ({ params }) => {
      calls.push({
        method: 'DELETE',
        path: `/admin/artifacts/${String(params.id)}`,
        body: undefined,
      });
      state.links = state.links.filter((l) => l.artifact.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${API}/admin/artifacts/:id/versions/:n`, ({ params }) => {
      calls.push({
        method: 'DELETE',
        path: `/admin/artifacts/${String(params.id)}/versions/${String(params.n)}`,
        body: undefined,
      });
      state.links = state.links.filter(
        (l) => l.artifact.id !== params.id || l.version?.number !== Number(params.n),
      );
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/admin/versions/:id/end-grants`, ({ params }) => {
      calls.push({
        method: 'POST',
        path: `/admin/versions/${String(params.id)}/end-grants`,
        body: undefined,
      });
      return HttpResponse.json(ended);
    }),
  );
  return { state, calls, requests };
}
