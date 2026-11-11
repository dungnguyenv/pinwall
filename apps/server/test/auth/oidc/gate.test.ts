import { randomUUID } from 'node:crypto';
import { Me } from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { oidcRuntime } from '../../../src/auth/oidc/client.ts';
import {
  gateUser,
  INLINE_RECHECK_TIMEOUT_MS,
  INLINE_RETRY_BACKOFF_MS,
  idpAccessCurrent,
  isRecheckDue,
  MAX_IDP_STALENESS_MS,
} from '../../../src/auth/oidc/gate.ts';
import { runAccessRecheck } from '../../../src/auth/oidc/job.ts';
import type { UserRow } from '../../../src/db/schema.ts';
import { FixedClock } from '../../../src/lib/clock.ts';
import { t } from '../../../src/lib/i18n.ts';
import { apiInit, createSignedInUser, createUserToken, setupOwner } from '../../helpers/auth.ts';
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

describe.each(dialects)('IdP access gate on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(async () => {
    idp.setReachable(true);
    idp.setLatency(0);
    idp.failTokenRequests(null);
    await ctx?.close();
  });

  async function start(provider: TestIdp | null = idp): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env: provider ? provider.env(ROLE_ENV) : {} });
    return ctx;
  }

  function account(o: Partial<TestIdpAccount> = {}): TestIdpAccount {
    return {
      sub: `user-${randomUUID()}`,
      name: 'Ada Example',
      email: 'ada@example.com',
      email_verified: true,
      groups: ['pinwall-users'],
      ...o,
    };
  }

  async function signIn(o: Partial<TestIdpAccount> = {}, provider: TestIdp = idp) {
    const a = account(o);
    const { user, cookie } = await signInOidcUser(ctx, provider, a);
    return { account: a, sub: a.sub, user, cookie };
  }

  const me = (cred: { cookie?: string; bearer?: string }) =>
    ctx.request('/api/v1/me', apiInit(ctx, cred));
  const row = (userId: string) =>
    ctx.deps.db.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  const sessionsOf = (userId: string) =>
    ctx.deps.db.db.selectFrom('sessions').select('id_hash').where('user_id', '=', userId).execute();
  const refreshes = () => idp.tokenRequests('refresh_token');
  const clearsCookie = (r: Response) =>
    r.headers.getSetCookie().some((sc) => /^(__Host-)?pinwall_session=;.*Max-Age=0/.test(sc));

  /** Checks the bearer refusal that asks the person to sign in again. */
  async function expectRecheckRequired(r: Response): Promise<void> {
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
    expect(await r.json()).toEqual({
      error: { code: 'unauthorized', message: t('oidc.recheckRequired') },
    });
  }

  test('the timing constants', () => {
    expect(MAX_IDP_STALENESS_MS).toBe(86_400_000);
    expect(INLINE_RECHECK_TIMEOUT_MS).toBe(5_000);
    expect(INLINE_RETRY_BACKOFF_MS).toBe(60_000);
  });

  test('due and current follow the interval and the 24-hour bound', async () => {
    await start();
    const cfg = ctx.deps.config;
    const t0 = clock.now();
    const oidcRow: UserRow = {
      id: 'usr_1',
      kind: 'oidc',
      email: null,
      email_verified: 0,
      name: 'Ada',
      avatar_url: null,
      idp_role: 'member',
      role_override: null,
      oidc_issuer: idp.issuer,
      oidc_subject: 's1',
      idp_refresh_token: null,
      idp_checked_at: null,
      disabled_at: null,
      disabled_reason: null,
      created_at: t0,
      last_seen_at: null,
    };
    const ownerRow: UserRow = {
      ...oidcRow,
      kind: 'owner',
      idp_role: null,
      oidc_issuer: null,
      oidc_subject: null,
    };
    const u = (o: Partial<UserRow>) =>
      ({ ...oidcRow, idp_checked_at: t0, idp_refresh_token: 'v1.x', ...o }) as UserRow;

    expect(isRecheckDue(u({}), t0 + 12 * H - 1, cfg)).toBe(false);
    expect(isRecheckDue(u({}), t0 + 12 * H, cfg)).toBe(true);
    expect(isRecheckDue(u({ idp_checked_at: null }), t0, cfg)).toBe(true);
    expect(idpAccessCurrent(u({}), t0 + 24 * H - 1, cfg)).toBe(true);
    expect(idpAccessCurrent(u({}), t0 + 24 * H, cfg)).toBe(false);
    expect(idpAccessCurrent(u({ idp_refresh_token: null }), t0 + 12 * H - 1, cfg)).toBe(true);
    expect(idpAccessCurrent(u({ idp_refresh_token: null }), t0 + 12 * H, cfg)).toBe(false);
    expect(idpAccessCurrent(u({ idp_checked_at: null }), t0, cfg)).toBe(false);
    expect(idpAccessCurrent(ownerRow, t0 + 1000 * H, cfg)).toBe(true);
    expect(isRecheckDue(ownerRow, t0 + 1000 * H, cfg)).toBe(false);
  });

  test('a due browser session is re-checked inline before the request is answered', async () => {
    await start();
    const { sub, user, cookie } = await signIn();
    idp.setGroups(sub, ['other']);
    clock.advance(12 * H);
    const before = refreshes();
    const r = await me({ cookie });
    expect(r.status).toBe(401);
    expect(clearsCookie(r)).toBe(true);
    expect(await row(user.id)).toMatchObject({
      disabled_at: clock.now(),
      disabled_reason: 'idp_removed',
    });
    expect(refreshes()).toBe(before + 1);
    expect(await sessionsOf(user.id)).toHaveLength(0);
  });

  test('a due session of a still-admitted user continues and is marked checked', async () => {
    await start();
    const { sub, user, cookie } = await signIn();
    idp.setGroups(sub, ['pinwall-admins']);
    clock.advance(12 * H);
    const r = await me({ cookie });
    expect(r.status).toBe(200);
    // The request is answered with what the IdP says now.
    expect(Me.parse(await r.json())).toMatchObject({ id: user.id, role: 'admin', via: 'session' });
    expect((await row(user.id)).idp_checked_at).toBe(clock.now());
  });

  test('a session that is not due is not re-checked', async () => {
    await start();
    const { cookie } = await signIn();
    clock.advance(12 * H - 1);
    const before = refreshes();
    expect((await me({ cookie })).status).toBe(200);
    expect(refreshes()).toBe(before);
  });

  test('parallel requests from a due session trigger one refresh', async () => {
    await start();
    const { cookie } = await signIn();
    clock.advance(12 * H);
    const before = refreshes();
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => me({ cookie })));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(refreshes()).toBe(before + 1);
  });

  test('bearer requests never call the IdP', async () => {
    await start();
    const { user } = await signIn();
    const token = await createUserToken(ctx, user.id);
    clock.advance(12 * H);
    const before = refreshes();
    const r = await me({ bearer: token });
    expect(r.status).toBe(200);
    expect(refreshes()).toBe(before);
    expect((await row(user.id)).idp_checked_at).toBe(T);
  });

  test('an unreachable IdP keeps access until 24 hours after the last successful check', async () => {
    await start();
    const { user, cookie } = await signIn();
    const token = await createUserToken(ctx, user.id);
    idp.setReachable(false);

    clock.advance(12 * H);
    expect((await me({ cookie })).status).toBe(200);
    expect((await me({ bearer: token })).status).toBe(200);
    clock.advance(12 * H - 1);
    expect((await me({ cookie })).status).toBe(200);
    expect((await me({ bearer: token })).status).toBe(200);

    clock.advance(1);
    const browser = await me({ cookie });
    expect(browser.status).toBe(401);
    expect(clearsCookie(browser)).toBe(true);
    expect(await sessionsOf(user.id)).toHaveLength(0);
    await expectRecheckRequired(await me({ bearer: token }));
    expect(await row(user.id)).toMatchObject({ disabled_at: null, disabled_reason: null });
  });

  test('access returns without admin action when the IdP is reachable again', async () => {
    await start();
    const { user, cookie } = await signIn();
    const token = await createUserToken(ctx, user.id);
    idp.setReachable(false);
    clock.advance(24 * H);
    expect((await me({ cookie })).status).toBe(401);
    await expectRecheckRequired(await me({ bearer: token }));

    idp.setReachable(true);
    expect(await runAccessRecheck(ctx.deps)).toEqual({
      checked: 1,
      ok: 1,
      removed: 0,
      signInRequired: 0,
      transient: 0,
    });
    expect((await me({ bearer: token })).status).toBe(200);
  });

  test('a refused refresh token ends the session at once; other credentials wait for a sign-in', async () => {
    await start();
    const { account: a, sub, user, cookie } = await signIn();
    const token = await createUserToken(ctx, user.id);
    await idp.revokeGrants(sub);
    clock.advance(12 * H);

    const browser = await me({ cookie });
    expect(browser.status).toBe(401);
    expect(clearsCookie(browser)).toBe(true);
    await expectRecheckRequired(await me({ bearer: token }));
    expect(await row(user.id)).toMatchObject({
      disabled_at: null,
      idp_refresh_token: null,
      idp_checked_at: T,
    });

    // Signing in again is all it takes: the IdP's fresh answer lets the same token back in.
    const again = await signInOidcUser(ctx, idp, a);
    expect(again.user.id).toBe(user.id);
    expect((await me({ cookie: again.cookie })).status).toBe(200);
    expect((await me({ bearer: token })).status).toBe(200);
  });

  test('an IdP outage does not slow every request', async () => {
    await start();
    const { cookie } = await signIn();
    idp.setReachable(false);
    clock.advance(12 * H);
    const before = refreshes();
    expect((await me({ cookie })).status).toBe(200);
    expect(refreshes()).toBe(before + 1);
    expect((await me({ cookie })).status).toBe(200);
    expect(refreshes()).toBe(before + 1);
    clock.advance(INLINE_RETRY_BACKOFF_MS - 1);
    expect((await me({ cookie })).status).toBe(200);
    expect(refreshes()).toBe(before + 1);
    clock.advance(2);
    expect((await me({ cookie })).status).toBe(200);
    expect(refreshes()).toBe(before + 2);
  });

  test('a slow IdP is cut off at the inline timeout', async () => {
    await start();
    const { user, cookie } = await signIn();
    const runtime = oidcRuntime(ctx.deps);
    runtime.inlineRecheckTimeoutMs = 100;
    idp.setLatency(1_000);
    clock.advance(12 * H);

    const started = performance.now();
    expect((await me({ cookie })).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(800);
    // Later requests for this user do not wait on the slow IdP again for a while.
    expect(runtime.inlineBackoffUntil.get(user.id)).toBe(clock.now() + INLINE_RETRY_BACKOFF_MS);
    // The check was not abandoned: it finishes in the background.
    const pending = runtime.inflight.get(user.id);
    expect(pending).toBeDefined();
    await pending;
    expect((await row(user.id)).idp_checked_at).toBe(clock.now());
  });

  test('without a refresh token, credentials last until the re-check is due', async () => {
    const noRefresh = await startTestIdp({ refreshTokens: false });
    try {
      await start(noRefresh);
      const { account: a, user, cookie } = await signIn({}, noRefresh);
      expect(user.idp_refresh_token).toBeNull();
      const token = await createUserToken(ctx, user.id);

      clock.advance(12 * H - 1);
      expect((await me({ cookie })).status).toBe(200);
      expect((await me({ bearer: token })).status).toBe(200);
      clock.advance(1);
      expect((await me({ cookie })).status).toBe(401);
      await expectRecheckRequired(await me({ bearer: token }));
      expect(noRefresh.tokenRequests('refresh_token')).toBe(0);

      const again = await signInOidcUser(ctx, noRefresh, a);
      expect(again.user.id).toBe(user.id);
      expect((await me({ cookie: again.cookie })).status).toBe(200);
      expect((await me({ bearer: token })).status).toBe(200);
    } finally {
      await noRefresh.close();
    }
  });

  test('owners are never gated', async () => {
    await start();
    const { me: owner, cookie } = await setupOwner(ctx);
    const token = await createUserToken(ctx, owner.id);
    const before = refreshes();
    clock.advance(25 * H);
    expect((await me({ cookie })).status).toBe(200);
    expect((await me({ bearer: token })).status).toBe(200);
    expect(refreshes()).toBe(before);
  });

  test('with OIDC turned off, IdP users keep access only until they are due', async () => {
    await start(null);
    const { user, cookie } = await createSignedInUser(ctx, { kind: 'oidc' });
    const token = await createUserToken(ctx, user.id);
    clock.advance(12 * H - 1);
    expect((await me({ cookie })).status).toBe(200);
    expect((await me({ bearer: token })).status).toBe(200);
    clock.advance(1);
    expect((await me({ cookie })).status).toBe(401);
    await expectRecheckRequired(await me({ bearer: token }));
  });

  test('gateUser lets non-IdP users through and refuses stale IdP rows without inline', async () => {
    await start();
    const { me: owner } = await setupOwner(ctx);
    const ownerRow = await row(owner.id);
    expect(await gateUser(ctx.deps, ownerRow, { inline: true })).toEqual({
      ok: true,
      user: ownerRow,
    });
    const { user } = await signIn();
    clock.advance(24 * H);
    const before = refreshes();
    expect(await gateUser(ctx.deps, await row(user.id), { inline: false })).toEqual({
      ok: false,
      idpUnavailable: false,
    });
    expect(refreshes()).toBe(before);
  });

  test('gateUser tells an IdP that could not answer from one that ended access', async () => {
    await start();
    // The IdP is down past the 24-hour bound: a later check may still let the user in.
    const { user } = await signIn();
    idp.setReachable(false);
    clock.advance(24 * H);
    const unavailable = { ok: false, idpUnavailable: true };
    expect(await gateUser(ctx.deps, await row(user.id), { inline: true })).toEqual(unavailable);
    // Within the backoff the IdP is not asked again, and the answer is the same.
    const before = refreshes();
    expect(await gateUser(ctx.deps, await row(user.id), { inline: true })).toEqual(unavailable);
    expect(refreshes()).toBe(before);

    // A slow IdP cut off at the inline timeout could not answer either.
    idp.setReachable(true);
    const slow = await signIn();
    oidcRuntime(ctx.deps).inlineRecheckTimeoutMs = 50;
    idp.setLatency(500);
    clock.advance(24 * H);
    expect(await gateUser(ctx.deps, await row(slow.user.id), { inline: true })).toEqual(
      unavailable,
    );
    await oidcRuntime(ctx.deps).inflight.get(slow.user.id);
    idp.setLatency(0);

    // The IdP refused the refresh token: only a sign-in brings the user back.
    const refused = await signIn();
    await idp.revokeGrants(refused.sub);
    clock.advance(24 * H);
    expect(await gateUser(ctx.deps, await row(refused.user.id), { inline: true })).toEqual({
      ok: false,
      idpUnavailable: false,
    });
  });
});
