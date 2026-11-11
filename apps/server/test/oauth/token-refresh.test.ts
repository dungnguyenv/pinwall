import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { revokeAllCredentials } from '../../src/auth/revoke.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret, newSecret } from '../../src/lib/ids.ts';
import { oauthAccessTokenResolver, type TokenResponse } from '../../src/oauth/tokens.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { issueTestTokens, registerTestClient, tokenRequest } from '../helpers/oauth.ts';
import { signInOidcUser } from '../helpers/oidc-browser.ts';
import { startTestIdp, type TestIdp, type TestIdpAccount } from '../helpers/oidc-idp.ts';

const T = Date.UTC(2026, 10, 10);
const H = 3_600_000;
const MCP = 'http://localhost:8080/mcp';

let idp: TestIdp;
beforeAll(async () => {
  idp = await startTestIdp();
});
afterAll(() => idp?.close());

async function expectRefusal(r: Response, status: number, error: string, description: string) {
  expect(r.status).toBe(status);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.json()).toEqual({ error, error_description: description });
}

describe.each(dialects)('refreshing OAuth tokens on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let ada: { user: UserRow; cookie: string };
  /** The client of the last `issue`; `refresh` sends it unless told otherwise. */
  let clientId: string;
  afterEach(async () => {
    idp.setReachable(true);
    idp.setLatency(0);
    await ctx?.close();
  });

  /** A fresh app at `T` whose owner, Ada, is signed in; `env` adds configuration (an IdP). */
  async function start(env: Record<string, string> = {}): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    ada = await createSignedInUser(ctx, { name: 'Ada' });
  }

  /** A new client signed in as the holder of `cookie`, with its first pair of tokens. */
  async function issue(cookie: string) {
    const issued = await issueTestTokens(ctx, cookie);
    clientId = issued.clientId;
    return issued;
  }

  const refresh = (token: string, extra: Record<string, string> = {}) =>
    tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: clientId,
      ...extra,
    });
  const tokensFrom = async (r: Response): Promise<TokenResponse> => {
    expect(r.status).toBe(200);
    return (await r.json()) as TokenResponse;
  };

  const resolve = (token: string) => oauthAccessTokenResolver.resolve(ctx.deps, token);
  const tokenRow = (token: string) =>
    ctx.deps.db.db
      .selectFrom('oauth_tokens')
      .selectAll()
      .where('token_hash', '=', hashSecret(token))
      .executeTakeFirst();
  const grantOf = (client: string) =>
    ctx.deps.db.db
      .selectFrom('oauth_grants')
      .selectAll()
      .where('client_id', '=', client)
      .executeTakeFirstOrThrow();
  const tokensOfGrant = (grantId: string) =>
    ctx.deps.db.db.selectFrom('oauth_tokens').selectAll().where('grant_id', '=', grantId).execute();
  const userRow = (id: string) =>
    ctx.deps.db.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  /** An app with the test IdP whose `pinwall-users` group admits members. */
  const startWithIdp = () => start(idp.env({ PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-users' }));

  /** Signs in a new IdP member through the IdP. */
  async function signInMember() {
    const account: TestIdpAccount = {
      sub: `user-${randomUUID()}`,
      name: 'Bea Example',
      email: 'bea@example.com',
      email_verified: true,
      groups: ['pinwall-users'],
    };
    return { account, ...(await signInOidcUser(ctx, idp, account)) };
  }

  test('refresh rotates both tokens', async () => {
    await start();
    const t0 = await issue(ada.cookie);
    clock.advance(1_000);
    const now = T + 1_000;
    const r = await refresh(t0.refresh);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('pragma')).toBe('no-cache');
    const t1 = await tokensFrom(r);
    expect(t1).toEqual({
      access_token: expect.stringMatching(/^pwa_[A-Za-z0-9_-]{43}$/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^pwr_[A-Za-z0-9_-]{43}$/),
      scope: 'pinwall',
    });
    expect(t1.access_token).not.toBe(t0.access);
    expect(t1.refresh_token).not.toBe(t0.refresh);

    const grant = await grantOf(clientId);
    expect(grant).toMatchObject({ last_used_at: now, revoked_at: null });
    expect(await tokenRow(t0.refresh)).toMatchObject({ used_at: now });
    expect(await tokenRow(t1.refresh_token)).toEqual({
      token_hash: hashSecret(t1.refresh_token),
      grant_id: grant.id,
      kind: 'refresh',
      created_at: now,
      expires_at: now + 2_592_000_000,
      used_at: null,
    });
    expect(await tokenRow(t1.access_token)).toMatchObject({
      grant_id: grant.id,
      kind: 'access',
      expires_at: now + 3_600_000,
    });
    const client = await ctx.deps.db.db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('id', '=', clientId)
      .executeTakeFirstOrThrow();
    expect(client.last_used_at).toBe(now);

    // Both access tokens work; the old one until it runs out an hour after it was issued.
    expect(await resolve(t1.access_token)).toMatchObject({ user: { id: ada.user.id } });
    clock.advance(3_600_000 - 1_000 - 1);
    expect(await resolve(t0.access)).toMatchObject({ user: { id: ada.user.id } });
    clock.advance(1);
    expect(await resolve(t0.access)).toBeNull();
    expect(await resolve(t1.access_token)).toMatchObject({ user: { id: ada.user.id } });
  });

  test('a rotated refresh token reused within 120 s gets a fresh pair without revoking', async () => {
    await start();
    const t0 = await issue(ada.cookie);
    const r1 = await tokensFrom(await refresh(t0.refresh));
    const grant = await grantOf(clientId);
    const info = vi.spyOn(ctx.deps.logger, 'info');

    clock.advance(119_000);
    const r2 = await tokensFrom(await refresh(t0.refresh));
    expect(r2.refresh_token).not.toBe(r1.refresh_token);
    expect(r2.access_token).not.toBe(r1.access_token);
    expect(info).toHaveBeenCalledWith(
      { client_id: clientId, grant_id: grant.id, user_id: ada.user.id },
      'oauth refresh token reused within grace',
    );
    // Exactly 120 s after its first use, the window is still open.
    clock.advance(1_000);
    await tokensFrom(await refresh(t0.refresh));

    expect(await grantOf(clientId)).toMatchObject({ revoked_at: null });
    // The first use is what the window counts from.
    expect(await tokenRow(t0.refresh)).toMatchObject({ used_at: T });
    clock.advance(10 * 60_000);
    await tokensFrom(await refresh(r1.refresh_token));
    await tokensFrom(await refresh(r2.refresh_token));
  });

  test('reusing a rotated refresh token after 120 s revokes the grant', async () => {
    await start();
    const t0 = await issue(ada.cookie);
    const r1 = await tokensFrom(await refresh(t0.refresh));
    const grant = await grantOf(clientId);
    const warn = vi.spyOn(ctx.deps.logger, 'warn');

    clock.advance(120_001);
    await expectRefusal(await refresh(t0.refresh), 400, 'invalid_grant', t('oauth.token.reused'));
    expect(await grantOf(clientId)).toMatchObject({ revoked_at: T + 120_001 });
    expect(warn).toHaveBeenCalledWith(
      { grant_id: grant.id, client_id: clientId, user_id: ada.user.id },
      'oauth refresh token reused; grant revoked',
    );
    await expectRefusal(
      await refresh(r1.refresh_token),
      400,
      'invalid_grant',
      t('oauth.token.badRefresh'),
    );
    expect(await tokensOfGrant(grant.id)).toEqual([]);
    expect(await resolve(r1.access_token)).toBeNull();
  });

  test('two refreshes of one token at once both succeed', async () => {
    await start();
    const t0 = await issue(ada.cookie);
    const answers = await Promise.all([refresh(t0.refresh), refresh(t0.refresh)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    const [a, b] = (await Promise.all(answers.map((r) => r.json()))) as TokenResponse[];
    expect(a?.refresh_token).not.toBe(b?.refresh_token);
    expect(await grantOf(clientId)).toMatchObject({ revoked_at: null });
    expect(await tokenRow(t0.refresh)).toMatchObject({ used_at: T });
    for (const pair of [a, b]) await tokensFrom(await refresh(pair?.refresh_token ?? ''));
  });

  test('refresh tokens expire after 30 days', async () => {
    await start();
    const t0 = await issue(ada.cookie);
    const t1 = await issue(ada.cookie);
    clock.advance(2_592_000_000 - 1);
    await tokensFrom(await refresh(t1.refresh, { client_id: t1.clientId }));
    clock.advance(1);
    await expectRefusal(
      await refresh(t0.refresh, { client_id: t0.clientId }),
      400,
      'invalid_grant',
      t('oauth.token.badRefresh'),
    );
    expect(await grantOf(t0.clientId)).toMatchObject({ revoked_at: null });
  });

  test('refresh checks client and resource', async () => {
    await start();
    const t0 = await issue(ada.cookie);
    const other = await registerTestClient(ctx, { name: 'Other' });
    await expectRefusal(
      await refresh(t0.refresh, { client_id: other.clientId }),
      400,
      'invalid_grant',
      t('oauth.token.badRefresh'),
    );
    await expectRefusal(
      await refresh(t0.refresh, { resource: 'https://other.example/mcp' }),
      400,
      'invalid_target',
      t('oauth.token.resource', { resource: MCP }),
    );
    const unknown = t('oauth.token.unknownClient');
    await expectRefusal(
      await refresh(t0.refresh, { client_id: 'cli_unknown' }),
      401,
      'invalid_client',
      unknown,
    );
    const noClient = await tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: t0.refresh,
    });
    await expectRefusal(noClient, 401, 'invalid_client', unknown);

    // None of these used the token up, and the resource may be spelled another way.
    expect(await tokenRow(t0.refresh)).toMatchObject({ used_at: null });
    await tokensFrom(await refresh(t0.refresh, { resource: 'HTTP://LOCALHOST:8080/mcp/' }));
    expect(await grantOf(clientId)).toMatchObject({ revoked_at: null });
  });

  test('only a refresh token of a live grant for this resource refreshes', async () => {
    await start();
    const t0 = await issue(ada.cookie);
    const bad = t('oauth.token.badRefresh');
    for (const token of [t0.access, `pwr_${newSecret()}`, '']) {
      await expectRefusal(await refresh(token), 400, 'invalid_grant', bad);
    }
    const form = { grant_type: 'refresh_token', client_id: clientId };
    await expectRefusal(await tokenRequest(ctx, form), 400, 'invalid_grant', bad);

    // The public origin changed since the grant was made: its tokens would never be accepted.
    const setResource = (resource: string) =>
      ctx.deps.db.db.updateTable('oauth_grants').set({ resource }).execute();
    await setResource('https://old.example/mcp');
    await expectRefusal(await refresh(t0.refresh), 400, 'invalid_grant', bad);
    await setResource(MCP);
    await tokensFrom(await refresh(t0.refresh));
  });

  test('refresh is refused for a blocked person without using up the token', async () => {
    await start();
    const bea = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bea' });
    const t0 = await issue(bea.cookie);
    const setOverride = (role_override: 'blocked' | null) =>
      ctx.deps.db.db
        .updateTable('users')
        .set({ role_override })
        .where('id', '=', bea.user.id)
        .execute();

    await setOverride('blocked');
    await expectRefusal(
      await refresh(t0.refresh),
      400,
      'invalid_grant',
      t('oauth.token.accessEnded'),
    );
    expect(await tokenRow(t0.refresh)).toMatchObject({ used_at: null });
    await setOverride(null);
    await tokensFrom(await refresh(t0.refresh));
  });

  test('refresh re-checks an OIDC member with the IdP and refuses a removed one', async () => {
    await startWithIdp();
    const bea = await signInMember();
    const t0 = await issue(bea.cookie);
    idp.setGroups(bea.account.sub, ['other']);
    clock.advance(12 * H);
    const before = idp.tokenRequests('refresh_token');

    await expectRefusal(
      await refresh(t0.refresh),
      400,
      'invalid_grant',
      t('oauth.token.accessEnded'),
    );
    expect(await userRow(bea.user.id)).toMatchObject({
      disabled_at: T + 12 * H,
      disabled_reason: 'idp_removed',
    });
    expect(idp.tokenRequests('refresh_token')).toBe(before + 1);
    expect(await grantOf(clientId)).toMatchObject({ revoked_at: T + 12 * H });
  });

  test('two refreshes that wait on one IdP re-check both succeed', async () => {
    await startWithIdp();
    const bea = await signInMember();
    const t0 = await issue(bea.cookie);
    const info = vi.spyOn(ctx.deps.logger, 'info');
    clock.advance(12 * H);
    const before = idp.tokenRequests('refresh_token');
    // Both read the token as unused, then wait on the same IdP answer before either uses it.
    idp.setLatency(200);
    const answers = await Promise.all([refresh(t0.refresh), refresh(t0.refresh)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(idp.tokenRequests('refresh_token')).toBe(before + 1);
    expect(await grantOf(clientId)).toMatchObject({ revoked_at: null });
    expect(await tokenRow(t0.refresh)).toMatchObject({ used_at: T + 12 * H });
    const reused = info.mock.calls.filter(
      ([, message]) => message === 'oauth refresh token reused within grace',
    );
    expect(reused).toHaveLength(1);
  });

  test('an IdP outage refuses the refresh without using up the token', async () => {
    await startWithIdp();
    const bea = await signInMember();
    const t0 = await issue(bea.cookie);
    idp.setReachable(false);
    clock.advance(24 * H);

    await expectRefusal(
      await refresh(t0.refresh),
      400,
      'invalid_grant',
      t('oauth.token.accessEnded'),
    );
    expect(await tokenRow(t0.refresh)).toMatchObject({ used_at: null });

    idp.setReachable(true);
    clock.advance(60_001);
    await tokensFrom(await refresh(t0.refresh));
    expect(await grantOf(clientId)).toMatchObject({ revoked_at: null });
    expect(await userRow(bea.user.id)).toMatchObject({ disabled_at: null });
  });

  test('an IdP that refuses its refresh token asks for a sign-in, and the token waits', async () => {
    await startWithIdp();
    const bea = await signInMember();
    const t0 = await issue(bea.cookie);
    await idp.revokeGrants(bea.account.sub);
    clock.advance(12 * H);

    await expectRefusal(
      await refresh(t0.refresh),
      400,
      'invalid_grant',
      t('oauth.token.accessEnded'),
    );
    expect(await userRow(bea.user.id)).toMatchObject({
      disabled_at: null,
      idp_refresh_token: null,
    });
    expect(await tokenRow(t0.refresh)).toMatchObject({ used_at: null });
    expect(await grantOf(clientId)).toMatchObject({ revoked_at: null });

    // Signing in again is all it takes for the same refresh token to work.
    await signInOidcUser(ctx, idp, bea.account);
    await tokensFrom(await refresh(t0.refresh));
  });

  test('Revoke now ends OAuth tokens', async () => {
    await start();
    const t0 = await issue(ada.cookie);
    const t1 = await tokensFrom(await refresh(t0.refresh));
    await revokeAllCredentials(ctx.deps, ada.user.id);
    await expectRefusal(
      await refresh(t1.refresh_token),
      400,
      'invalid_grant',
      t('oauth.token.badRefresh'),
    );
    expect(await resolve(t0.access)).toBeNull();
    expect(await resolve(t1.access_token)).toBeNull();
  });
});
