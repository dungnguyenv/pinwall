import { AdminUserList, Me, RevokeResult } from '@pinwall/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runAccessRecheck } from '../../../src/auth/oidc/job.ts';
import type { DbDialect } from '../../../src/db/connect.ts';
import { FixedClock } from '../../../src/lib/clock.ts';
import { t } from '../../../src/lib/i18n.ts';
import { apiInit, createUserToken, sessionCookieFrom } from '../../helpers/auth.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dialects } from '../../helpers/db.ts';
import {
  bindingCookieFrom,
  signInOidcUser,
  signInWithIdp,
  switchAccount,
  switchLinkOf,
} from '../../helpers/oidc-browser.ts';
import {
  startTestIdp,
  type TestIdp,
  type TestIdpAccount,
  type TestIdpOptions,
} from '../../helpers/oidc-idp.ts';

const T = Date.UTC(2026, 10, 10);
const H = 3_600_000;
const ZITADEL_ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles';
const GROUP_ENV = {
  PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admin',
  PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-member',
};

/** `text` as hono/jsx writes it into a page. */
const html = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** An in-process IdP, a Pinwall app wired to it on a fixed clock, and what a browser does there. */
interface Stack {
  idp: TestIdp;
  ctx: TestContext;
  clock: FixedClock;
  close(): Promise<void>;
}

async function startStack(
  dialect: DbDialect,
  idpOptions: TestIdpOptions,
  env: Record<string, string>,
): Promise<Stack> {
  const idp = await startTestIdp(idpOptions);
  const clock = new FixedClock(T);
  let ctx: TestContext;
  try {
    ctx = await createTestContext({ dialect, clock, env: idp.env(env) });
  } catch (error) {
    await idp.close();
    throw error;
  }
  return {
    idp,
    ctx,
    clock,
    close: async () => {
      await ctx.close();
      await idp.close();
    },
  };
}

const meOf = (s: Stack, cred: { cookie?: string; bearer?: string }) =>
  s.ctx.request('/api/v1/me', apiInit(s.ctx, cred));

/** The role `/me` reports for a signed-in browser; fails unless the request is answered 200. */
async function roleOf(s: Stack, cookie: string): Promise<string> {
  const r = await meOf(s, { cookie });
  if (r.status !== 200) throw new Error(`GET /me answered ${r.status}: ${await r.text()}`);
  return Me.parse(await r.json()).role;
}

/**
 * Signs in as `account` and expects the no-access page; returns its HTML and the binding cookie
 * the browser then holds.
 */
async function signInDenied(
  s: Stack,
  account: TestIdpAccount,
  o: { returnTo?: string } = {},
): Promise<{ page: string; cookie: string }> {
  s.idp.addAccount(account);
  const r = await signInWithIdp(s.ctx, s.idp, { as: account.sub, ...o });
  expect(r.status).toBe(403);
  expect(r.headers.get('content-type')).toMatch(/^text\/html/);
  expect(sessionCookieFrom(r)).toBeNull();
  const page = await r.text();
  expect(page).toContain(html(t('oidc.noAccess.title')));
  return { page, cookie: bindingCookieFrom(r) ?? '' };
}

const userRow = (s: Stack, userId: string) =>
  s.ctx.deps.db.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();

describe.each(dialects)('OIDC acceptance 3 and 3b on %s', (dialect) => {
  describe('Parts A and D–H: a Zitadel-like IdP, then access lost over 48 hours', () => {
    let s: Stack;
    beforeAll(async () => {
      s = await startStack(dialect, { groupsClaim: ZITADEL_ROLES_CLAIM }, GROUP_ENV);
    });
    afterAll(() => s?.close());

    const account = (sub: string, name: string, groups: unknown): TestIdpAccount => ({
      sub,
      name,
      email: `${sub}@example.org`,
      email_verified: true,
      groups,
    });
    const ada = account('ada', 'Ada Lovelace', { 'pinwall-admin': { '1': 'org.example' } });
    const bob = account('bob', 'Bob Builder', { 'pinwall-member': {} });
    const eve = account('eve', 'Eve Outsider', { other: {} });
    const bob2 = account('bob2', 'Bob Second', { 'pinwall-member': {} });
    const carol = account('carol', 'Carol Member', { 'pinwall-member': {} });
    const dave = account('dave', 'Dave Member', { 'pinwall-member': {} });

    // What the parts hand to each other, in order.
    let adaCookie = '';
    let bobCookie = '';
    let bobId = '';
    let bob2Id = '';
    let bob2Cookie = '';

    test('A: roles come from the Zitadel roles claim, and a rejected person can switch account', async () => {
      const adaIn = await signInOidcUser(s.ctx, s.idp, ada);
      adaCookie = adaIn.cookie;
      expect(await roleOf(s, adaCookie)).toBe('admin');

      const bobIn = await signInOidcUser(s.ctx, s.idp, bob);
      bobCookie = bobIn.cookie;
      bobId = bobIn.user.id;
      expect(await roleOf(s, bobCookie)).toBe('member');

      const { page, cookie } = await signInDenied(s, eve, { returnTo: '/projects/p1' });
      expect(page).toContain(html('Eve Outsider'));
      expect(page).toContain(html('eve@example.org'));
      expect(page).toContain(html(t('oidc.noAccess.switch')));
      // The IdP supports RP-Initiated Logout, so the link ends Eve's IdP session first.
      const link = switchLinkOf(s.ctx, page);
      expect(link.pathname).toBe('/auth/oidc/switch');

      // Following the link, in the same browser, as somebody else.
      s.idp.addAccount(bob2);
      const signOuts = s.idp.endSessionRequests.length;
      const r = await switchAccount(s.ctx, s.idp, { link, cookie, as: bob2.sub });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(
        new URL('/projects/p1', s.ctx.deps.config.publicOrigin).href,
      );
      expect(s.idp.endSessionRequests).toHaveLength(signOuts + 1);
      expect(s.idp.authorizationRequests.at(-1)?.get('prompt')?.split(' ')).toContain(
        'select_account',
      );
      bob2Cookie = sessionCookieFrom(r) ?? '';
      expect(await roleOf(s, bob2Cookie)).toBe('member');
      bob2Id = (
        await s.ctx.deps.db.db
          .selectFrom('users')
          .select('id')
          .where('oidc_subject', '=', bob2.sub)
          .executeTakeFirstOrThrow()
      ).id;
    });

    test('D: a person removed at the IdP loses every credential within 24 hours, by the job alone', async () => {
      const { db } = s.ctx.deps.db;
      const bobToken = await createUserToken(s.ctx, bobId);
      await db
        .insertInto('oauth_clients')
        .values({ id: 'cli_1', name: 'Agent', redirect_uris: '[]', created_at: s.clock.now() })
        .execute();
      await db
        .insertInto('oauth_grants')
        .values({
          id: 'grt_1',
          client_id: 'cli_1',
          user_id: bobId,
          resource: 'https://pinwall.test/mcp',
          scope: 'artifacts',
          created_at: s.clock.now(),
        })
        .execute();
      await db
        .insertInto('oauth_tokens')
        .values({
          token_hash: 'hash_1',
          grant_id: 'grt_1',
          kind: 'access',
          created_at: s.clock.now(),
          expires_at: s.clock.now() + H,
        })
        .execute();
      expect((await meOf(s, { cookie: bobCookie })).status).toBe(200);
      expect((await meOf(s, { bearer: bobToken })).status).toBe(200);

      const removedAt = s.clock.now();
      s.idp.setGroups(bob.sub, ['x']);
      s.clock.advance(12 * H);
      expect(await runAccessRecheck(s.ctx.deps)).toMatchObject({ removed: 1, transient: 0 });

      expect((await meOf(s, { cookie: bobCookie })).status).toBe(401);
      expect((await meOf(s, { bearer: bobToken })).status).toBe(401);
      const grant = await db
        .selectFrom('oauth_grants')
        .selectAll()
        .where('id', '=', 'grt_1')
        .executeTakeFirstOrThrow();
      expect(grant.revoked_at).not.toBeNull();
      expect(await db.selectFrom('oauth_tokens').selectAll().execute()).toHaveLength(0);

      const list = await s.ctx.request(
        '/api/v1/admin/users',
        apiInit(s.ctx, { cookie: adaCookie }),
      );
      expect(list.status).toBe(200);
      const listed = AdminUserList.parse(await list.json()).items.find((u) => u.id === bobId);
      expect(listed).toMatchObject({ disabled_reason: 'idp_removed' });
      expect(listed?.disabled_at).not.toBeNull();
      expect(s.clock.now() - removedAt).toBeLessThanOrEqual(24 * H);
    });

    test('E: the same loss comes inline, with the job never run', async () => {
      const { user, cookie } = await signInOidcUser(s.ctx, s.idp, carol);
      expect(await roleOf(s, cookie)).toBe('member');
      s.idp.setGroups(carol.sub, ['x']);
      s.clock.advance(12 * H);
      const refreshes = s.idp.tokenRequests('refresh_token');

      expect((await meOf(s, { cookie })).status).toBe(401);
      expect(s.idp.tokenRequests('refresh_token')).toBe(refreshes + 1);
      expect(await userRow(s, user.id)).toMatchObject({
        disabled_at: s.clock.now(),
        disabled_reason: 'idp_removed',
      });
    });

    test('F: an IdP outage cuts access at 24 hours without disabling anyone, and ends by itself', async () => {
      const { user, cookie } = await signInOidcUser(s.ctx, s.idp, dave);
      const token = await createUserToken(s.ctx, user.id);
      expect((await meOf(s, { cookie })).status).toBe(200);
      expect((await meOf(s, { bearer: token })).status).toBe(200);

      s.idp.setReachable(false);
      try {
        s.clock.advance(24 * H);
        expect((await meOf(s, { cookie })).status).toBe(401);
        expect((await meOf(s, { bearer: token })).status).toBe(401);
        expect(await userRow(s, user.id)).toMatchObject({
          disabled_at: null,
          disabled_reason: null,
        });
      } finally {
        s.idp.setReachable(true);
      }

      expect(await runAccessRecheck(s.ctx.deps)).toMatchObject({ removed: 0, transient: 0 });
      expect((await meOf(s, { bearer: token })).status).toBe(200);
    });

    test('G: "Revoke now" takes effect at once', async () => {
      const bob2Token = await createUserToken(s.ctx, bob2Id);
      expect((await meOf(s, { cookie: bob2Cookie })).status).toBe(200);
      expect((await meOf(s, { bearer: bob2Token })).status).toBe(200);

      const r = await s.ctx.request(
        `/api/v1/admin/users/${bob2Id}/revoke`,
        apiInit(s.ctx, { method: 'POST', cookie: adaCookie }),
      );
      expect(r.status).toBe(200);
      expect(RevokeResult.parse(await r.json())).toEqual({
        sessions: 1,
        api_tokens: 1,
        oauth_grants: 0,
      });
      expect((await meOf(s, { cookie: bob2Cookie })).status).toBe(401);
      expect((await meOf(s, { bearer: bob2Token })).status).toBe(401);
    });

    test('H: put back in the group, a removed person signs in again', async () => {
      expect((await userRow(s, bobId)).disabled_at).not.toBeNull();
      s.idp.setGroups(bob.sub, ['pinwall-member']);

      const r = await signInWithIdp(s.ctx, s.idp, { as: bob.sub });
      expect(r.status).toBe(302);
      expect(await userRow(s, bobId)).toMatchObject({ disabled_at: null, disabled_reason: null });
      const cookie = sessionCookieFrom(r) ?? '';
      expect(await roleOf(s, cookie)).toBe('member');
    });
  });

  describe('Part B: a Keycloak-like IdP', () => {
    let s: Stack;
    beforeAll(async () => {
      s = await startStack(
        dialect,
        { groupsClaim: 'realm_access' },
        {
          ...GROUP_ENV,
          PINWALL_OIDC_ROLES_CLAIM: 'realm_access.roles',
        },
      );
    });
    afterAll(() => s?.close());

    test('roles come from the nested realm_access.roles claim', async () => {
      const admin = await signInOidcUser(s.ctx, s.idp, {
        sub: 'kc-admin',
        name: 'Kay Admin',
        email: 'kay@example.org',
        email_verified: true,
        groups: { roles: ['pinwall-admin'] },
      });
      expect(await roleOf(s, admin.cookie)).toBe('admin');

      const { page } = await signInDenied(s, {
        sub: 'kc-nobody',
        name: 'Nina Nobody',
        email: 'nina@example.org',
        email_verified: true,
        groups: { roles: ['nobody'] },
      });
      expect(page).toContain(html('Nina Nobody'));
    });
  });

  describe('Part C: a Google-like IdP', () => {
    let s: Stack;
    beforeAll(async () => {
      s = await startStack(
        dialect,
        { groupsClaim: null, endSession: false },
        {
          PINWALL_ADMIN_EMAILS: 'boss@example.com',
          PINWALL_MEMBER_DOMAINS: 'example.com',
          PINWALL_MEMBER_EMAILS: 'friend@gmail.com',
        },
      );
    });
    afterAll(() => s?.close());

    const google = (email: string, emailVerified = true): TestIdpAccount => ({
      sub: `g-${email}`,
      name: email.split('@')[0] ?? email,
      email,
      email_verified: emailVerified,
    });

    test('roles come from verified emails and domains', async () => {
      for (const [email, role] of [
        ['boss@example.com', 'admin'],
        ['ann@example.com', 'member'],
        ['friend@gmail.com', 'member'],
      ] as const) {
        const { cookie } = await signInOidcUser(s.ctx, s.idp, google(email));
        expect(await roleOf(s, cookie), email).toBe(role);
      }
    });

    test('anybody else gets the no-access page', async () => {
      const { page: stranger } = await signInDenied(s, google('stranger@gmail.com'));
      expect(stranger).toContain(html('stranger@gmail.com'));
      expect(stranger).not.toContain(html(t('oidc.noAccess.unverified')));
    });

    test('an unverified email does not count', async () => {
      const { page } = await signInDenied(s, google('ann2@example.com', false));
      expect(page).toContain(html('ann2@example.com'));
      expect(page).toContain(html(t('oidc.noAccess.unverified')));
    });
  });
});
