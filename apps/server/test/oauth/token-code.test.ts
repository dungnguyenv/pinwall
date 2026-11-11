import { afterEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret, newSecret } from '../../src/lib/ids.ts';
import { revokeGrant } from '../../src/oauth/grants.ts';
import { oauthAccessTokenResolver } from '../../src/oauth/tokens.ts';
import { apiInit, createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { approve, issueTestTokens, registerTestClient, tokenRequest } from '../helpers/oauth.ts';

const T = Date.UTC(2026, 10, 10);
const MCP = 'http://localhost:8080/mcp';
/** Stands for a second registered client in a test table; the test registers it. */
const SECOND_CLIENT = '<second client>';

async function expectRefusal(r: Response, status: number, error: string, description: string) {
  expect(r.status).toBe(status);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.json()).toEqual({ error, error_description: description });
}

describe.each(dialects)('the token endpoint on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let ada: { user: UserRow; cookie: string };
  let clientId: string;
  let redirectUri: string;
  let code: string;
  let verifier: string;
  afterEach(() => ctx?.close());

  /** Ada (the owner) has approved a new client, which holds a fresh code. */
  async function start(): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    ada = await createSignedInUser(ctx, { name: 'Ada' });
    ({ clientId, redirectUri } = await registerTestClient(ctx));
    ({ code, verifier } = await approve(ctx, ada.cookie, { clientId, redirectUri }));
  }

  const exchangeForm = (change: Record<string, string> = {}): Record<string, string> => ({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: clientId,
    resource: MCP,
    ...change,
  });
  const exchange = (change: Record<string, string> = {}) => tokenRequest(ctx, exchangeForm(change));

  const grants = () => ctx.deps.db.db.selectFrom('oauth_grants').selectAll().execute();
  const tokens = () =>
    ctx.deps.db.db.selectFrom('oauth_tokens').selectAll().orderBy('kind').execute();
  const setGrant = (values: { resource?: string; revoked_at?: number | null }) =>
    ctx.deps.db.db.updateTable('oauth_grants').set(values).execute();

  test('a code becomes an access and a refresh token', async () => {
    await start();
    clock.advance(1_000);
    const now = T + 1_000;
    const r = await exchange();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('pragma')).toBe('no-cache');
    const body = (await r.json()) as { access_token: string; refresh_token: string };
    expect(body).toEqual({
      access_token: expect.stringMatching(/^pwa_[A-Za-z0-9_-]{43}$/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^pwr_[A-Za-z0-9_-]{43}$/),
      scope: 'pinwall',
    });

    const [grant] = await grants();
    expect(grant).toMatchObject({ client_id: clientId, user_id: ada.user.id, last_used_at: now });
    expect(await tokens()).toEqual([
      {
        token_hash: hashSecret(body.access_token),
        grant_id: grant?.id,
        kind: 'access',
        created_at: now,
        expires_at: now + 3_600_000,
        used_at: null,
      },
      {
        token_hash: hashSecret(body.refresh_token),
        grant_id: grant?.id,
        kind: 'refresh',
        created_at: now,
        expires_at: now + 2_592_000_000,
        used_at: null,
      },
    ]);
    // Only hashes are stored: no column anywhere holds a token as issued.
    const stored = JSON.stringify([await tokens(), await grants()]);
    expect(stored).not.toContain(body.access_token);
    expect(stored).not.toContain(body.refresh_token);
    const client = await ctx.deps.db.db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('id', '=', clientId)
      .executeTakeFirstOrThrow();
    expect(client.last_used_at).toBe(now);
  });

  test('resource is optional and tolerates its spellings', async () => {
    await start();
    const form = exchangeForm();
    delete form.resource;
    expect((await tokenRequest(ctx, form)).status).toBe(200);
    for (const resource of ['HTTP://LOCALHOST:8080/mcp/', 'http://localhost:8080/mcp']) {
      ({ code, verifier } = await approve(ctx, ada.cookie, { clientId, redirectUri }));
      expect((await exchange({ resource })).status, resource).toBe(200);
    }
  });

  test('a form sent as URLSearchParams with a charset is accepted', async () => {
    await start();
    // fetch labels this body `application/x-www-form-urlencoded;charset=UTF-8`.
    const r = await ctx.request('/oauth/token', {
      method: 'POST',
      body: new URLSearchParams(exchangeForm()),
    });
    expect(r.status).toBe(200);
  });

  test('codes expire after 60 seconds', async () => {
    await start();
    clock.advance(59_999);
    expect((await exchange()).status).toBe(200);

    ({ code, verifier } = await approve(ctx, ada.cookie, { clientId, redirectUri }));
    clock.advance(60_000);
    await expectRefusal(await exchange(), 400, 'invalid_grant', t('oauth.token.badCode'));
  });

  test('a replayed code is refused and ends what it issued', async () => {
    await start();
    const first = await exchange();
    expect(first.status).toBe(200);
    const { access_token } = (await first.json()) as { access_token: string };
    clock.advance(5_000);

    await expectRefusal(await exchange(), 400, 'invalid_grant', t('oauth.token.badCode'));
    expect(await grants()).toEqual([expect.objectContaining({ revoked_at: T + 5_000 })]);
    expect(await tokens()).toEqual([]);
    expect(await oauthAccessTokenResolver.resolve(ctx.deps, access_token)).toBeNull();
  });

  test.each([
    ['a wrong verifier', { code_verifier: 'w'.repeat(43) }, 'invalid_grant'],
    ['another redirect_uri', { redirect_uri: 'http://127.0.0.1:1/x' }, 'invalid_grant'],
    ['another registered client', { client_id: SECOND_CLIENT }, 'invalid_grant'],
    ['no verifier', { code_verifier: '' }, 'invalid_grant'],
    ['another resource', { resource: 'https://other.example/mcp' }, 'invalid_target'],
  ])('the exchange checks %s', async (_, change: Record<string, string>, error) => {
    await start();
    const form = { ...change };
    if (form.client_id === SECOND_CLIENT) {
      form.client_id = (await registerTestClient(ctx, { name: 'Other' })).clientId;
    }
    const description =
      error === 'invalid_target'
        ? t('oauth.token.resource', { resource: MCP })
        : t('oauth.token.mismatch');
    await expectRefusal(await exchange(form), 400, error, description);
    expect(await tokens()).toEqual([]);

    // The attempt used the code up: a correct retry is refused, as a replay that ends the grant.
    clock.advance(1_000);
    await expectRefusal(await exchange(), 400, 'invalid_grant', t('oauth.token.badCode'));
    expect(await grants()).toEqual([expect.objectContaining({ revoked_at: T + 1_000 })]);
    expect(await tokens()).toEqual([]);
  });

  test('an unknown client is invalid_client', async () => {
    await start();
    const unknown = t('oauth.token.unknownClient');
    await expectRefusal(
      await exchange({ client_id: 'cli_unknown' }),
      401,
      'invalid_client',
      unknown,
    );
    const form = exchangeForm();
    delete form.client_id;
    await expectRefusal(await tokenRequest(ctx, form), 401, 'invalid_client', unknown);
    // Refused before the code is looked at, so the code still works.
    expect((await exchange()).status).toBe(200);
  });

  test('a revoked grant or a blocked user gets no tokens', async () => {
    await start();
    const ended = t('oauth.token.accessEnded');
    const [grant] = await grants();
    await revokeGrant(ctx.deps, grant?.id ?? '');
    await expectRefusal(await exchange(), 400, 'invalid_grant', ended);

    const bea = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bea' });
    ({ code, verifier } = await approve(ctx, bea.cookie, { clientId, redirectUri }));
    await ctx.deps.db.db
      .updateTable('users')
      .set({ role_override: 'blocked' })
      .where('id', '=', bea.user.id)
      .execute();
    await expectRefusal(await exchange(), 400, 'invalid_grant', ended);
    expect(await tokens()).toEqual([]);
  });

  test('the token endpoint takes forms only', async () => {
    await start();
    const json = await ctx.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exchangeForm()),
    });
    await expectRefusal(json, 400, 'invalid_request', t('oauth.token.form'));

    const grantType = t('oauth.token.grantType');
    for (const grant_type of ['password', 'client_credentials', 'constructor', '']) {
      await expectRefusal(
        await tokenRequest(ctx, { grant_type }),
        400,
        'unsupported_grant_type',
        grantType,
      );
    }
    await expectRefusal(await tokenRequest(ctx, {}), 400, 'unsupported_grant_type', grantType);

    // RFC 6749 §3.2: no parameter may be sent twice.
    const twice = `${new URLSearchParams(exchangeForm())}&resource=${encodeURIComponent(MCP)}`;
    const repeated = await ctx.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: twice,
    });
    await expectRefusal(repeated, 400, 'invalid_request', t('oauth.token.repeated'));

    const tooLarge = t('oauth.body.tooLarge');
    await expectRefusal(
      await exchange({ pad: 'x'.repeat(16_384) }),
      400,
      'invalid_request',
      tooLarge,
    );
    const declared = await ctx.request('/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '20000',
      },
      body: new URLSearchParams(exchangeForm()).toString(),
    });
    await expectRefusal(declared, 400, 'invalid_request', tooLarge);

    // None of these used the code up.
    expect((await exchange()).status).toBe(200);
  });

  test('the token endpoint is rate limited per IP', async () => {
    await start();
    for (let i = 0; i < 120; i += 1) {
      expect((await tokenRequest(ctx, { grant_type: 'password' })).status).toBe(400);
    }
    const r = await exchange();
    expect(r.status).toBe(429);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await r.json()).toMatchObject({
      error: 'temporarily_unavailable',
      error_description: expect.any(String),
    });
  });

  test('the resolver accepts live access tokens for this resource only', async () => {
    await start();
    const { access, refresh } = await issueTestTokens(ctx, ada.cookie);
    const resolve = (token: string) => oauthAccessTokenResolver.resolve(ctx.deps, token);
    expect(oauthAccessTokenResolver.name).toBe('oauth');
    expect(oauthAccessTokenResolver.matches(access)).toBe(true);
    expect(oauthAccessTokenResolver.matches(refresh)).toBe(false);
    expect(oauthAccessTokenResolver.matches(`pw_${newSecret()}`)).toBe(false);

    expect(await resolve(access)).toMatchObject({ via: 'oauth', user: { id: ada.user.id } });
    expect(await resolve(refresh)).toBeNull();
    expect(await resolve(`pwa_${newSecret()}`)).toBeNull();

    // The public origin changed since the grant was made: its tokens are for another resource.
    await setGrant({ resource: 'https://old.example/mcp' });
    expect(await resolve(access)).toBeNull();
    await setGrant({ resource: MCP });
    // A grant revoked while its tokens are still in the table.
    await setGrant({ revoked_at: T });
    expect(await resolve(access)).toBeNull();
    await setGrant({ revoked_at: null });

    clock.advance(3_599_999);
    expect(await resolve(access)).toMatchObject({ via: 'oauth' });
    clock.advance(1);
    expect(await resolve(access)).toBeNull();
  });

  test('the resolver records use at most once a minute', async () => {
    await start();
    const { access } = await issueTestTokens(ctx, ada.cookie);
    const grantOf = async () => {
      const row = await ctx.deps.db.db
        .selectFrom('oauth_tokens')
        .innerJoin('oauth_grants', 'oauth_grants.id', 'oauth_tokens.grant_id')
        .select('oauth_grants.last_used_at')
        .where('oauth_tokens.token_hash', '=', hashSecret(access))
        .executeTakeFirstOrThrow();
      return row.last_used_at;
    };
    const lastSeen = async () =>
      (
        await ctx.deps.db.db
          .selectFrom('users')
          .select('last_seen_at')
          .where('id', '=', ada.user.id)
          .executeTakeFirstOrThrow()
      ).last_seen_at;

    clock.advance(59_999);
    await oauthAccessTokenResolver.resolve(ctx.deps, access);
    expect(await grantOf()).toBe(T);
    clock.advance(1);
    const auth = await oauthAccessTokenResolver.resolve(ctx.deps, access);
    expect(await grantOf()).toBe(T + 60_000);
    expect(await lastSeen()).toBe(T + 60_000);
    expect(auth?.user.last_seen_at).toBe(T + 60_000);
  });

  test('OAuth access tokens are not accepted outside /mcp', async () => {
    await start();
    const { access } = await issueTestTokens(ctx, ada.cookie);
    const r = await ctx.request('/api/v1/me', apiInit(ctx, { bearer: access }));
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
  });
});
