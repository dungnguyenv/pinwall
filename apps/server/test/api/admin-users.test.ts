import { Writable } from 'node:stream';
import { AdminUser, AdminUserList, RevokeResult } from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import type { Role } from '../../src/auth/roles.ts';
import { createSession } from '../../src/auth/sessions.ts';
import type { RoleOverride } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { newId } from '../../src/lib/ids.ts';
import { createLogger } from '../../src/lib/logger.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const T = Date.UTC(2026, 10, 10);

describe.each(dialects)('admin users on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(() => ctx.close());

  async function start(): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    return ctx;
  }

  type Auth = { cookie?: string; bearer?: string; origin?: string | null };
  const list = (o: Auth, query = '') => ctx.request(`/api/v1/admin/users${query}`, apiInit(ctx, o));
  const setRole = (id: string, role: unknown, o: Auth) =>
    ctx.request(
      `/api/v1/admin/users/${id}/role`,
      apiInit(ctx, { ...o, method: 'PUT', body: { role_override: role } }),
    );
  const revoke = (id: string, o: Auth) =>
    ctx.request(`/api/v1/admin/users/${id}/revoke`, apiInit(ctx, { ...o, method: 'POST' }));
  const me = (o: Auth) => ctx.request('/api/v1/me', apiInit(ctx, o));

  const errorOf = async (r: Response) => ((await r.json()) as { error: unknown }).error;
  const listed = async (r: Response) => {
    expect(r.status).toBe(200);
    return AdminUserList.parse(await r.json());
  };

  /** An admin (the owner) and, a moment later each, the members the test asks for. */
  async function admin() {
    return createSignedInUser(ctx, { name: 'Ada' });
  }
  async function member(o: { name?: string; idpRole?: Role | null; roleOverride?: RoleOverride }) {
    clock.advance(1_000);
    return createSignedInUser(ctx, { kind: 'oidc', ...o });
  }

  test('admins list users with their effective role', async () => {
    await start();
    const { cookie } = await admin();
    await member({ name: 'Bao' });
    await member({ name: 'Chi', idpRole: null });

    const body = await listed(await list({ cookie }));
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((u) => [u.name, u.kind, u.effective_role])).toEqual([
      ['Ada', 'owner', 'admin'],
      ['Bao', 'oidc', 'member'],
      ['Chi', 'oidc', null],
    ]);
    expect(body.items[1]).toMatchObject({
      idp_role: 'member',
      role_override: null,
      email_verified: true,
      disabled_at: null,
      disabled_reason: null,
      created_at: T + 1_000,
    });
    expect(body.items[0]).toMatchObject({ idp_role: null, email: null, avatar_url: null });
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(Object.keys(AdminUser.shape).sort());
  });

  test('the list pages with a cursor', async () => {
    await start();
    const { cookie } = await admin();
    await member({ name: 'Bao' });
    await member({ name: 'Chi' });

    const first = await listed(await list({ cookie }, '?limit=2'));
    expect(first.items.map((u) => u.name)).toEqual(['Ada', 'Bao']);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await listed(await list({ cookie }, `?limit=2&cursor=${first.next_cursor}`));
    expect(second.items.map((u) => u.name)).toEqual(['Chi']);
    expect(second.next_cursor).toBeNull();

    const bad = await list({ cookie }, '?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toEqual({ code: 'bad_request', message: t('error.cursor') });
    for (const limit of ['0', '201', 'many']) {
      expect((await list({ cookie }, `?limit=${limit}`)).status, limit).toBe(400);
    }
  });

  test('users created at the same instant are each listed once', async () => {
    await start();
    const { cookie } = await admin();
    for (let i = 0; i < 4; i++) await createSignedInUser(ctx, { kind: 'oidc' });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const query: string = `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const body = await listed(await list({ cookie }, query));
      seen.push(...body.items.map((u) => u.id));
      cursor = body.next_cursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test('members cannot use admin routes', async () => {
    await start();
    const { user: owner } = await admin();
    const { user, cookie } = await member({ name: 'Bao' });
    const denied = { code: 'forbidden', message: t('auth.adminOnly') };

    for (const r of [
      await list({ cookie }),
      await setRole(owner.id, 'blocked', { cookie }),
      await revoke(owner.id, { cookie }),
      await revoke(user.id, { cookie }),
    ]) {
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toEqual(denied);
    }
    expect((await me({ cookie })).status).toBe(200);

    for (const r of [await list({}), await revoke(owner.id, {})]) {
      expect(r.status).toBe(401);
    }
  });

  test('set a role override and clear it', async () => {
    await start();
    const { cookie } = await admin();
    const { user, cookie: memberCookie } = await member({ name: 'Bao' });
    expect((await list({ cookie: memberCookie })).status).toBe(403);

    const promoted = await setRole(user.id, 'admin', { cookie });
    expect(promoted.status).toBe(200);
    expect(AdminUser.parse(await promoted.json())).toMatchObject({
      id: user.id,
      idp_role: 'member',
      role_override: 'admin',
      effective_role: 'admin',
    });
    expect((await list({ cookie: memberCookie })).status).toBe(200);

    const cleared = await setRole(user.id, null, { cookie });
    expect(cleared.status).toBe(200);
    expect(AdminUser.parse(await cleared.json())).toMatchObject({
      role_override: null,
      effective_role: 'member',
    });
    expect((await list({ cookie: memberCookie })).status).toBe(403);

    for (const role of ['owner', 'root', 1, undefined]) {
      expect((await setRole(user.id, role, { cookie })).status, String(role)).toBe(400);
    }
    const stored = await ctx.deps.db.db
      .selectFrom('users')
      .select('role_override')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(stored.role_override).toBeNull();
  });

  test('an override does not let in someone the identity provider does not admit', async () => {
    await start();
    const { cookie } = await admin();
    const { user, cookie: noRole } = await member({ idpRole: null });

    for (const role of ['member', 'admin'] as const) {
      const r = await setRole(user.id, role, { cookie });
      expect(r.status).toBe(200);
      // Stored, so it applies once the identity provider admits the person again.
      expect(AdminUser.parse(await r.json())).toMatchObject({
        idp_role: null,
        role_override: role,
        effective_role: null,
      });
      expect((await me({ cookie: noRole })).status, role).toBe(401);
    }
  });

  test('blocking takes effect at once', async () => {
    await start();
    const { cookie } = await admin();
    const { user, cookie: memberCookie } = await member({ name: 'Bao' });
    const token = await createUserToken(ctx, user.id);
    expect((await me({ cookie: memberCookie })).status).toBe(200);
    expect((await me({ bearer: token })).status).toBe(200);

    const r = await setRole(user.id, 'blocked', { cookie });
    expect(r.status).toBe(200);
    expect(AdminUser.parse(await r.json())).toMatchObject({
      role_override: 'blocked',
      effective_role: 'blocked',
    });

    const session = await me({ cookie: memberCookie });
    expect(session.status).toBe(401);
    expect(session.headers.getSetCookie().join('\n')).toMatch(/pinwall_session=;.*Max-Age=0/);
    const bearer = await me({ bearer: token });
    expect(bearer.status).toBe(403);
    expect(await errorOf(bearer)).toEqual({
      code: 'access_denied',
      message: t('auth.accessDenied'),
    });
  });

  test('admins cannot change their own role', async () => {
    await start();
    const { user, cookie } = await admin();
    for (const role of ['member', 'blocked', null]) {
      const r = await setRole(user.id, role, { cookie });
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toEqual({ code: 'forbidden', message: t('auth.ownRole') });
    }
    const stored = await ctx.deps.db.db
      .selectFrom('users')
      .select('role_override')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(stored.role_override).toBeNull();
    expect((await me({ cookie })).status).toBe(200);
  });

  test('nobody can override or block the owner', async () => {
    await start();
    const { user: owner, cookie: ownerCookie } = await admin();
    const { cookie } = await member({ name: 'Bao', idpRole: 'admin' });
    const denied = { code: 'forbidden', message: t('auth.ownerRole') };

    for (const role of ['blocked', 'member', 'admin', null]) {
      const r = await setRole(owner.id, role, { cookie });
      expect(r.status, String(role)).toBe(403);
      expect(await errorOf(r)).toEqual(denied);
    }
    const stored = await ctx.deps.db.db
      .selectFrom('users')
      .select('role_override')
      .where('id', '=', owner.id)
      .executeTakeFirstOrThrow();
    expect(stored.role_override).toBeNull();
    expect((await me({ cookie: ownerCookie })).status).toBe(200);

    // An admin who changes their own role is told so, not that the owner is special.
    const self = await member({ name: 'Chi', idpRole: 'admin' });
    const own = await setRole(self.user.id, 'blocked', { cookie: self.cookie });
    expect(own.status).toBe(403);
    expect(await errorOf(own)).toEqual({ code: 'forbidden', message: t('auth.ownRole') });
  });

  test('a role override already stored on the owner is ignored', async () => {
    await start();
    const { user: owner, cookie } = await admin();
    const bao = await member({ name: 'Bao' });
    for (const stored of ['blocked', 'member'] as const) {
      await ctx.deps.db.db
        .updateTable('users')
        .set({ role_override: stored })
        .where('id', '=', owner.id)
        .execute();
      const signedIn = await me({ cookie });
      expect(signedIn.status, stored).toBe(200);
      expect(await signedIn.json()).toMatchObject({ kind: 'owner', role: 'admin' });
      const users = await listed(await list({ cookie }));
      expect(users.items.find((u) => u.id === owner.id)).toMatchObject({ effective_role: 'admin' });
      expect(users.items.find((u) => u.id === bao.user.id)?.effective_role).toBe('member');
    }
  });

  test('an unknown user is not_found', async () => {
    await start();
    const { cookie } = await admin();
    const missing = newId('usr');
    for (const r of [
      await setRole(missing, 'admin', { cookie }),
      await revoke(missing, { cookie }),
    ]) {
      expect(r.status).toBe(404);
      expect(await errorOf(r)).toEqual({ code: 'not_found', message: t('auth.userNotFound') });
    }
  });

  test('Revoke now ends every credential', async () => {
    await start();
    const { cookie } = await admin();
    const bao = await member({ name: 'Bao' });
    const other = await member({ name: 'Chi' });
    const { db } = ctx.deps.db;

    const meta = { ip: '127.0.0.1', userAgent: 'vitest' };
    const secondSession = await createSession(ctx.deps, bao.user.id, 'password', meta);
    const cookies = [bao.cookie, `pinwall_session=${secondSession.secret}`];
    const tokens = [
      await createUserToken(ctx, bao.user.id),
      await createUserToken(ctx, bao.user.id),
    ];
    const otherToken = await createUserToken(ctx, other.user.id);

    // OAuth belongs to M6; the rows are inserted directly. Chi's grant must survive.
    const now = ctx.deps.clock.now();
    await db
      .insertInto('oauth_clients')
      .values({ id: 'cli_1', name: 'Agent', redirect_uris: '[]', created_at: now })
      .execute();
    const grant = (id: string, userId: string) => ({
      id,
      client_id: 'cli_1',
      user_id: userId,
      resource: 'https://pinwall.test/mcp',
      scope: 'artifacts',
      created_at: now,
    });
    await db
      .insertInto('oauth_grants')
      .values([grant('grt_bao', bao.user.id), grant('grt_chi', other.user.id)])
      .execute();
    const oauthToken = (hash: string, grantId: string, kind: 'access' | 'refresh') => ({
      token_hash: hash,
      grant_id: grantId,
      kind,
      created_at: now,
      expires_at: now + 3_600_000,
    });
    await db
      .insertInto('oauth_tokens')
      .values([
        oauthToken('h_bao_access', 'grt_bao', 'access'),
        oauthToken('h_bao_refresh', 'grt_bao', 'refresh'),
        oauthToken('h_chi_access', 'grt_chi', 'access'),
      ])
      .execute();

    clock.advance(5_000);
    const r = await revoke(bao.user.id, { cookie });
    expect(r.status).toBe(200);
    expect(RevokeResult.parse(await r.json())).toEqual({
      sessions: 2,
      api_tokens: 2,
      oauth_grants: 1,
    });

    for (const c of cookies) expect((await me({ cookie: c })).status).toBe(401);
    for (const token of tokens) expect((await me({ bearer: token })).status).toBe(401);
    const grants = await db.selectFrom('oauth_grants').select(['id', 'revoked_at']).execute();
    expect(grants.find((g) => g.id === 'grt_bao')?.revoked_at).toBe(clock.now());
    expect(grants.find((g) => g.id === 'grt_chi')?.revoked_at).toBeNull();
    const kept = await db.selectFrom('oauth_tokens').select('token_hash').execute();
    expect(kept.map((row) => row.token_hash)).toEqual(['h_chi_access']);

    // Other users are untouched, and so is the admin who asked.
    expect((await me({ cookie: other.cookie })).status).toBe(200);
    expect((await me({ bearer: otherToken })).status).toBe(200);
    expect((await me({ cookie })).status).toBe(200);

    const again = await revoke(bao.user.id, { cookie });
    expect(again.status).toBe(200);
    expect(RevokeResult.parse(await again.json())).toEqual({
      sessions: 0,
      api_tokens: 0,
      oauth_grants: 0,
    });
  });

  test('Revoke now works with an admin API token from any origin', async () => {
    await start();
    const { user: owner } = await admin();
    const bearer = await createUserToken(ctx, owner.id);
    const bao = await member({ name: 'Bao' });

    const r = await revoke(bao.user.id, { bearer, origin: 'https://evil.example' });
    expect(r.status).toBe(200);
    expect(RevokeResult.parse(await r.json())).toEqual({
      sessions: 1,
      api_tokens: 0,
      oauth_grants: 0,
    });
    expect((await me({ cookie: bao.cookie })).status).toBe(401);
  });

  test('a cookie request from another origin cannot revoke', async () => {
    await start();
    const { cookie } = await admin();
    const bao = await member({ name: 'Bao' });
    const r = await revoke(bao.user.id, { cookie, origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect((await me({ cookie: bao.cookie })).status).toBe(200);
  });

  test('an admin can revoke their own credentials, which signs them out everywhere', async () => {
    await start();
    const { user, cookie } = await admin();
    const token = await createUserToken(ctx, user.id);
    const r = await revoke(user.id, { cookie });
    expect(r.status).toBe(200);
    expect(RevokeResult.parse(await r.json())).toEqual({
      sessions: 1,
      api_tokens: 1,
      oauth_grants: 0,
    });
    expect((await me({ cookie })).status).toBe(401);
    expect((await me({ bearer: token })).status).toBe(401);
  });

  test('revoking yourself from a browser clears the session cookie like sign-out does', async () => {
    await start();
    const { user, cookie } = await admin();
    const other = await createSession(ctx.deps, user.id, 'password', {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    const signOut = await ctx.request(
      '/api/v1/auth/sign-out',
      apiInit(ctx, { method: 'POST', cookie: `pinwall_session=${other.secret}` }),
    );
    const cleared = signOut.headers.getSetCookie();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(/^pinwall_session=;.*Max-Age=0/);

    const r = await revoke(user.id, { cookie });
    expect(r.status).toBe(200);
    expect(r.headers.getSetCookie()).toEqual(cleared);
  });

  test('revoking someone else, or yourself by API token, leaves the session cookie alone', async () => {
    await start();
    const { user, cookie } = await admin();
    const bao = await member({ name: 'Bao' });
    const token = await createUserToken(ctx, user.id);

    const other = await revoke(bao.user.id, { cookie });
    expect(other.status).toBe(200);
    expect(other.headers.getSetCookie()).toEqual([]);

    // A bearer request neither reads nor touches cookies, even when it ends the browser's session.
    const self = await revoke(user.id, { bearer: token, cookie });
    expect(self.status).toBe(200);
    expect(self.headers.getSetCookie()).toEqual([]);
  });

  test('role changes and revocations are logged', async () => {
    await start();
    const lines: Record<string, unknown>[] = [];
    ctx.deps.logger = createLogger(
      'info',
      new Writable({
        write(chunk, _encoding, done) {
          lines.push(JSON.parse(String(chunk)));
          done();
        },
      }),
    );
    const { user: owner, cookie } = await admin();
    const bao = await member({ name: 'Bao' });

    await setRole(bao.user.id, 'admin', { cookie });
    await revoke(bao.user.id, { cookie });
    const entry = (msg: string) => lines.find((line) => line.msg === msg);
    expect(entry('role override changed')).toMatchObject({
      level: 'info',
      actor_id: owner.id,
      user_id: bao.user.id,
      role_override: 'admin',
    });
    expect(entry('credentials revoked')).toMatchObject({
      level: 'info',
      actor_id: owner.id,
      user_id: bao.user.id,
      sessions: 1,
      api_tokens: 0,
      oauth_grants: 0,
    });
  });
});
