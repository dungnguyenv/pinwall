import { afterEach, describe, expect, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { newSecret } from '../../src/lib/ids.ts';
import { oauthAccessTokenResolver } from '../../src/oauth/tokens.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { issueTestTokens, registerTestClient, tokenRequest } from '../helpers/oauth.ts';

const T = Date.UTC(2026, 10, 10);

async function expectRefusal(r: Response, status: number, error: string, description: string) {
  expect(r.status).toBe(status);
  expect(r.headers.get('cache-control')).toBe('no-store');
  expect(await r.json()).toEqual({ error, error_description: description });
}

describe.each(dialects)('token revocation on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let ada: { user: UserRow; cookie: string };
  let tokens: { clientId: string; access: string; refresh: string };
  afterEach(() => ctx?.close());

  /** Ada (the owner) has connected a client, which holds its first pair of tokens. */
  async function start(): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    ada = await createSignedInUser(ctx, { name: 'Ada' });
    tokens = await issueTestTokens(ctx, ada.cookie);
  }

  const revoke = (form: Record<string, string>) => tokenRequest(ctx, form, '/oauth/revoke');
  const refresh = (token: string) =>
    tokenRequest(ctx, {
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: tokens.clientId,
    });
  const resolve = (token: string) => oauthAccessTokenResolver.resolve(ctx.deps, token);
  const grant = () =>
    ctx.deps.db.db
      .selectFrom('oauth_grants')
      .selectAll()
      .where('client_id', '=', tokens.clientId)
      .executeTakeFirstOrThrow();
  const allTokens = () =>
    ctx.deps.db.db.selectFrom('oauth_tokens').selectAll().orderBy('token_hash').execute();

  /** Checks the RFC 7009 success answer: 200 with an empty body, never cached. */
  async function expectRevoked(r: Response): Promise<void> {
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toBe('');
  }

  test('revoking a refresh token ends the grant', async () => {
    await start();
    clock.advance(1_000);
    // The hint is only a hint (RFC 7009 §2.1): a wrong one changes nothing.
    await expectRevoked(
      await revoke({
        token: tokens.refresh,
        client_id: tokens.clientId,
        token_type_hint: 'access_token',
      }),
    );
    const { id, revoked_at } = await grant();
    expect(revoked_at).toBe(T + 1_000);
    await expectRefusal(
      await refresh(tokens.refresh),
      400,
      'invalid_grant',
      t('oauth.token.badRefresh'),
    );
    expect(await resolve(tokens.access)).toBeNull();
    expect(await allTokens()).not.toContainEqual(expect.objectContaining({ grant_id: id }));

    // Revoking it again is answered the same way.
    await expectRevoked(await revoke({ token: tokens.refresh, client_id: tokens.clientId }));
  });

  test('revoking an access token ends only that token', async () => {
    await start();
    await expectRevoked(await revoke({ token: tokens.access, client_id: tokens.clientId }));
    expect(await resolve(tokens.access)).toBeNull();
    expect(await grant()).toMatchObject({ revoked_at: null });
    const r = await refresh(tokens.refresh);
    expect(r.status).toBe(200);
    const { access_token } = (await r.json()) as { access_token: string };
    expect(await resolve(access_token)).toMatchObject({ user: { id: ada.user.id } });
  });

  test('revocation answers 200 for unknown tokens and other clients without changing anything', async () => {
    await start();
    const other = await registerTestClient(ctx, { name: 'Other' });
    const before = await allTokens();
    for (const form of [
      { token: tokens.refresh, client_id: other.clientId },
      { token: tokens.access, client_id: other.clientId },
      { token: tokens.refresh, client_id: 'cli_unknown' },
      { token: `pwr_${newSecret()}`, client_id: tokens.clientId },
      { token: `pwa_${newSecret()}`, client_id: tokens.clientId },
      { token: 'not a token', client_id: tokens.clientId },
    ]) {
      await expectRevoked(await revoke(form));
    }
    expect(await allTokens()).toEqual(before);
    expect(await grant()).toMatchObject({ revoked_at: null });
    expect(await resolve(tokens.access)).toMatchObject({ user: { id: ada.user.id } });
    expect((await refresh(tokens.refresh)).status).toBe(200);
  });

  test('revocation needs token and client_id', async () => {
    await start();
    const missing = t('oauth.revoke.missing');
    const forms: Record<string, string>[] = [
      { token: tokens.refresh },
      { client_id: tokens.clientId },
      { token: '', client_id: tokens.clientId },
      { token: tokens.refresh, client_id: '' },
      {},
    ];
    for (const form of forms) {
      await expectRefusal(await revoke(form), 400, 'invalid_request', missing);
    }
    const json = await ctx.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokens.refresh, client_id: tokens.clientId }),
    });
    await expectRefusal(json, 400, 'invalid_request', t('oauth.token.form'));
    expect(await grant()).toMatchObject({ revoked_at: null });
    expect(await resolve(tokens.access)).toMatchObject({ user: { id: ada.user.id } });
  });

  test('revocation is rate limited per IP', async () => {
    await start();
    for (let i = 0; i < 120; i += 1) {
      expect((await revoke({})).status).toBe(400);
    }
    const r = await revoke({ token: tokens.refresh, client_id: tokens.clientId });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await r.json()).toMatchObject({ error: 'temporarily_unavailable' });
    expect(await grant()).toMatchObject({ revoked_at: null });
  });
});
