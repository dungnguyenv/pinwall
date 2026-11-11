import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  RECHECK_JOB_NAME,
  RECHECK_JOB_PERIOD_MS,
  runAccessRecheck,
  startOidc,
} from '../../../src/auth/oidc/job.ts';
import { deleteUserSessions } from '../../../src/auth/sessions.ts';
import { startAuth } from '../../../src/auth/startup.ts';
import type { UserRow } from '../../../src/db/schema.ts';
import { FixedClock } from '../../../src/lib/clock.ts';
import { createUserToken } from '../../helpers/auth.ts';
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

describe.each(dialects)('access re-check job on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(async () => {
    idp.setReachable(true);
    idp.failTokenRequests(null);
    await ctx?.close();
  });

  async function start(oidc = true): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env: oidc ? idp.env(ROLE_ENV) : {} });
    return ctx;
  }

  async function signIn(o: Partial<TestIdpAccount> = {}) {
    const account: TestIdpAccount = {
      sub: `user-${randomUUID()}`,
      name: 'Ada Example',
      email: 'ada@example.com',
      email_verified: true,
      groups: ['pinwall-users'],
      ...o,
    };
    const { user } = await signInOidcUser(ctx, idp, account);
    return { sub: account.sub, user };
  }

  /** Signs in, then ends the browser session, so the user holds no credential yet. */
  async function signedOut() {
    const signedIn = await signIn();
    await deleteUserSessions(ctx.deps, signedIn.user.id);
    return signedIn;
  }

  const checkedAt = async (u: { user: UserRow }) =>
    (
      await ctx.deps.db.db
        .selectFrom('users')
        .select('idp_checked_at')
        .where('id', '=', u.user.id)
        .executeTakeFirstOrThrow()
    ).idp_checked_at;

  async function addOAuthGrant(userId: string): Promise<void> {
    const { db } = ctx.deps.db;
    const now = clock.now();
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
  }

  test('the job re-checks due users with live credentials only', async () => {
    await start();
    const a = await signIn();
    const b = await signedOut();
    const d = await signedOut();
    await createUserToken(ctx, d.user.id);
    const e = await signedOut();
    await createUserToken(ctx, e.user.id);
    await ctx.deps.db.db
      .updateTable('api_tokens')
      .set({ expires_at: clock.now() + 1 })
      .where('user_id', '=', e.user.id)
      .execute();
    const f = await signedOut();
    await addOAuthGrant(f.user.id);
    clock.advance(11 * H);
    const c = await signIn();
    clock.advance(1 * H);

    expect(await runAccessRecheck(ctx.deps)).toEqual({
      checked: 3,
      ok: 3,
      removed: 0,
      transient: 0,
    });
    for (const u of [a, d, f]) expect(await checkedAt(u)).toBe(clock.now());
    for (const u of [b, e]) expect(await checkedAt(u)).toBe(T);
    expect(await checkedAt(c)).toBe(T + 11 * H);
  });

  test('the job leaves out users it must not or cannot re-check', async () => {
    await start();
    const set = (u: { user: UserRow }, values: Partial<Omit<UserRow, 'id' | 'created_at'>>) =>
      ctx.deps.db.db.updateTable('users').set(values).where('id', '=', u.user.id).execute();
    await set(await signIn(), { role_override: 'blocked' });
    await set(await signIn(), { disabled_at: T, disabled_reason: 'idp_removed' });
    await set(await signIn(), { idp_refresh_token: null });
    await set(await signIn(), { oidc_issuer: 'https://old-idp.example' });
    const overridden = await signIn();
    await set(overridden, { role_override: 'admin' });
    const requests = idp.tokenRequests('refresh_token');
    clock.advance(12 * H);

    expect(await runAccessRecheck(ctx.deps)).toEqual({
      checked: 1,
      ok: 1,
      removed: 0,
      transient: 0,
    });
    expect(await checkedAt(overridden)).toBe(clock.now());
    expect(idp.tokenRequests('refresh_token')).toBe(requests + 1);
  });

  test('the job picks users who become due before its next run', async () => {
    await start();
    const a = await signIn();
    clock.advance(12 * H - RECHECK_JOB_PERIOD_MS);
    expect((await runAccessRecheck(ctx.deps)).checked).toBe(0);
    clock.advance(1);
    expect((await runAccessRecheck(ctx.deps)).checked).toBe(1);
    expect(await checkedAt(a)).toBe(clock.now());
  });

  test('the job counts removals and transient failures', async () => {
    await start();
    const kept = await signIn();
    const removed = await signIn();
    const failing = await signIn();
    idp.setGroups(removed.sub, ['other']);
    idp.failTokenRequests({ status: 503, error: 'temporarily_unavailable', sub: failing.sub });
    const info = vi.spyOn(ctx.deps.logger, 'info');
    clock.advance(12 * H);

    const summary = await runAccessRecheck(ctx.deps);
    expect(summary).toEqual({ checked: 3, ok: 1, removed: 1, transient: 1 });
    expect(info).toHaveBeenCalledWith(summary, 'access re-check');
    expect(await checkedAt(kept)).toBe(clock.now());
    expect(await checkedAt(failing)).toBe(T);
  });

  test('a run with nobody due logs nothing', async () => {
    await start();
    await signIn();
    const info = vi.spyOn(ctx.deps.logger, 'info');
    expect(await runAccessRecheck(ctx.deps)).toEqual({
      checked: 0,
      ok: 0,
      removed: 0,
      transient: 0,
    });
    expect(info).not.toHaveBeenCalled();
  });

  test('startOidc schedules the job every 15 minutes', async () => {
    await start();
    const every = vi.spyOn(ctx.deps.scheduler, 'every');
    startOidc(ctx.deps);
    expect(every).toHaveBeenCalledExactlyOnceWith(RECHECK_JOB_NAME, 900_000, expect.any(Function));
    expect(RECHECK_JOB_NAME).toBe('access-recheck');

    // The scheduled function is the re-check run.
    const a = await signIn();
    clock.advance(12 * H);
    const run = every.mock.calls[0]?.[2];
    await run?.();
    expect(await checkedAt(a)).toBe(clock.now());

    await ctx.close();
    await start(false);
    const plain = vi.spyOn(ctx.deps.scheduler, 'every');
    startOidc(ctx.deps);
    expect(plain).not.toHaveBeenCalled();
  });

  test('startAuth starts the OIDC job', async () => {
    await start();
    const every = vi.spyOn(ctx.deps.scheduler, 'every');
    await startAuth(ctx.deps);
    expect(every).toHaveBeenCalledWith('access-recheck', 900_000, expect.any(Function));
  });

  test('startOidc survives an unreachable IdP', async () => {
    await start();
    idp.setReachable(false);
    const error = vi.spyOn(ctx.deps.logger, 'error');
    const every = vi.spyOn(ctx.deps.scheduler, 'every');
    expect(() => startOidc(ctx.deps)).not.toThrow();
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(
      { issuer: idp.issuer, code: expect.stringMatching(/^\w+$/) },
      'OIDC discovery failed',
    );
    expect(every).toHaveBeenCalledOnce();

    // A run while discovery still fails changes nothing and does not throw.
    const warn = vi.spyOn(ctx.deps.logger, 'warn');
    expect(await runAccessRecheck(ctx.deps)).toEqual({
      checked: 0,
      ok: 0,
      removed: 0,
      transient: 0,
    });
    expect(warn).toHaveBeenCalledWith(
      { class: 'unavailable', code: expect.stringMatching(/^\w+$/) },
      'idp re-check skipped: discovery failed',
    );
  });
});
