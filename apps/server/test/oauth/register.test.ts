import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { startAuth } from '../../src/auth/startup.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { purgeOAuth } from '../../src/oauth/cleanup.ts';
import {
  cleanClientName,
  clientRedirectUris,
  getClient,
  type RegisteredClient,
  touchClient,
} from '../../src/oauth/clients.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { registerTestClient } from '../helpers/oauth.ts';

const T = Date.UTC(2026, 10, 10);
const DAY_MS = 86_400_000;
const LOOPBACK = 'http://localhost:33418/callback';

test('names are cleaned for the consent page', () => {
  expect(cleanClientName('  Evil\u0000 \u202eApp\u200b  ')).toBe('Evil App');
  expect(cleanClientName('Line\none\ttwo')).toBe('Line one two');
  expect(cleanClientName('x'.repeat(150))).toHaveLength(100);
  expect(cleanClientName(`${'x'.repeat(99)} tail`)).toBe('x'.repeat(99));
  expect(cleanClientName('😀'.repeat(150))).toBe('😀'.repeat(100));
  expect(cleanClientName('Điện thoại')).toBe('Điện thoại');
  expect(cleanClientName('\u200b')).toBe(t('oauth.client.unnamed'));
  expect(cleanClientName(undefined)).toBe(t('oauth.client.unnamed'));
});

describe.each(dialects)('client registration on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  afterEach(() => ctx.close());

  async function start(): Promise<TestContext> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    return ctx;
  }

  const register = (body: unknown, init: { headers?: Record<string, string> } = {}) =>
    ctx.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  async function expectRefusal(r: Response, status: number, error: string, description: string) {
    expect(r.status).toBe(status);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ error, error_description: description });
  }

  const clientRows = () => ctx.deps.db.db.selectFrom('oauth_clients').selectAll().execute();

  test('registers a public client', async () => {
    await start();
    const r = await register({
      client_name: 'Claude Code',
      redirect_uris: [LOOPBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_uri: 'https://example.com',
      scope: 'pinwall',
      software_id: 'ignored',
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = (await r.json()) as RegisteredClient;
    expect(b).toEqual({
      client_id: expect.stringMatching(/^cli_[0-9a-hjkmnp-tv-z]{20}$/),
      client_id_issued_at: Math.floor(clock.now() / 1000),
      client_name: 'Claude Code',
      redirect_uris: [LOOPBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'pinwall',
    });
    expect(OAuthClientInformationFullSchema.safeParse(b).success).toBe(true);

    expect(await clientRows()).toEqual([
      {
        id: b.client_id,
        name: 'Claude Code',
        redirect_uris: JSON.stringify([LOOPBACK]),
        created_at: T,
        last_used_at: null,
      },
    ]);
  });

  test('the minimum body is redirect_uris', async () => {
    await start();
    const uris = ['cursor://anysphere.cursor-mcp/oauth/callback', 'https://app.example/cb'];
    const r = await register({ redirect_uris: uris });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({
      client_name: t('oauth.client.unnamed'),
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect((await clientRows())[0]?.name).toBe(t('oauth.client.unnamed'));
  });

  test('the stored name is cleaned', async () => {
    await start();
    const r = await register({
      client_name: ` A\u202eB${'c'.repeat(200)}`,
      redirect_uris: [LOOPBACK],
    });
    expect(r.status).toBe(201);
    const { client_name } = (await r.json()) as RegisteredClient;
    expect(client_name).toBe(`AB${'c'.repeat(98)}`);
    expect((await clientRows())[0]?.name).toBe(client_name);
  });

  test('confidential clients are refused', async () => {
    await start();
    for (const method of ['client_secret_basic', 'client_secret_post', 'private_key_jwt']) {
      const r = await register({ redirect_uris: [LOOPBACK], token_endpoint_auth_method: method });
      await expectRefusal(r, 400, 'invalid_client_metadata', t('oauth.register.publicOnly'));
    }
    expect(await clientRows()).toEqual([]);
  });

  test.each([
    ['http://evil.example/cb', 'insecure_http'],
    ['javascript:alert(1)', 'forbidden_scheme'],
    ['https://a.example/cb#x', 'fragment'],
  ])('refuses redirect uri %s', async (uri, problem) => {
    await start();
    const r = await register({ redirect_uris: [LOOPBACK, uri] });
    await expectRefusal(
      r,
      400,
      'invalid_redirect_uri',
      t(`oauth.register.redirect.${problem}`, { uri }),
    );
    expect(await clientRows()).toEqual([]);
  });

  test('a long refused uri is cut in the message', async () => {
    await start();
    const uri = `http://evil.example/${'x'.repeat(200)}`;
    const r = await register({ redirect_uris: [uri] });
    const shown = `${uri.slice(0, 99)}…`;
    await expectRefusal(
      r,
      400,
      'invalid_redirect_uri',
      t('oauth.register.redirect.insecure_http', { uri: shown }),
    );
  });

  test('redirect uri count is 1 to 10', async () => {
    await start();
    const many = Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${4000 + i}/cb`);
    for (const body of [{ redirect_uris: [] }, { redirect_uris: many }, { client_name: 'x' }]) {
      await expectRefusal(
        await register(body),
        400,
        'invalid_redirect_uri',
        t('oauth.register.redirectCount'),
      );
    }
    expect((await register({ redirect_uris: many.slice(0, 10) })).status).toBe(201);
  });

  test('unsupported grant or response types are refused', async () => {
    await start();
    await expectRefusal(
      await register({ redirect_uris: [LOOPBACK], grant_types: ['client_credentials'] }),
      400,
      'invalid_client_metadata',
      t('oauth.register.grantTypes'),
    );
    await expectRefusal(
      await register({ redirect_uris: [LOOPBACK], grant_types: ['refresh_token'] }),
      400,
      'invalid_client_metadata',
      t('oauth.register.grantTypes'),
    );
    await expectRefusal(
      await register({ redirect_uris: [LOOPBACK], response_types: ['token'] }),
      400,
      'invalid_client_metadata',
      t('oauth.register.responseTypes'),
    );
    expect(
      (await register({ redirect_uris: [LOOPBACK], grant_types: ['authorization_code'] })).status,
    ).toBe(201);
  });

  test('fields of the wrong type are refused', async () => {
    await start();
    await expectRefusal(
      await register({ redirect_uris: LOOPBACK }),
      400,
      'invalid_redirect_uri',
      t('oauth.register.fieldType', { field: 'redirect_uris' }),
    );
    await expectRefusal(
      await register({ redirect_uris: [LOOPBACK], client_name: 42 }),
      400,
      'invalid_client_metadata',
      t('oauth.register.fieldType', { field: 'client_name' }),
    );
    expect(await clientRows()).toEqual([]);
  });

  test('the body must be a JSON object within 64 KB', async () => {
    await start();
    const body = t('oauth.register.body');
    const valid = JSON.stringify({ redirect_uris: [LOOPBACK] });
    await expectRefusal(
      await register(valid, { headers: { 'content-type': 'text/plain' } }),
      400,
      'invalid_client_metadata',
      body,
    );
    for (const raw of ['[1]', 'null', '"x"', '{', '']) {
      await expectRefusal(await register(raw), 400, 'invalid_client_metadata', body);
    }
    expect(
      (await register(valid, { headers: { 'content-type': 'Application/JSON; charset=utf-8' } }))
        .status,
    ).toBe(201);

    const padded = JSON.stringify({ redirect_uris: [LOOPBACK], pad: 'x'.repeat(70_000) });
    await expectRefusal(await register(padded), 413, 'invalid_request', t('oauth.body.tooLarge'));
    await expectRefusal(
      await register(valid, { headers: { 'content-length': '70000' } }),
      413,
      'invalid_request',
      t('oauth.body.tooLarge'),
    );
    expect(await clientRows()).toHaveLength(1);
  });

  test('registration is rate limited per IP', async () => {
    await start();
    for (let i = 0; i < 30; i++) {
      expect((await register({ redirect_uris: [LOOPBACK] })).status).toBe(201);
    }
    // Refused requests count too, so a malformed one also hits the limit.
    const r = await register('not json');
    expect(r.status).toBe(429);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await r.json()).toMatchObject({
      error: 'temporarily_unavailable',
      error_description: expect.any(String),
    });
    clock.advance(3_600_000);
    expect((await register({ redirect_uris: [LOOPBACK] })).status).toBe(201);
  });

  test('errors outside the OAuth refusals keep their usual shape', async () => {
    await start();
    const r = await ctx.request('/oauth/register', {
      method: 'GET',
      headers: { accept: 'text/html' },
    });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  test('registerTestClient registers through the endpoint', async () => {
    await start();
    const { clientId, redirectUri } = await registerTestClient(ctx);
    expect(redirectUri).toBe('http://127.0.0.1:33418/callback');
    const row = await getClient(ctx.deps.db.db, clientId);
    expect(row).toMatchObject({
      name: 'Claude Code',
      redirect_uris: JSON.stringify([redirectUri]),
    });
    expect(await getClient(ctx.deps.db.db, 'cli_missing')).toBeUndefined();
    if (!row) throw new Error('client row missing');
    expect(clientRedirectUris(row)).toEqual([redirectUri]);
    for (const corrupt of ['not json', '{"a":1}', '[1]']) {
      expect(clientRedirectUris({ ...row, redirect_uris: corrupt }), corrupt).toEqual([]);
    }

    clock.advance(5_000);
    await touchClient(ctx.deps, clientId);
    expect((await getClient(ctx.deps.db.db, clientId))?.last_used_at).toBe(T + 5_000);
  });

  test('the cleanup removes idle clients and expired tokens', async () => {
    await start();
    const { db } = ctx.deps.db;
    const { user } = await createSignedInUser(ctx);
    const now = clock.now();
    const client = (id: string, created_at: number, last_used_at: number | null) => ({
      id,
      name: id,
      redirect_uris: JSON.stringify([LOOPBACK]),
      created_at,
      last_used_at,
    });
    await db
      .insertInto('oauth_clients')
      .values([
        client('cli_a', now - 60 * DAY_MS, now - 30 * DAY_MS),
        client('cli_b', now - 30 * DAY_MS - 1, null),
        client('cli_c', now - 60 * DAY_MS, now - 29 * DAY_MS),
        client('cli_d', now - 30 * DAY_MS + 1, null),
      ])
      .execute();
    const grant = (id: string, client_id: string) => ({
      id,
      client_id,
      user_id: user.id,
      resource: 'http://localhost:8080/mcp',
      scope: 'pinwall',
      created_at: now - 60 * DAY_MS,
      last_used_at: null,
      revoked_at: null,
    });
    await db
      .insertInto('oauth_grants')
      .values([grant('gnt_a', 'cli_a'), grant('gnt_c', 'cli_c')])
      .execute();
    const token = (token_hash: string, grant_id: string, expires_at: number) => ({
      token_hash,
      grant_id,
      kind: 'refresh' as const,
      created_at: now - DAY_MS,
      expires_at,
      used_at: null,
    });
    await db
      .insertInto('oauth_tokens')
      .values([
        token('a-live', 'gnt_a', now + DAY_MS),
        token('c-expired', 'gnt_c', now - 1),
        token('c-live', 'gnt_c', now + DAY_MS),
      ])
      .execute();

    expect(await purgeOAuth(ctx.deps)).toEqual({ tokens: 1, clients: 2 });
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
    expect(ids(await db.selectFrom('oauth_clients').select('id').execute())).toEqual([
      'cli_c',
      'cli_d',
    ]);
    expect(ids(await db.selectFrom('oauth_grants').select('id').execute())).toEqual(['gnt_c']);
    expect(await db.selectFrom('oauth_tokens').select('token_hash').execute()).toEqual([
      { token_hash: 'c-live' },
    ]);
    expect(await purgeOAuth(ctx.deps)).toEqual({ tokens: 0, clients: 0 });
  });

  test('startAuth schedules the OAuth cleanup', async () => {
    await start();
    const every = vi.spyOn(ctx.deps.scheduler, 'every');
    await startAuth(ctx.deps);
    expect(every).toHaveBeenCalledWith('oauth-cleanup', 3_600_000, expect.any(Function));

    await registerTestClient(ctx);
    clock.advance(30 * DAY_MS);
    const job = every.mock.calls.find(([name]) => name === 'oauth-cleanup')?.[2];
    await job?.();
    expect(await clientRows()).toEqual([]);
  });
});
