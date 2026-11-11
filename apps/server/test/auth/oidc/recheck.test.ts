import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  RECHECK_LEASE_TTL_MS,
  type RecheckOutcome,
  recheckUser,
} from '../../../src/auth/oidc/recheck.ts';
import { openRefreshToken } from '../../../src/auth/oidc/users.ts';
import type { RoleOverride, UserRow } from '../../../src/db/schema.ts';
import { FixedClock } from '../../../src/lib/clock.ts';
import { createUserToken, setupOwner } from '../../helpers/auth.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dialects } from '../../helpers/db.ts';
import { signInOidcUser } from '../../helpers/oidc-browser.ts';
import { startTestIdp, type TestIdp, type TestIdpAccount } from '../../helpers/oidc-idp.ts';

const T = Date.UTC(2026, 10, 10);
const H = 3_600_000;
const ROLE_ENV = {
  PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins',
  PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-users',
};

let idp: TestIdp;
beforeAll(async () => {
  idp = await startTestIdp();
});
afterAll(() => idp?.close());

describe.each(dialects)('access re-check on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(async () => {
    idp.setReachable(true);
    idp.failTokenRequests(null);
    await ctx?.close();
  });

  async function start(provider: TestIdp = idp): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env: provider.env(ROLE_ENV) });
    return ctx;
  }

  /** Signs in a new IdP account, a member unless told otherwise, through the real routes. */
  async function signIn(o: Partial<TestIdpAccount> = {}, provider: TestIdp = idp) {
    const account: TestIdpAccount = {
      sub: `user-${randomUUID()}`,
      name: 'Ada Example',
      email: 'ada@example.com',
      email_verified: true,
      groups: ['pinwall-users'],
      ...o,
    };
    const { user, cookie } = await signInOidcUser(ctx, provider, account);
    return { sub: account.sub, user, cookie };
  }

  const row = (userId: string) =>
    ctx.deps.db.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  const setColumns = (userId: string, values: Partial<Omit<UserRow, 'id' | 'created_at'>>) =>
    ctx.deps.db.db.updateTable('users').set(values).where('id', '=', userId).execute();
  const refreshes = () => idp.tokenRequests('refresh_token');
  const outcome = async (userId: string): Promise<RecheckOutcome> =>
    (await recheckUser(ctx.deps, userId)).outcome;
  const plainRefreshToken = (u: UserRow) => openRefreshToken(ctx.deps, u.idp_refresh_token ?? '');

  /** Gives the user an API token and an OAuth grant with an access token, beside the session. */
  async function addCredentials(userId: string): Promise<void> {
    await createUserToken(ctx, userId);
    const { db } = ctx.deps.db;
    const now = clock.now();
    // OAuth belongs to M6; the rows are inserted directly, as in M2's Revoke now test.
    await db
      .insertInto('oauth_clients')
      .values({ id: 'cli_1', name: 'Agent', redirect_uris: '[]', created_at: now })
      .execute();
    await db
      .insertInto('oauth_grants')
      .values({
        id: 'grt_1',
        client_id: 'cli_1',
        user_id: userId,
        resource: 'https://pinwall.test/mcp',
        scope: 'artifacts',
        created_at: now,
      })
      .execute();
    await db
      .insertInto('oauth_tokens')
      .values({
        token_hash: 'h_access',
        grant_id: 'grt_1',
        kind: 'access',
        created_at: now,
        expires_at: now + H,
      })
      .execute();
  }

  /**
   * The user must sign in again: still enabled, the refresh token dropped, the last good check
   * kept (so the gate refuses what is left once it is due), no browser session, and the API
   * token and OAuth grant from `addCredentials` untouched.
   */
  async function expectSignInRequired(userId: string, checkedAt: number): Promise<void> {
    const { db } = ctx.deps.db;
    expect(await row(userId)).toMatchObject({
      disabled_at: null,
      disabled_reason: null,
      idp_refresh_token: null,
      idp_checked_at: checkedAt,
    });
    const sessions = await db
      .selectFrom('sessions')
      .select('id_hash')
      .where('user_id', '=', userId)
      .execute();
    expect(sessions).toHaveLength(0);
    const tokens = await db
      .selectFrom('api_tokens')
      .select('revoked_at')
      .where('user_id', '=', userId)
      .execute();
    expect(tokens).toEqual([{ revoked_at: null }]);
    const grants = await db.selectFrom('oauth_grants').select(['id', 'revoked_at']).execute();
    expect(grants).toEqual([{ id: 'grt_1', revoked_at: null }]);
    const oauthTokens = await db.selectFrom('oauth_tokens').select('token_hash').execute();
    expect(oauthTokens).toEqual([{ token_hash: 'h_access' }]);
  }

  test('a still-admitted user is checked and keeps access', async () => {
    await start();
    const { user } = await signIn();
    clock.advance(12 * H);
    const before = refreshes();
    const r = await recheckUser(ctx.deps, user.id);
    expect(r.outcome).toBe('ok');
    expect(r.user).toEqual(await row(user.id));
    expect(r.user).toMatchObject({
      idp_checked_at: clock.now(),
      idp_role: 'member',
      disabled_at: null,
    });
    expect(refreshes()).toBe(before + 1);
    // The lease is given back once the check is done.
    expect(await ctx.deps.leases.isHeld(`idp-recheck:${user.id}`)).toBe(false);
  });

  test('a role change at the IdP updates idp_role', async () => {
    await start();
    const { sub, user } = await signIn({ groups: ['pinwall-admins'] });
    expect(user.idp_role).toBe('admin');
    idp.setGroups(sub, ['pinwall-users']);
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('ok');
    expect(await row(user.id)).toMatchObject({ idp_role: 'member', idp_checked_at: clock.now() });
  });

  test('removal from the groups disables and revokes everything', async () => {
    await start();
    const { sub, user } = await signIn();
    await addCredentials(user.id);
    const { db } = ctx.deps.db;
    const info = vi.spyOn(ctx.deps.logger, 'info');

    idp.setGroups(sub, ['other']);
    clock.advance(12 * H);
    const r = await recheckUser(ctx.deps, user.id);
    expect(r.outcome).toBe('removed');
    expect(r.user).toEqual(await row(user.id));
    expect(r.user).toMatchObject({
      disabled_at: clock.now(),
      disabled_reason: 'idp_removed',
      idp_refresh_token: null,
      idp_role: null,
    });
    const sessions = await db
      .selectFrom('sessions')
      .select('id_hash')
      .where('user_id', '=', user.id)
      .execute();
    expect(sessions).toHaveLength(0);
    const tokens = await db
      .selectFrom('api_tokens')
      .select('revoked_at')
      .where('user_id', '=', user.id)
      .execute();
    expect(tokens).toEqual([{ revoked_at: clock.now() }]);
    const grants = await db.selectFrom('oauth_grants').select(['id', 'revoked_at']).execute();
    expect(grants).toEqual([{ id: 'grt_1', revoked_at: clock.now() }]);
    const oauthTokens = await db
      .selectFrom('oauth_tokens')
      .select('token_hash')
      .where('grant_id', '=', 'grt_1')
      .execute();
    expect(oauthTokens).toHaveLength(0);
    expect(info).toHaveBeenCalledWith({ user_id: user.id }, 'oidc user removed');
  });

  test('a refused refresh token asks for a new sign-in: sessions end, other credentials stay', async () => {
    await start();
    const { sub, user } = await signIn();
    await addCredentials(user.id);
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    const info = vi.spyOn(ctx.deps.logger, 'info');
    await idp.revokeGrants(sub);
    clock.advance(12 * H);

    const r = await recheckUser(ctx.deps, user.id);
    expect(r.outcome).toBe('sign_in_required');
    expect(r.user).toEqual(await row(user.id));
    await expectSignInRequired(user.id, T);
    expect(warn).toHaveBeenCalledWith(
      { user_id: user.id, class: 'invalid_grant', code: 'invalid_grant' },
      'idp re-check: sign-in required',
    );
    expect(info).not.toHaveBeenCalledWith(expect.anything(), 'oidc user removed');
  });

  test('a disabled IdP account is refused the same way, without being removed', async () => {
    await start();
    const { sub, user } = await signIn();
    await addCredentials(user.id);
    idp.disable(sub);
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('sign_in_required');
    await expectSignInRequired(user.id, T);
  });

  test('a refresh token spent by a lost IdP answer asks for a new sign-in, not removal', async () => {
    await start();
    const { user } = await signIn();
    await addCredentials(user.id);
    const spent = (await row(user.id)).idp_refresh_token;
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('ok');
    // As if the rotated token never reached Pinwall: it still holds the one the IdP spent.
    await setColumns(user.id, { idp_refresh_token: spent, idp_checked_at: T });
    expect(await outcome(user.id)).toBe('sign_in_required');
    await expectSignInRequired(user.id, T);
  });

  test('an unreachable IdP is transient and changes nothing', async () => {
    await start();
    const { user } = await signIn();
    const before = await row(user.id);
    const refreshToken = plainRefreshToken(before);
    expect(refreshToken).toBeTruthy();
    const logged = (['warn', 'error', 'info'] as const).map((level) =>
      vi.spyOn(ctx.deps.logger, level),
    );

    idp.setReachable(false);
    clock.advance(12 * H);
    const r = await recheckUser(ctx.deps, user.id);
    expect(r.outcome).toBe('transient');
    expect(await row(user.id)).toEqual(before);
    expect(r.user).toEqual(before);
    expect(logged[0]).toHaveBeenCalledWith(
      { user_id: user.id, class: 'unavailable', code: expect.stringMatching(/^\w+$/) },
      'idp re-check failed',
    );
    for (const spy of logged) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(refreshToken);
        expect(JSON.stringify(call)).not.toContain(before.idp_refresh_token);
      }
    }
  });

  test('an IdP 5xx is transient', async () => {
    await start();
    const { user } = await signIn();
    const before = await row(user.id);
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    idp.failTokenRequests({ status: 503, error: 'temporarily_unavailable' });
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('transient');
    expect(await row(user.id)).toEqual(before);
    expect(warn).toHaveBeenCalledWith(
      { user_id: user.id, class: 'unavailable', code: 'OAUTH_RESPONSE_IS_NOT_CONFORM' },
      'idp re-check failed',
    );
  });

  test('a misconfigured client is transient, not removal', async () => {
    await start();
    const { user } = await signIn();
    const before = await row(user.id);
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    idp.failTokenRequests({ status: 401, error: 'invalid_client' });
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('transient');
    expect(await row(user.id)).toEqual(before);
    expect(warn).toHaveBeenCalledWith(
      { user_id: user.id, class: 'failed', code: 'invalid_client' },
      'idp re-check failed',
    );
  });

  test('a rotated refresh token is saved', async () => {
    await start();
    const { user } = await signIn();
    const first = plainRefreshToken(await row(user.id));
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('ok');
    const second = plainRefreshToken(await row(user.id));
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    // The rotated token is the one that works now: the first one was spent.
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('ok');
  });

  test('role_override keeps a user after group removal, not past a refused refresh token', async () => {
    await start();
    const { sub, user } = await signIn();
    await setColumns(user.id, { role_override: 'member' satisfies RoleOverride });
    idp.setGroups(sub, ['other']);
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('ok');
    expect(await row(user.id)).toMatchObject({
      idp_role: null,
      role_override: 'member',
      disabled_at: null,
    });

    idp.disable(sub);
    const checkedAt = clock.now();
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('sign_in_required');
    expect(await row(user.id)).toMatchObject({
      role_override: 'member',
      disabled_at: null,
      idp_refresh_token: null,
      idp_checked_at: checkedAt,
    });
  });

  test('concurrent re-checks of one user share one refresh', async () => {
    await start();
    const { user } = await signIn();
    clock.advance(12 * H);
    const before = refreshes();
    const results = await Promise.all([1, 2, 3].map(() => recheckUser(ctx.deps, user.id)));
    expect(results.map((r) => r.outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(refreshes()).toBe(before + 1);
    // A later check is a new one.
    expect(await outcome(user.id)).toBe('ok');
    expect(refreshes()).toBe(before + 2);
  });

  test('a user being re-checked elsewhere is left alone', async () => {
    await start();
    const { user } = await signIn();
    clock.advance(12 * H);
    const lease = `idp-recheck:${user.id}`;
    expect(await ctx.deps.leases.acquire(lease, 'other', RECHECK_LEASE_TTL_MS)).toBe(true);
    const before = await row(user.id);
    const requests = refreshes();
    expect(await outcome(user.id)).toBe('transient');
    expect(refreshes()).toBe(requests);
    expect(await row(user.id)).toEqual(before);
    // The other holder keeps its lease.
    expect(await ctx.deps.leases.renew(lease, 'other', RECHECK_LEASE_TTL_MS)).toBe(true);
  });

  test('a user without a refresh token is not sent to the IdP', async () => {
    const noRefresh = await startTestIdp({ refreshTokens: false });
    try {
      await start(noRefresh);
      const { user } = await signIn({}, noRefresh);
      expect(user.idp_refresh_token).toBeNull();
      clock.advance(12 * H);
      const r = await recheckUser(ctx.deps, user.id);
      expect(r.outcome).toBe('no_refresh_token');
      expect(r.user).toEqual(await row(user.id));
      expect(noRefresh.tokenRequests('refresh_token')).toBe(0);
    } finally {
      await noRefresh.close();
    }
  });

  test('a refresh token that cannot be decrypted is dropped, not sent', async () => {
    await start();
    const { user } = await signIn();
    await setColumns(user.id, { idp_refresh_token: 'v1.damaged' });
    const requests = refreshes();
    clock.advance(12 * H);
    expect(await outcome(user.id)).toBe('no_refresh_token');
    expect(refreshes()).toBe(requests);
    expect(await row(user.id)).toMatchObject({ idp_refresh_token: null, disabled_at: null });
  });

  test('owners, blocked and disabled users are skipped', async () => {
    await start();
    const { me: owner } = await setupOwner(ctx);
    const blocked = await signIn();
    await setColumns(blocked.user.id, { role_override: 'blocked' });
    const disabled = await signIn();
    await setColumns(disabled.user.id, { disabled_at: T, disabled_reason: 'idp_removed' });
    const requests = refreshes();
    clock.advance(12 * H);

    for (const id of [owner.id, blocked.user.id, disabled.user.id]) {
      const before = await row(id);
      const r = await recheckUser(ctx.deps, id);
      expect(r).toEqual({ outcome: 'skipped', user: before });
      expect(await row(id)).toEqual(before);
    }
    expect(await recheckUser(ctx.deps, 'usr_missing')).toEqual({
      outcome: 'skipped',
      user: undefined,
    });
    expect(refreshes()).toBe(requests);
  });

  test('a refresh token from another issuer is never sent to this one', async () => {
    await start();
    const { user } = await signIn();
    await setColumns(user.id, { oidc_issuer: 'https://old-idp.example' });
    const before = await row(user.id);
    const requests = refreshes();
    clock.advance(12 * H);
    expect(await recheckUser(ctx.deps, user.id)).toEqual({ outcome: 'skipped', user: before });
    expect(refreshes()).toBe(requests);
  });

  test('without OIDC configured nothing is re-checked', async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    const { me: owner } = await setupOwner(ctx);
    expect(await recheckUser(ctx.deps, owner.id)).toEqual({ outcome: 'skipped', user: undefined });
  });
});
