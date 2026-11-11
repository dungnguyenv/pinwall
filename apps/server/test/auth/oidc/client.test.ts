import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  AuthorizationResponseError,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  ClientError,
  calculatePKCECodeChallenge,
  fetchUserInfo,
  ResponseBodyError,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  refreshTokenGrant,
} from 'openid-client';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildAuthParams,
  callbackUrl,
  classifyOidcError,
  OIDC_HTTP_TIMEOUT_SECONDS,
  oidcErrorCode,
  oidcRuntime,
} from '../../../src/auth/oidc/client.ts';
import { loadConfig } from '../../../src/config/load.ts';
import { createLogger } from '../../../src/lib/logger.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { idpBrowserAuthorize, startTestIdp, type TestIdp } from '../../helpers/oidc-idp.ts';

let idp: TestIdp;
let ctx: TestContext;

beforeAll(async () => {
  idp = await startTestIdp();
  ctx = await createTestContext({ env: idp.env() });
});
afterAll(async () => {
  await ctx?.close();
  await idp?.close();
});

const newSub = () => `user-${randomUUID()}`;

/** Runs the browser half of a sign-in as `sub`; returns the callback URL and the checks to use. */
async function signIn(c: TestContext, i: TestIdp, sub: string, selectAccount = false) {
  const config = await oidcRuntime(c.deps).configuration();
  const oidc = c.deps.config.oidc;
  if (!oidc) throw new Error('the test context has no OIDC configuration');
  const checks = {
    pkceCodeVerifier: randomPKCECodeVerifier(),
    expectedState: randomState(),
    expectedNonce: randomNonce(),
  };
  const params = buildAuthParams(oidc, {
    redirectUri: callbackUrl(c.deps.config),
    state: checks.expectedState,
    nonce: checks.expectedNonce,
    codeChallenge: await calculatePKCECodeChallenge(checks.pkceCodeVerifier),
    selectAccount,
  });
  i.signInAs(sub);
  const callback = await idpBrowserAuthorize(i, buildAuthorizationUrl(config, params).href);
  return { config, callback, checks };
}

async function tokensFor(c: TestContext, i: TestIdp, sub: string) {
  const { config, callback, checks } = await signIn(c, i, sub);
  return authorizationCodeGrant(config, callback, checks);
}

/** The rejection of `promise`, or a failure when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  return { lines, logger: createLogger('info', stream) };
}

test('discovers the issuer once and caches it', async () => {
  const rt = oidcRuntime(ctx.deps);
  const [a, b] = await Promise.all([rt.configuration(), rt.configuration()]);
  expect(a).toBe(b);
  expect(await rt.configuration()).toBe(a);
  expect(a.serverMetadata().issuer).toBe(idp.issuer);
  expect(a.timeout).toBe(OIDC_HTTP_TIMEOUT_SECONDS);
});

test('a failed discovery is retried on the next call', async () => {
  const fresh = await createTestContext({ env: idp.env() });
  try {
    const rt = oidcRuntime(fresh.deps);
    idp.setReachable(false);
    const error = await rejectionOf(rt.configuration());
    expect(classifyOidcError(error)).toBe('unavailable');
    idp.setReachable(true);
    const config = await rt.configuration();
    expect(config.serverMetadata().issuer).toBe(idp.issuer);
  } finally {
    idp.setReachable(true);
    await fresh.close();
  }
});

test('one runtime per AppDeps, with its own lease holder and re-check state', () => {
  const rt = oidcRuntime(ctx.deps);
  expect(oidcRuntime(ctx.deps)).toBe(rt);
  expect(rt.holder).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(oidcRuntime({ ...ctx.deps }).holder).not.toBe(rt.holder);
  expect(rt.inflight).toBeInstanceOf(Map);
  expect(rt.inlineBackoffUntil).toBeInstanceOf(Map);
  expect(rt.inlineRecheckTimeoutMs).toBe(5_000);
});

test('the runtime needs OIDC to be configured', () => {
  expect(() => oidcRuntime({ ...ctx.deps, config: { ...ctx.deps.config, oidc: null } })).toThrow(
    /OIDC/,
  );
});

test('an http: issuer is reached, with the warning left to loadConfig at start', async () => {
  const logs = captureLogs();
  const rt = oidcRuntime({ ...ctx.deps, logger: logs.logger });
  expect((await rt.configuration()).serverMetadata().issuer).toBe(idp.issuer);
  expect(logs.lines).toEqual([]);
  expect(ctx.deps.config.warnings).toEqual([
    expect.stringMatching(/^PINWALL_OIDC_ALLOW_HTTP_ISSUER is set .*forge any identity/),
  ]);
});

test('the callback URL is on the public origin', () => {
  const config = loadConfig({ ...idp.env(), PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test' });
  expect(callbackUrl(config)).toBe('https://pinwall.test/auth/oidc/callback');
});

test('authorization params carry PKCE S256, state, nonce and scopes that extra params cannot override', () => {
  const oidc = loadConfig({
    ...idp.env(),
    PINWALL_OIDC_SCOPES: 'openid email profile offline_access',
    PINWALL_OIDC_EXTRA_AUTH_PARAMS:
      'access_type=offline&state=evil&redirect_uri=https://evil.example&response_type=token' +
      '&scope=openid&nonce=evil&code_challenge=evil&code_challenge_method=plain',
  }).oidc;
  if (!oidc) throw new Error('expected an OIDC configuration');
  expect(
    buildAuthParams(oidc, {
      redirectUri: 'http://localhost:8080/auth/oidc/callback',
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
      selectAccount: false,
    }),
  ).toEqual({
    access_type: 'offline',
    response_type: 'code',
    redirect_uri: 'http://localhost:8080/auth/oidc/callback',
    scope: 'openid email profile offline_access',
    state: 's',
    nonce: 'n',
    code_challenge: 'c',
    code_challenge_method: 'S256',
  });
});

test('select_account adds consent when offline_access is requested', () => {
  const prompt = (env: Record<string, string>, selectAccount: boolean) => {
    const oidc = loadConfig({ ...idp.env(), ...env }).oidc;
    if (!oidc) throw new Error('expected an OIDC configuration');
    const params = buildAuthParams(oidc, {
      redirectUri: 'r',
      state: 's',
      nonce: 'n',
      codeChallenge: 'c',
      selectAccount,
    });
    return params.prompt === undefined ? 'absent' : new Set(params.prompt.split(' '));
  };
  expect(prompt({}, true)).toEqual(new Set(['select_account', 'consent']));
  expect(prompt({ PINWALL_OIDC_SCOPES: 'openid email' }, true)).toEqual(
    new Set(['select_account']),
  );
  expect(prompt({ PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'prompt=consent' }, false)).toEqual(
    new Set(['consent']),
  );
  expect(prompt({ PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'prompt=none' }, true)).toEqual(
    new Set(['select_account', 'consent']),
  );
  expect(prompt({ PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'prompt=none' }, false)).toBe('absent');
  expect(prompt({}, false)).toBe('absent');
});

test('the test IdP issues refresh tokens and reflects group changes', async () => {
  const sub = newSub();
  idp.addAccount({
    sub,
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada',
    groups: ['g1'],
  });
  const codeGrants = idp.tokenRequests('authorization_code');
  const tokens = await tokensFor(ctx, idp, sub);
  expect(idp.tokenRequests('authorization_code')).toBe(codeGrants + 1);
  expect(tokens.refresh_token).toBeDefined();
  expect(tokens.claims()?.sub).toBe(sub);

  const config = await oidcRuntime(ctx.deps).configuration();
  expect(await fetchUserInfo(config, tokens.access_token, sub)).toMatchObject({
    sub,
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada',
    groups: ['g1'],
  });

  idp.setGroups(sub, ['g2']);
  const refreshed = await refreshTokenGrant(config, tokens.refresh_token ?? '');
  expect((await fetchUserInfo(config, refreshed.access_token, sub)).groups).toEqual(['g2']);
});

test('authorization requests are recorded with the parameters Pinwall sent', async () => {
  const sub = newSub();
  idp.addAccount({ sub });
  const before = idp.authorizationRequests.length;
  await tokensFor(ctx, idp, sub);
  expect(idp.authorizationRequests).toHaveLength(before + 1);
  const sent = idp.authorizationRequests.at(-1);
  expect(sent?.get('redirect_uri')).toBe('http://localhost:8080/auth/oidc/callback');
  expect(sent?.get('code_challenge_method')).toBe('S256');
  expect(sent?.get('scope')).toBe('openid email profile offline_access groups');
});

test('a sign-in that asks to select an account completes, with a refresh token', async () => {
  const sub = newSub();
  idp.addAccount({ sub });
  const { config, callback, checks } = await signIn(ctx, idp, sub, true);
  expect(idp.authorizationRequests.at(-1)?.get('prompt')).toBe('select_account consent');
  const tokens = await authorizationCodeGrant(config, callback, checks);
  expect(tokens.claims()?.sub).toBe(sub);
  expect(tokens.refresh_token).toBeDefined();
});

test('rotated refresh tokens cannot be reused', async () => {
  const sub = newSub();
  idp.addAccount({ sub });
  const config = await oidcRuntime(ctx.deps).configuration();
  const first = (await tokensFor(ctx, idp, sub)).refresh_token ?? '';
  const second = await refreshTokenGrant(config, first);
  expect(second.refresh_token).toBeDefined();
  expect(second.refresh_token).not.toBe(first);
  expect(classifyOidcError(await rejectionOf(refreshTokenGrant(config, first)))).toBe(
    'invalid_grant',
  );
});

test('errors are classified for sign-in and re-check', async () => {
  const config = await oidcRuntime(ctx.deps).configuration();
  const refresh = async () => {
    const sub = newSub();
    idp.addAccount({ sub });
    const token = (await tokensFor(ctx, idp, sub)).refresh_token ?? '';
    return { sub, run: () => refreshTokenGrant(config, token) };
  };
  try {
    const disabled = await refresh();
    idp.disable(disabled.sub);
    expect(classifyOidcError(await rejectionOf(disabled.run()))).toBe('invalid_grant');

    const revoked = await refresh();
    await idp.revokeGrants(revoked.sub);
    expect(classifyOidcError(await rejectionOf(revoked.run()))).toBe('invalid_grant');

    const live = await refresh();
    const refreshes = idp.tokenRequests('refresh_token');
    idp.setReachable(false);
    expect(classifyOidcError(await rejectionOf(live.run()))).toBe('unavailable');
    expect(idp.tokenRequests('refresh_token')).toBe(refreshes + 1);
    idp.setReachable(true);

    idp.failTokenRequests({ status: 503, error: 'temporarily_unavailable' });
    expect(classifyOidcError(await rejectionOf(live.run()))).toBe('unavailable');
    idp.failTokenRequests({ status: 401, error: 'invalid_client' });
    expect(classifyOidcError(await rejectionOf(live.run()))).toBe('failed');
    idp.failTokenRequests(null);
    await expect(live.run()).resolves.toMatchObject({ token_type: expect.any(String) });

    const sub = newSub();
    idp.addAccount({ sub });
    idp.cancelNextSignIn();
    const cancelled = await signIn(ctx, idp, sub);
    expect(cancelled.callback.searchParams.get('error')).toBe('access_denied');
    const error = await rejectionOf(
      authorizationCodeGrant(config, cancelled.callback, cancelled.checks),
    );
    expect(classifyOidcError(error)).toBe('cancelled');
    expect(await tokensFor(ctx, idp, sub)).toMatchObject({ token_type: expect.any(String) });
  } finally {
    idp.setReachable(true);
    idp.failTokenRequests(null);
  }
});

test('a request slower than the timeout is unavailable', async () => {
  const fresh = await createTestContext({ env: idp.env() });
  try {
    const sub = newSub();
    idp.addAccount({ sub });
    const token = (await tokensFor(fresh, idp, sub)).refresh_token ?? '';
    const config = await oidcRuntime(fresh.deps).configuration();
    config.timeout = 0.05;
    idp.setLatency(300);
    expect(classifyOidcError(await rejectionOf(refreshTokenGrant(config, token)))).toBe(
      'unavailable',
    );
  } finally {
    idp.setLatency(0);
    await fresh.close();
  }
});

test('transport and protocol failures are classified without an IdP', () => {
  const bodyError = (status: number, error: string) =>
    new ResponseBodyError('error', { cause: { error }, response: new Response(null, { status }) });
  const redirectError = (error: string) =>
    new AuthorizationResponseError('error', { cause: new URLSearchParams({ error }) });

  expect(classifyOidcError(bodyError(400, 'invalid_grant'))).toBe('invalid_grant');
  expect(classifyOidcError(bodyError(502, 'bad_gateway'))).toBe('unavailable');
  expect(classifyOidcError(bodyError(400, 'invalid_request'))).toBe('failed');
  expect(classifyOidcError(redirectError('server_error'))).toBe('unavailable');
  expect(classifyOidcError(redirectError('temporarily_unavailable'))).toBe('unavailable');
  expect(classifyOidcError(redirectError('access_denied'))).toBe('cancelled');
  expect(classifyOidcError(redirectError('login_required'))).toBe('cancelled');
  expect(classifyOidcError(new TypeError('fetch failed'))).toBe('unavailable');
  expect(classifyOidcError(new DOMException('timed out', 'TimeoutError'))).toBe('unavailable');
  expect(classifyOidcError(new DOMException('aborted', 'AbortError'))).toBe('unavailable');
  expect(classifyOidcError(new Error('boom'))).toBe('failed');
  expect(classifyOidcError('boom')).toBe('failed');
});

test('error codes for logs are fixed constants, never text from the IdP', () => {
  const bodyError = (status: number, error: string) =>
    new ResponseBodyError('error', { cause: { error }, response: new Response(null, { status }) });
  const redirectError = (error: string) =>
    new AuthorizationResponseError('error', { cause: new URLSearchParams({ error }) });
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
    code: 'ECONNREFUSED',
  });

  expect(oidcErrorCode(bodyError(401, 'invalid_client'))).toBe('invalid_client');
  expect(oidcErrorCode(bodyError(400, 'not a <code> at all'))).toBe('OAUTH_RESPONSE_BODY_ERROR');
  expect(oidcErrorCode(redirectError('access_denied'))).toBe('access_denied');
  const nonConform = Object.assign(new ClientError('x'), { code: 'OAUTH_RESPONSE_IS_NOT_CONFORM' });
  expect(oidcErrorCode(nonConform)).toBe('OAUTH_RESPONSE_IS_NOT_CONFORM');
  expect(oidcErrorCode(new TypeError('fetch failed', { cause: refused }))).toBe('ECONNREFUSED');
  expect(oidcErrorCode(new TypeError('fetch failed'))).toBe('TypeError');
  expect(oidcErrorCode(new Error('rt-secret in the message'))).toBe('Error');
  expect(oidcErrorCode('boom')).toBe('unknown');
});

test('a Google-like IdP has no groups claim', async () => {
  const google = await startTestIdp({ groupsClaim: null });
  const c = await createTestContext({ env: google.env() });
  try {
    expect(google.env()).not.toHaveProperty('PINWALL_OIDC_ROLES_CLAIM');
    expect(google.env()).not.toHaveProperty('PINWALL_OIDC_SCOPES');
    const sub = newSub();
    google.addAccount({ sub, email: 'ann@example.com', email_verified: 'true', groups: ['g1'] });
    const tokens = await tokensFor(c, google, sub);
    const config = await oidcRuntime(c.deps).configuration();
    const info = await fetchUserInfo(config, tokens.access_token, sub);
    expect(info).toMatchObject({ sub, email: 'ann@example.com', email_verified: 'true' });
    expect(info).not.toHaveProperty('groups');
  } finally {
    await c.close();
    await google.close();
  }
});

test('an IdP without refresh tokens issues none', async () => {
  const plain = await startTestIdp({ refreshTokens: false });
  const c = await createTestContext({ env: plain.env() });
  try {
    const sub = newSub();
    plain.addAccount({ sub });
    const tokens = await tokensFor(c, plain, sub);
    expect(tokens.access_token).toBeDefined();
    expect(tokens.refresh_token).toBeUndefined();
  } finally {
    await c.close();
    await plain.close();
  }
});

test('the IdP can be slowed down and named claims released', async () => {
  const custom = await startTestIdp({ groupsClaim: 'https://example.com/groups' });
  const c = await createTestContext({ env: custom.env({ PINWALL_OIDC_DISPLAY_NAME: 'Custom' }) });
  try {
    expect(custom.env({ PINWALL_OIDC_DISPLAY_NAME: 'Custom' })).toMatchObject({
      PINWALL_OIDC_ROLES_CLAIM: 'https://example.com/groups',
      PINWALL_OIDC_DISPLAY_NAME: 'Custom',
    });
    const sub = newSub();
    custom.addAccount({ sub, groups: { admin: {} } });
    const tokens = await tokensFor(c, custom, sub);
    const config = await oidcRuntime(c.deps).configuration();
    custom.setLatency(150);
    const started = performance.now();
    const info = await fetchUserInfo(config, tokens.access_token, sub);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    expect(info['https://example.com/groups']).toEqual({ admin: {} });
  } finally {
    await c.close();
    await custom.close();
  }
});
