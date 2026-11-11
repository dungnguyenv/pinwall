import { OAuthConsentRequest, OAuthDecisionResult } from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { revokeAllCredentials } from '../../src/auth/revoke.ts';
import { sessionCookieName } from '../../src/auth/session-cookie.ts';
import { createSession } from '../../src/auth/sessions.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { hashSecret, newSecret } from '../../src/lib/ids.ts';
import { getClient } from '../../src/oauth/clients.ts';
import { revokeGrant } from '../../src/oauth/grants.ts';
import type { AuthorizationCode, AuthorizationRequest } from '../../src/oauth/requests.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import {
  approve,
  authorizePath,
  consentRequestId,
  pkcePair,
  registerTestClient,
} from '../helpers/oauth.ts';
import type { ErrorJson } from '../helpers/rest.ts';

const T = Date.UTC(2026, 10, 10);
const ISSUER = 'http://localhost:8080';
const MCP = 'http://localhost:8080/mcp';
const CONSENT = /^http:\/\/localhost:8080\/oauth\/consent\?request=[A-Za-z0-9_-]{43}$/;

type AuthorizeOptions = Partial<Parameters<typeof authorizePath>[0]>;

/** What the error page does to text it shows (hono/jsx escaping). */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function expectError(r: Response, status: number, code: string, message?: string) {
  expect(r.status).toBe(status);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const body = (await r.json()) as ErrorJson;
  expect(body.error.code).toBe(code);
  if (message !== undefined) expect(body.error.message).toBe(message);
}

/** An HTML error page that sends the browser nowhere; returns its HTML. */
async function expectPage(r: Response, status: number, message: string): Promise<string> {
  expect(r.status).toBe(status);
  expect(r.headers.get('content-type')).toContain('text/html');
  expect(r.headers.get('location')).toBeNull();
  expect(r.headers.get('cache-control')).toBe('no-store');
  const html = await r.text();
  expect(html).toContain(escapeHtml(t('oauth.authorize.title')));
  expect(html).toContain(escapeHtml(message));
  return html;
}

describe.each(dialects)('authorization on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let ada: { user: UserRow; cookie: string };
  let clientId: string;
  let redirectUri: string;
  afterEach(() => ctx?.close());

  async function start(env: Record<string, string> = {}): Promise<void> {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock, env });
    ada = await createSignedInUser(ctx, { name: 'Ada' });
    await setUser(ada.user.id, { email: 'ada@example.com' });
    ({ clientId, redirectUri } = await registerTestClient(ctx));
  }

  async function setUser(id: string, values: { name?: string | null; email?: string | null }) {
    await ctx.deps.db.db.updateTable('users').set(values).where('id', '=', id).execute();
  }

  const authorize = (o: AuthorizeOptions = {}, init?: RequestInit) =>
    ctx.request(
      authorizePath({ clientId, redirectUri, challenge: pkcePair().challenge, ...o }),
      init,
    );

  /** The id of a new pending request. */
  const pending = async (o: AuthorizeOptions = {}) => consentRequestId(await authorize(o));

  const describeRequest = (id: string, init?: RequestInit) =>
    ctx.request(`/api/v1/oauth/requests/${id}`, init ?? apiInit(ctx, { cookie: ada.cookie }));

  const decide = (id: string, approved: boolean, init?: RequestInit) =>
    ctx.request(
      `/api/v1/oauth/requests/${id}/decision`,
      init ?? apiInit(ctx, { cookie: ada.cookie, body: { approve: approved } }),
    );

  const grants = () =>
    ctx.deps.db.db.selectFrom('oauth_grants').selectAll().orderBy('created_at').execute();

  const storedCode = (code: string) =>
    ctx.deps.oneTime.peek<AuthorizationCode>(`oauth:code:${hashSecret(code)}`);

  test('a valid request goes to the consent page', async () => {
    await start();
    const { challenge } = pkcePair();
    clock.advance(1_000);
    const r = await ctx.request(
      authorizePath({ clientId, redirectUri, challenge, state: 'xyz', scope: 'pinwall' }),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(CONSENT);
    expect(r.headers.get('cache-control')).toBe('no-store');

    // The request waits under the hash of its id, never the id itself.
    const id = await consentRequestId(r);
    expect(await ctx.deps.oneTime.peek(`oauth:request:${id}`)).toBeNull();
    expect(
      await ctx.deps.oneTime.peek<AuthorizationRequest>(`oauth:request:${hashSecret(id)}`),
    ).toEqual({
      clientId,
      redirectUri,
      codeChallenge: challenge,
      state: 'xyz',
      resource: MCP,
      scope: 'pinwall',
      createdAt: clock.now(),
    });
    expect((await getClient(ctx.deps.db.db, clientId))?.last_used_at).toBe(clock.now());
  });

  test('the consent API describes the request with the shared DTO', async () => {
    await start();
    const id = await pending({ state: 'xyz', scope: 'pinwall' });
    const r = await describeRequest(id);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body).toEqual({
      client_name: 'Claude Code',
      client_uri: null,
      redirect_host: '127.0.0.1:33418',
      scopes: ['pinwall'],
      user: { name: 'Ada', email: 'ada@example.com' },
    });
    expect(OAuthConsentRequest.parse(body)).toEqual(body);
  });

  test('the person is named by their name, else their email', async () => {
    await start();
    const id = await pending();
    const userShown = async () =>
      ((await (await describeRequest(id)).json()) as OAuthConsentRequest).user;
    await setUser(ada.user.id, { name: null });
    expect(await userShown()).toEqual({
      name: 'ada@example.com',
      email: 'ada@example.com',
    });
    await setUser(ada.user.id, { email: null });
    expect(await userShown()).toEqual({
      name: t('oauth.consent.unnamedUser'),
      email: null,
    });
  });

  test('approving returns code, state and issuer to the client', async () => {
    await start();
    const { challenge } = pkcePair();
    const id = await consentRequestId(await authorize({ challenge, state: 'xyz' }));
    clock.advance(5_000);
    const r = await decide(id, true);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as OAuthDecisionResult;
    expect(OAuthDecisionResult.parse(body)).toEqual(body);

    const to = new URL(body.redirect_to);
    expect(to.origin + to.pathname).toBe('http://127.0.0.1:33418/callback');
    const code = to.searchParams.get('code') ?? '';
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(to.searchParams.get('state')).toBe('xyz');
    expect(to.searchParams.get('iss')).toBe(ISSUER);
    expect([...to.searchParams.keys()].sort()).toEqual(['code', 'iss', 'state']);

    const rows = await grants();
    expect(rows).toEqual([
      {
        id: expect.stringMatching(/^gnt_[0-9a-hjkmnp-tv-z]{20}$/),
        client_id: clientId,
        user_id: ada.user.id,
        resource: MCP,
        scope: 'pinwall',
        created_at: clock.now(),
        last_used_at: null,
        revoked_at: null,
      },
    ]);
    expect((await getClient(ctx.deps.db.db, clientId))?.last_used_at).toBe(clock.now());

    // The code waits for the token endpoint under its hash, for 60 seconds.
    expect(await ctx.deps.oneTime.peek(`oauth:code:${code}`)).toBeNull();
    expect(await storedCode(code)).toEqual({
      grantId: rows[0]?.id,
      clientId,
      userId: ada.user.id,
      redirectUri,
      codeChallenge: challenge,
      resource: MCP,
      scope: 'pinwall',
    });
    clock.advance(59_999);
    expect(await storedCode(code)).not.toBeNull();
    clock.advance(1);
    expect(await storedCode(code)).toBeNull();
  });

  test('denying returns access_denied', async () => {
    await start();
    const id = await pending({ state: 'xyz' });
    const r = await decide(id, false);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const to = new URL(((await r.json()) as OAuthDecisionResult).redirect_to);
    expect(to.origin + to.pathname).toBe(redirectUri);
    expect(to.search).toBe(`?error=access_denied&state=xyz&iss=${encodeURIComponent(ISSUER)}`);
    expect(await grants()).toEqual([]);
  });

  test('a request is decided once', async () => {
    await start();
    const id = await pending();
    expect((await decide(id, true)).status).toBe(200);
    for (const approved of [true, false]) {
      await expectError(await decide(id, approved), 404, 'not_found', t('oauth.request.expired'));
    }
    await expectError(await describeRequest(id), 404, 'not_found', t('oauth.request.expired'));
    expect(await grants()).toHaveLength(1);
  });

  test('an unknown request is not found', async () => {
    await start();
    const id = newSecret();
    await expectError(await describeRequest(id), 404, 'not_found', t('oauth.request.expired'));
    await expectError(await decide(id, true), 404, 'not_found', t('oauth.request.expired'));
  });

  test('requests expire after 10 minutes', async () => {
    await start();
    const id = await pending();
    clock.advance(599_999);
    expect((await describeRequest(id)).status).toBe(200);
    clock.advance(1);
    await expectError(await describeRequest(id), 404, 'not_found', t('oauth.request.expired'));
    await expectError(await decide(id, true), 404, 'not_found', t('oauth.request.expired'));
    expect(await grants()).toEqual([]);
  });

  test('a request outlives signing out and in as someone else', async () => {
    await start();
    const id = await pending({ state: 'xyz' });
    expect((await describeRequest(id)).status).toBe(200);

    // "Not you?" signs Ada out and comes back to the same consent page as Bob.
    const out = await ctx.request(
      '/api/v1/auth/sign-out',
      apiInit(ctx, { method: 'POST', cookie: ada.cookie }),
    );
    expect(out.status).toBe(204);
    await expectError(await describeRequest(id), 401, 'unauthorized');
    const bob = await createSignedInUser(ctx, { kind: 'oidc', name: 'Bob' });
    const described = await describeRequest(id, apiInit(ctx, { cookie: bob.cookie }));
    expect(((await described.json()) as OAuthConsentRequest).user).toEqual({
      name: 'Bob',
      email: bob.user.email,
    });

    const r = await decide(id, true, apiInit(ctx, { cookie: bob.cookie, body: { approve: true } }));
    expect(r.status).toBe(200);
    expect(await grants()).toMatchObject([{ client_id: clientId, user_id: bob.user.id }]);
  });

  test('a second approval reuses the grant', async () => {
    await start();
    const first = await approve(ctx, ada.cookie, { clientId, redirectUri });
    clock.advance(1_000);
    const second = await approve(ctx, ada.cookie, { clientId, redirectUri });
    expect(second.code).not.toBe(first.code);
    const [grant, ...others] = await grants();
    expect(others).toEqual([]);
    expect((await storedCode(first.code))?.grantId).toBe(grant?.id);
    expect((await storedCode(second.code))?.grantId).toBe(grant?.id);

    // Another client gets its own grant.
    const cursor = await registerTestClient(ctx, {
      name: 'Cursor',
      redirectUris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
    });
    clock.advance(1_000);
    await approve(ctx, ada.cookie, cursor);
    expect(await grants()).toHaveLength(2);

    // Once revoked, the grant is never reused.
    clock.advance(1_000);
    await revokeAllCredentials(ctx.deps, ada.user.id);
    const { secret } = await createSession(ctx.deps, ada.user.id, 'password', {
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    clock.advance(1_000);
    const third = await approve(ctx, `${sessionCookieName(ctx.deps.config)}=${secret}`, {
      clientId,
      redirectUri,
    });
    const rows = await grants();
    expect(rows).toHaveLength(3);
    const fresh = rows.find((row) => row.revoked_at === null);
    expect(fresh).toMatchObject({ client_id: clientId, user_id: ada.user.id, resource: MCP });
    expect(fresh?.id).not.toBe(grant?.id);
    expect((await storedCode(third.code))?.grantId).toBe(fresh?.id);
  });

  test('revoking a grant ends it and its tokens only', async () => {
    await start();
    await approve(ctx, ada.cookie, { clientId, redirectUri });
    const cursor = await registerTestClient(ctx, { name: 'Cursor' });
    clock.advance(1_000);
    await approve(ctx, ada.cookie, cursor);
    const [grant, kept] = await grants();
    if (!grant || !kept) throw new Error('expected two grants');
    const { db } = ctx.deps.db;
    for (const [i, row] of [grant, grant, kept].entries()) {
      await db
        .insertInto('oauth_tokens')
        .values({
          token_hash: hashSecret(`token-${i}`),
          grant_id: row.id,
          kind: i === 1 ? 'refresh' : 'access',
          created_at: clock.now(),
          expires_at: clock.now() + 3_600_000,
          used_at: null,
        })
        .execute();
    }

    clock.advance(1_000);
    const revokedAt = clock.now();
    await revokeGrant(ctx.deps, grant.id);
    clock.advance(1_000);
    await revokeGrant(ctx.deps, grant.id);
    expect(await grants()).toMatchObject([
      { id: grant.id, revoked_at: revokedAt },
      { id: kept.id, revoked_at: null },
    ]);
    const tokens = await db.selectFrom('oauth_tokens').select('grant_id').execute();
    expect(tokens).toEqual([{ grant_id: kept.id }]);

    const { code } = await approve(ctx, ada.cookie, { clientId, redirectUri });
    expect((await storedCode(code))?.grantId).not.toBe(grant.id);
  });

  test('a loopback redirect may use another port', async () => {
    await start();
    const other = 'http://127.0.0.1:50999/callback';
    expect((await authorize({ redirectUri: other })).headers.get('location')).toMatch(CONSENT);
    const { code, redirectTo } = await approve(ctx, ada.cookie, { clientId, redirectUri: other });
    expect(redirectTo.origin).toBe('http://127.0.0.1:50999');
    expect(redirectTo.pathname).toBe('/callback');
    // The token request must name the port the browser went back to.
    expect((await storedCode(code))?.redirectUri).toBe(other);
  });

  test('an unknown client gets an HTML page, never a redirect', async () => {
    await start();
    const { challenge } = pkcePair();
    const unknown = authorizePath({ clientId: 'cli_unknown', redirectUri, challenge });
    await expectPage(
      await ctx.request(unknown, { headers: { accept: '*/*' } }),
      400,
      t('oauth.authorize.unknownClient'),
    );
    const url = new URL(authorizePath({ clientId, redirectUri, challenge }), ISSUER);
    url.searchParams.delete('client_id');
    await expectPage(
      await ctx.request(url.pathname + url.search, { headers: { accept: 'application/json' } }),
      400,
      t('oauth.authorize.unknownClient'),
    );
  });

  test('an unregistered redirect uri gets an HTML page, never a redirect', async () => {
    await start();
    const { challenge } = pkcePair();
    for (const uri of [
      'http://evil.example/cb',
      'http://127.0.0.1:33418/other',
      'https://evil.example/cb?a=1&b="><script>',
      null,
    ]) {
      const url = new URL(
        authorizePath({ clientId, redirectUri: uri ?? '', challenge, state: 'xyz' }),
        ISSUER,
      );
      if (uri === null) url.searchParams.delete('redirect_uri');
      const r = await ctx.request(url.pathname + url.search, { headers: { accept: '*/*' } });
      await expectPage(r, 400, t('oauth.authorize.badRedirect', { uri: uri ?? '(none)' }));
    }
  });

  // RFC 9700 §4.11.2: anyone may register a client, so its redirect URI is trusted only once the
  // signed-in person has seen it on the consent page. Until then nothing is sent there.
  test.each([
    ['response_type=token', { responseType: 'token' }, t('oauth.authorize.responseType')],
    ['no code_challenge', { challenge: '' }, t('oauth.authorize.pkce')],
    ['a 129-character code_challenge', { challenge: 'a'.repeat(129) }, t('oauth.authorize.pkce')],
    ['code_challenge_method=plain', { method: 'plain' }, t('oauth.authorize.pkce')],
    [
      'another resource',
      { resource: 'https://other.example/mcp' },
      t('oauth.authorize.resource', { resource: MCP }),
    ],
    ['a 1025-character state', { state: 's'.repeat(1025) }, t('oauth.authorize.state')],
    [
      'response_type=token and a 1025-character state',
      { responseType: 'token', state: 's'.repeat(1025) },
      t('oauth.authorize.responseType'),
    ],
  ] as [string, AuthorizeOptions, string][])(
    'protocol errors before consent are a page, never a redirect: %s',
    async (_label, o, message) => {
      await start();
      const r = await authorize(
        { state: 'xyz', ...o },
        { headers: { accept: 'application/json' } },
      );
      await expectPage(r, 400, message);
    },
  );

  test('more than one resource is invalid_target, shown as a page', async () => {
    await start();
    const path = authorizePath({ clientId, redirectUri, challenge: pkcePair().challenge });
    const r = await ctx.request(
      `${path}&resource=${encodeURIComponent(MCP)}&resource=${encodeURIComponent(MCP)}`,
    );
    await expectPage(r, 400, t('oauth.authorize.resource', { resource: MCP }));
  });

  test.each([
    ['https://evil.example/login', 'evil.example'],
    ['cursor://anysphere.cursor-mcp/oauth/callback', 'cursor://anysphere.cursor-mcp'],
    ['http://127.0.0.1:50123/callback', '127.0.0.1:50123'],
  ])('a self-registered %s gets no redirect before consent, only after it', async (uri, host) => {
    await start();
    const self = await registerTestClient(ctx, { name: 'Anything', redirectUris: [uri] });

    // A request naming only the client and its redirect URI (no response_type, no PKCE).
    const bare = new URLSearchParams({ client_id: self.clientId, redirect_uri: uri, state: 'xyz' });
    const html = await expectPage(
      await ctx.request(`/oauth/authorize?${bare}`),
      400,
      t('oauth.authorize.responseType'),
    );
    // The page repeats nothing the request carried.
    expect(html).not.toContain(new URL(uri).host);
    expect(html).not.toContain('xyz');

    // A valid request reaches the consent page, which names where the answer goes; once the
    // person has seen that, their decision is sent there, a refusal included.
    const id = await pending({ ...self, state: 'xyz' });
    const shown = (await (await describeRequest(id)).json()) as OAuthConsentRequest;
    expect(shown.redirect_host).toBe(host);
    const to = new URL(
      ((await (await decide(id, false)).json()) as OAuthDecisionResult).redirect_to,
    );
    expect(to.href.startsWith(`${uri}?`)).toBe(true);
    expect(Object.fromEntries(to.searchParams)).toEqual({
      error: 'access_denied',
      state: 'xyz',
      iss: ISSUER,
    });
  });

  test('resource defaults to the MCP endpoint and tolerates its spellings', async () => {
    await start();
    for (const resource of [undefined, 'http://localhost:8080/mcp/', 'http://LOCALHOST:8080/mcp']) {
      const { code } = await approve(ctx, ada.cookie, {
        clientId,
        redirectUri,
        ...(resource === undefined ? {} : { resource }),
      });
      expect((await storedCode(code))?.resource, resource).toBe(MCP);
    }
    expect(await grants()).toMatchObject([{ resource: MCP }]);
    expect(await grants()).toHaveLength(1);
  });

  test('unknown scopes are ignored and pinwall is granted', async () => {
    await start();
    const id = await pending({ scope: 'openid offline_access' });
    const body = (await (await describeRequest(id)).json()) as OAuthConsentRequest;
    expect(body.scopes).toEqual(['pinwall']);
  });

  test('the consent API needs a browser session', async () => {
    await start();
    const id = await pending();
    const bearer = await createUserToken(ctx, ada.user.id);
    const sessionRequired = t('auth.sessionRequired');
    await expectError(
      await describeRequest(id, apiInit(ctx, { bearer })),
      403,
      'forbidden',
      sessionRequired,
    );
    await expectError(
      await decide(id, true, apiInit(ctx, { bearer, body: { approve: true } })),
      403,
      'forbidden',
      sessionRequired,
    );
    await expectError(await describeRequest(id, apiInit(ctx)), 401, 'unauthorized');
    await expectError(
      await decide(id, true, apiInit(ctx, { body: { approve: true } })),
      401,
      'unauthorized',
    );
    const crossOrigin = apiInit(ctx, {
      cookie: ada.cookie,
      body: { approve: true },
      origin: 'https://evil.example',
    });
    await expectError(await decide(id, true, crossOrigin), 403, 'forbidden');
    // None of these used the request up.
    expect((await describeRequest(id)).status).toBe(200);
    expect(await grants()).toEqual([]);
  });

  test('the consent hand-off and iss use the public origin', async () => {
    await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test', PINWALL_TRUST_PROXY: 'true' });
    const path = authorizePath({ clientId, redirectUri, challenge: pkcePair().challenge });
    const r = await ctx.request(`http://internal:8080${path}`, {
      headers: {
        host: 'internal:8080',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
      },
    });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(
      /^https:\/\/pinwall\.test\/oauth\/consent\?request=[A-Za-z0-9_-]{43}$/,
    );
    const d = await decide(await consentRequestId(r), true);
    const to = new URL(((await d.json()) as OAuthDecisionResult).redirect_to);
    expect(to.searchParams.get('iss')).toBe('https://pinwall.test');
    expect((await storedCode(to.searchParams.get('code') ?? ''))?.resource).toBe(
      'https://pinwall.test/mcp',
    );
  });

  test('authorize is rate limited per IP', async () => {
    await start();
    for (let i = 0; i < 60; i += 1) expect((await authorize()).status).toBe(302);
    const r = await authorize({}, { headers: { accept: 'application/json' } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    await expectPage(r, 429, `Retry in ${r.headers.get('retry-after')} seconds`);
  });
});
