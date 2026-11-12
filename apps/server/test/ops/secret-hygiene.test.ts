import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ContentGrant,
  CreatedApiToken,
  CreatedShareLink,
  GuestCreated,
  OAuthDecisionResult,
  PublishResult,
  PublishSession,
  ShareInfo,
} from '@pinwall/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { runAccessRecheck } from '../../src/auth/oidc/job.ts';
import { openRefreshToken } from '../../src/auth/oidc/users.ts';
import { startAuth } from '../../src/auth/startup.ts';
import { createGrant } from '../../src/content/grants.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { newContentToken, newSecret } from '../../src/lib/ids.ts';
import { runBackupCommand, runRestoreCommand } from '../../src/ops/backup/cli.ts';
import { enableProcessMetrics } from '../../src/ops/metrics.ts';
import { startMetricsServer } from '../../src/ops/metrics-server.ts';
import { createPublishSession } from '../../src/publish/sessions.ts';
import { startPublishing } from '../../src/publish/startup.ts';
import {
  apiInit,
  createSignedInUser,
  createUserToken,
  sessionCookieFrom,
} from '../helpers/auth.ts';
import { CONTENT_ENV, fetchContent } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { createPostgresDatabase, dialects, runAsAdmin } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import {
  authorizePath,
  consentRequestId,
  pkcePair,
  registerTestClient,
  tokenRequest,
} from '../helpers/oauth.ts';
import { authorizeAtIdp } from '../helpers/oidc-browser.ts';
import { startTestIdp, type TestIdp } from '../helpers/oidc-idp.ts';
import { publishFiles } from '../helpers/publish.ts';
import { sampleAnchor } from '../helpers/review.ts';

const T = Date.UTC(2026, 10, 12);
const ORIGIN = 'http://localhost:8080';
const MCP_RESOURCE = `${ORIGIN}/mcp`;
/** `PINWALL_UPLOAD_SESSION_TTL` by default. */
const UPLOAD_SESSION_TTL_MS = 600_000;
/** `PINWALL_ACCESS_RECHECK_INTERVAL` by default. */
const RECHECK_INTERVAL_MS = 43_200_000;
/** One test walks every flow (well over a hundred requests, a few password hashes). */
const FLOW_TIMEOUT_MS = 120_000;

/** A recognizable random value: what an operator or a person would have chosen. */
const random = (prefix: string) => `${prefix}-${randomBytes(12).toString('hex')}`;

/** The value of a `name=value` cookie pair. */
function cookieValue(pair: string | null | undefined): string | null {
  if (!pair) return null;
  return pair.slice(pair.indexOf('=') + 1);
}

/** The `name=value` pair of the first cookie `res` sets. */
const firstSetCookie = (res: Response) => res.headers.getSetCookie()[0]?.split(';')[0] ?? null;

/** The token of a single-domain content URL: `/c/<token>/…`. */
function grantToken(url: string | null | undefined): string | null {
  if (!url) return null;
  const [, c, token] = new URL(url).pathname.split('/');
  return c === 'c' ? (token ?? null) : null;
}

/**
 * A new Postgres database owned by a new login role whose password is `password`, so the
 * server connects with a `PINWALL_DATABASE_URL` that holds it. `drop` removes both.
 */
async function postgresWithPassword(
  password: string,
): Promise<{ url: string; drop(): Promise<void> }> {
  const database = await createPostgresDatabase();
  const url = new URL(database.url);
  const role = `pinwall_hygiene_${randomBytes(6).toString('hex')}`;
  const drop = async () => {
    await database.drop();
    await runAsAdmin(`drop role if exists ${role}`);
  };
  try {
    await runAsAdmin(`create role ${role} login password '${password}'`);
    await runAsAdmin(`alter database ${url.pathname.slice(1)} owner to ${role}`);
  } catch (error) {
    await drop();
    throw error;
  }
  url.username = role;
  url.password = password;
  return { url: url.href, drop };
}

/**
 * An S3 endpoint that refuses every request the way AWS answers a key it does not accept: a HEAD
 * gets a bare 403; anything else a `SignatureDoesNotMatch` error document that names the access
 * key id and the signature from the request's `Authorization` header, as AWS's does.
 */
async function startRefusingS3(): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'HEAD') {
        res.writeHead(403).end();
        return;
      }
      const authorization = req.headers.authorization ?? '';
      const keyId = /Credential=([^/]+)\//.exec(authorization)?.[1] ?? '';
      const signature = /Signature=([0-9a-f]+)/.exec(authorization)?.[1] ?? '';
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>SignatureDoesNotMatch</Code>' +
          '<Message>The request signature we calculated does not match the signature you provided.</Message>' +
          `<AWSAccessKeyId>${keyId}</AWSAccessKeyId><SignatureProvided>${signature}</SignatureProvided>` +
          '<RequestId>0123456789ABCDEF</RequestId><HostId>stub</HostId></Error>',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** `<what>: <line>` for every line that holds one of `secrets` (value → what it is). */
function leaksIn(lines: string[], secrets: Map<string, string>): string[] {
  return [...secrets].flatMap(([value, what]) =>
    lines.filter((line) => line.includes(value)).map((line) => `${what}: ${line}`),
  );
}

/** What each of `secrets` is, for those `page` holds. */
const onPage = (page: string, secrets: Map<string, string>) =>
  [...secrets].filter(([value]) => page.includes(value)).map(([, what]) => what);

/** Lines that write out a credential header's value. */
const credentialHeaders = (lines: string[]) =>
  lines.filter((line) => /"(authorization|cookie|set-cookie)":"(?!\[redacted\])/i.test(line));

let idp: TestIdp;
const oidcClientSecret = random('oidc-secret');
beforeAll(async () => {
  idp = await startTestIdp({ clientSecret: oidcClientSecret });
});
afterAll(() => idp?.close());

describe.each(dialects)('secret hygiene on %s', (dialect) => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    idp.failTokenRequests(null);
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  test(
    'no secret reaches a log line or the metrics page',
    async () => {
      // Every secret the flows below hand out or take in, with what it is (as first seen).
      const secrets = new Map<string, string>();
      const keep = (what: string, value: string | null | undefined): string => {
        if (!value) throw new Error(`the flow handed out no ${what}`);
        if (!secrets.has(value)) secrets.set(value, what);
        return value;
      };
      /** A secret key, in hex as configured, and as base64 or a Buffer would reach a line. */
      const keepKey = (what: string, key: Buffer): string => {
        keep(`${what} (base64)`, key.toString('base64'));
        // A logged Buffer is written as `{"type":"Buffer","data":[…]}`.
        keep(`${what} (Buffer)`, JSON.stringify([...key]));
        return keep(what, key.toString('hex'));
      };

      const secretKey = keepKey('PINWALL_SECRET_KEY', randomBytes(32));
      keep('PINWALL_OIDC_CLIENT_SECRET', oidcClientSecret);
      const env: Record<string, string> = { ...idp.env(), PINWALL_SECRET_KEY: secretKey };
      if (dialect === 'postgres') {
        const database = await postgresWithPassword(keep('database password', random('db-pass')));
        cleanups.push(database.drop);
        env.PINWALL_DATABASE_URL = database.url;
        env.PINWALL_DATABASE_POOL_SIZE = '4';
      }

      const lines: string[] = [];
      const clock = new FixedClock(T);
      const ctx: TestContext = await createTestContext({
        dialect,
        clock,
        env,
        log: (line) => lines.push(line),
      });
      cleanups.push(() => ctx.close());

      // Pinwall's side of the IdP conversation, as the IdP's token endpoint sees it.
      const issuerOrigin = new URL(idp.issuer).origin;
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const res = await realFetch(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== issuerOrigin || url.pathname !== '/token') return res;
        const basic = new Headers(init?.headers).get('authorization')?.replace(/^Basic /, '');
        keep('OIDC client credentials (Basic)', basic);
        const form = new URLSearchParams(String(init?.body ?? ''));
        const sent = { code: 'OIDC code', code_verifier: 'OIDC PKCE verifier' };
        for (const [name, what] of Object.entries(sent)) {
          const value = form.get(name);
          if (value) keep(what, value);
        }
        if (res.ok) {
          const issued = (await res.clone().json()) as Record<string, string | undefined>;
          keep('IdP access token', issued.access_token);
          keep('IdP ID token', issued.id_token);
          keep('IdP refresh token', issued.refresh_token);
        }
        return res;
      });

      // `pinwall serve` once it listens: the setup link, OIDC discovery, the scheduled jobs.
      const setupUrl = await startAuth(ctx.deps);
      await startPublishing(ctx.deps);
      const setupToken = keep('setup token', new URL(setupUrl ?? ORIGIN).searchParams.get('token'));

      // 1. Setup, then a password sign-in after a wrong attempt.
      const check = await ctx.request(
        '/api/v1/auth/setup/check',
        apiInit(ctx, { body: { token: setupToken } }),
      );
      expect(check.status).toBe(204);
      const ownerPassword = keep('owner password', random('owner-pass'));
      const setup = await ctx.request(
        '/api/v1/auth/setup',
        apiInit(ctx, { body: { token: setupToken, name: 'Ada', password: ownerPassword } }),
      );
      expect(setup.status).toBe(201);
      keep('session cookie (setup)', cookieValue(sessionCookieFrom(setup)));
      const again = await ctx.request(
        '/api/v1/auth/setup',
        apiInit(ctx, { body: { token: setupToken, name: 'Eve', password: ownerPassword } }),
      );
      expect(again.status).toBe(409);

      const signIn = (password: string) =>
        ctx.request('/api/v1/auth/password/sign-in', apiInit(ctx, { body: { password } }));
      expect((await signIn(keep('wrong password', random('wrong-pass')))).status).toBe(401);
      const signedIn = await signIn(ownerPassword);
      expect(signedIn.status).toBe(200);
      const ownerCookie = sessionCookieFrom(signedIn) ?? '';
      keep('session cookie (sign-in)', cookieValue(ownerCookie));
      const asOwner = (o: Parameters<typeof apiInit>[1] = {}) =>
        apiInit(ctx, { cookie: ownerCookie, ...o });

      // 2. An API token, used; a bogus one refused.
      const made = await ctx.request('/api/v1/me/tokens', asOwner({ body: { name: 'deploy' } }));
      expect(made.status).toBe(201);
      const apiToken = keep('API token', CreatedApiToken.parse(await made.json()).secret);
      expect((await ctx.request('/api/v1/me', apiInit(ctx, { bearer: apiToken }))).status).toBe(
        200,
      );
      const bogus = keep('bogus bearer', `pw_${newSecret()}`);
      expect((await ctx.request('/api/v1/me', apiInit(ctx, { bearer: bogus }))).status).toBe(401);

      // 3. An upload URL: used, then retried.
      const session = await ctx.request(
        '/api/v1/publish-sessions',
        apiInit(ctx, { bearer: apiToken, body: { target: {} } }),
      );
      expect(session.status).toBe(201);
      const uploadUrl = PublishSession.parse(await session.json()).upload_url;
      keep('upload token', new URL(uploadUrl).pathname.split('/').pop());
      const page = () => ({
        method: 'POST',
        headers: { 'content-type': 'text/html' },
        body: '<!doctype html><title>Plan</title><h1>Plan</h1>',
      });
      const uploaded = await ctx.request(uploadUrl, page());
      expect(uploaded.status).toBe(201);
      const { artifact_id: artifactId } = PublishResult.parse(await uploaded.json());
      expect((await ctx.request(uploadUrl, page())).status).toBe(409);

      // 4. Content grants: the review frame's and a raw link's, fetched.
      const preview = await ctx.request(
        `/api/v1/artifacts/${artifactId}/versions/1/preview`,
        asOwner(),
      );
      expect(preview.status).toBe(200);
      const reviewUrl = ContentGrant.parse(await preview.json()).url;
      keep('content grant token (review)', grantToken(reviewUrl));
      expect((await ctx.request(reviewUrl)).status).toBe(200);
      expect((await ctx.request(`${reviewUrl}missing.html`)).status).toBe(404);
      const raw = await ctx.request(`/a/${artifactId}/raw`, asOwner());
      expect(raw.status).toBe(302);
      const rawUrl = raw.headers.get('location') ?? '';
      keep('content grant token (raw)', grantToken(rawUrl));
      expect((await ctx.request(rawUrl)).status).toBe(200);

      // 5. A share link with a password: opened, a wrong password, unlocked, a guest comment.
      const sharePassword = keep('share password', random('share-pass'));
      const shared = await ctx.request(
        `/api/v1/artifacts/${artifactId}/share-links`,
        asOwner({ body: { password: sharePassword, allow_comments: true } }),
      );
      expect(shared.status).toBe(201);
      const shareToken = keep('share token', CreatedShareLink.parse(await shared.json()).token);
      // Locked, the link opens the viewer's password page: the SPA's, not built for tests.
      expect((await ctx.request(`/s/${shareToken}`)).status).toBeLessThan(500);
      const shareApi = `/api/v1/share/${shareToken}`;
      expect((await ctx.request(shareApi)).status).toBe(401);
      const unlock = (password: string) =>
        ctx.request(`${shareApi}/unlock`, apiInit(ctx, { body: { password } }));
      expect((await unlock(keep('wrong share password', random('wrong-share')))).status).toBe(401);
      const unlocked = await unlock(sharePassword);
      expect(unlocked.status).toBe(204);
      const unlockCookie = firstSetCookie(unlocked) ?? '';
      // `v1.<expiry>.<mac>`: the MAC is what nobody may learn.
      keep('unlock cookie MAC', cookieValue(unlockCookie)?.split('.').pop());
      const info = await ctx.request(shareApi, apiInit(ctx, { cookie: unlockCookie }));
      expect(info.status).toBe(200);
      keep(
        'content grant token (share)',
        grantToken(ShareInfo.parse(await info.json()).content.url),
      );
      const original = await ctx.request(`/s/${shareToken}/original`, {
        headers: { cookie: unlockCookie },
      });
      expect(original.status).toBe(302);
      keep('content grant token (share original)', grantToken(original.headers.get('location')));
      const commented = await ctx.request(
        `${shareApi}/comments`,
        apiInit(ctx, {
          cookie: unlockCookie,
          body: { guest_name: 'Lan', body: 'Đẹp quá', anchor: sampleAnchor({ page: '' }) },
        }),
      );
      expect(commented.status).toBe(201);
      const guest = GuestCreated.parse(await commented.json());
      const guestToken = keep('guest token', guest.guest_token);
      const edited = await ctx.request(
        `${shareApi}/comments/${guest.comment_id}`,
        apiInit(ctx, {
          method: 'PATCH',
          cookie: unlockCookie,
          body: { body: 'Rất đẹp' },
          headers: { 'x-pinwall-guest-token': guestToken },
        }),
      );
      expect(edited.status).toBe(200);

      // 6. An MCP client signs in with PKCE, calls a tool, refreshes; its code is replayed.
      const { clientId, redirectUri } = await registerTestClient(ctx);
      const pkce = pkcePair();
      keep('OAuth PKCE verifier', pkce.verifier);
      keep('OAuth PKCE challenge', pkce.challenge);
      const requestId = keep(
        'consent request id',
        await consentRequestId(
          await ctx.request(
            authorizePath({
              clientId,
              redirectUri,
              challenge: pkce.challenge,
              state: keep('OAuth state', random('oauth-state')),
              resource: MCP_RESOURCE,
              scope: 'pinwall',
            }),
          ),
        ),
      );
      expect((await ctx.request(`/api/v1/oauth/requests/${requestId}`, asOwner())).status).toBe(
        200,
      );
      const decided = await ctx.request(
        `/api/v1/oauth/requests/${requestId}/decision`,
        asOwner({ body: { approve: true } }),
      );
      expect(decided.status).toBe(200);
      const { redirect_to } = OAuthDecisionResult.parse(await decided.json());
      const code = keep('OAuth code', new URL(redirect_to).searchParams.get('code'));
      const exchange = {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
        client_id: clientId,
        resource: MCP_RESOURCE,
      };
      const tokens = async (res: Response) => {
        expect(res.status).toBe(200);
        const body = (await res.json()) as { access_token: string; refresh_token: string };
        keep('OAuth access token', body.access_token);
        keep('OAuth refresh token', body.refresh_token);
        return body;
      };
      const first = await tokens(await tokenRequest(ctx, exchange));
      const agent = await connectMcp(ctx, { bearer: first.access_token });
      const whoami = (await agent.callTool({ name: 'whoami', arguments: {} })) as CallToolResult;
      expect(whoami.isError, toolText(whoami)).toBeFalsy();
      await agent.close();
      const refresh = { grant_type: 'refresh_token', client_id: clientId };
      const second = await tokens(
        await tokenRequest(ctx, { ...refresh, refresh_token: first.refresh_token }),
      );
      expect((await tokenRequest(ctx, exchange)).status).toBe(400);
      // A misconfigured agent sends a client secret it was never given.
      const stray = { client_secret: keep('stray client secret', random('client-secret')) };
      const refused = await tokenRequest(ctx, {
        ...refresh,
        refresh_token: second.refresh_token,
        ...stray,
      });
      expect(refused.status).toBe(400);

      // 7. MCP with the API token; a bogus bearer refused.
      const tooling = await connectMcp(ctx, { bearer: apiToken });
      const viaToken = (await tooling.callTool({
        name: 'whoami',
        arguments: {},
      })) as CallToolResult;
      expect(viaToken.isError, toolText(viaToken)).toBeFalsy();
      await tooling.close();
      const unknown = await ctx.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bogus}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{}',
      });
      expect(unknown.status).toBe(401);

      // 8. An IdP user signs in; the callback is replayed.
      const sub = random('sub');
      idp.addAccount({ sub, name: 'Bình', email: 'binh@example.com', email_verified: true });
      const callback = await authorizeAtIdp(ctx, idp, { as: sub });
      const askedIdp = idp.authorizationRequests.at(-1);
      keep('OIDC state', askedIdp?.get('state'));
      keep('OIDC nonce', askedIdp?.get('nonce'));
      keep('OIDC PKCE challenge', askedIdp?.get('code_challenge'));
      keep('OIDC code', new URL(callback.url).searchParams.get('code'));
      const browserCookies = new Headers(callback.init.headers).get('cookie');
      keep('OIDC binding cookie', cookieValue(browserCookies));
      const oidcSignIn = await ctx.request(callback.url, callback.init);
      expect(oidcSignIn.status).toBe(302);
      const oidcCookie = sessionCookieFrom(oidcSignIn) ?? '';
      keep('session cookie (OIDC)', cookieValue(oidcCookie));
      expect((await ctx.request(callback.url, callback.init)).status).toBeGreaterThanOrEqual(400);
      const sealed = await ctx.deps.db.db
        .selectFrom('users')
        .select('idp_refresh_token')
        .where('oidc_subject', '=', sub)
        .executeTakeFirstOrThrow();
      // What the server keeps is what the IdP issued: the capture above saw the real thing.
      const stored = openRefreshToken(ctx.deps, sealed.idp_refresh_token ?? '');
      expect(secrets.get(stored ?? '')).toBe('IdP refresh token');

      // 9. An upload URL used after it expired.
      const owner = await ctx.deps.db.db
        .selectFrom('users')
        .selectAll()
        .where('kind', '=', 'owner')
        .executeTakeFirstOrThrow();
      const late = await createPublishSession(ctx.deps, owner, {
        target: { kind: 'new_artifact', projectId: null, name: null, tags: [] },
        message: null,
        source: 'api',
      });
      keep('upload token (expired)', new URL(late.upload_url).pathname.split('/').pop());
      clock.advance(UPLOAD_SESSION_TTL_MS + 1);
      expect((await ctx.request(late.upload_url, page())).status).toBe(410);

      // 10. The IdP is asked again, inline: its refresh token is rotated.
      clock.advance(RECHECK_INTERVAL_MS);
      const me = () => ctx.request('/api/v1/me', apiInit(ctx, { cookie: oidcCookie }));
      const refreshes = idp.tokenRequests('refresh_token');
      expect((await me()).status).toBe(200);
      expect(idp.tokenRequests('refresh_token')).toBe(refreshes + 1);

      // 11. A backup of all of it, restored into a new installation with another key: the
      // operator reads the restore's warnings on stderr too.
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dir = await mkdtemp(join(tmpdir(), 'pinwall-hygiene-'));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const archive = join(dir, 'backup.tar');
      await runBackupCommand(ctx.deps.config, ctx.deps.logger, archive);
      const otherKey = keepKey('another PINWALL_SECRET_KEY', randomBytes(32));
      const target = await createTestContext({ dialect, env: { PINWALL_SECRET_KEY: otherKey } });
      cleanups.push(() => target.close());
      await runRestoreCommand(target.deps.config, ctx.deps.logger, archive);
      const printed = stderr.mock.calls.map((args) => args.map(String).join(' '));
      expect(printed).toEqual([expect.stringContaining('single sign-on users must sign in again')]);
      lines.push(...printed);

      // 12. The job asks the IdP next, which refuses the refresh token.
      idp.failTokenRequests({ status: 400, error: 'invalid_grant' });
      clock.advance(RECHECK_INTERVAL_MS);
      expect(await runAccessRecheck(ctx.deps)).toMatchObject({ signInRequired: 1 });
      expect((await me()).status).toBe(401);

      // 13. Probes, logged at debug level; the metrics page as a scraper reads it.
      expect((await ctx.request('/healthz')).status).toBe(200);
      expect((await ctx.request('/readyz')).status).toBe(200);
      enableProcessMetrics(ctx.deps.metrics);
      const metricsServer = await startMetricsServer(ctx.deps, { port: 0 });
      cleanups.push(async () => metricsServer?.close());
      const scraped = await fetch(`http://127.0.0.1:${metricsServer?.port}/metrics`);
      expect(scraped.status).toBe(200);
      const metricsPage = await scraped.text();

      // No secret is in a line, except the setup link in its one line, by design...
      expect(lines.filter((line) => line.includes(setupToken))).toEqual([
        expect.stringContaining('"setup_url"'),
      ]);
      const others = new Map([...secrets].filter(([value]) => value !== setupToken));
      expect(leaksIn(lines, others)).toEqual([]);
      // ...nor on the metrics page, nor any credential header written out...
      expect(onPage(metricsPage, secrets)).toEqual([]);
      expect(credentialHeaders(lines)).toEqual([]);

      // ...while the capture saw every flow, its risky lines and its debug lines included.
      const log = lines.join('');
      for (const message of [
        'oauth client registered',
        'oauth grant approved',
        'oauth tokens issued',
        'oauth tokens refreshed',
        'oauth code replayed; grant revoked',
        'oidc sign-in',
        'oidc sign-in failed',
        'idp re-check: sign-in required',
        'access re-check',
        'backup complete',
        'restore complete',
      ]) {
        expect(log, message).toContain(`"msg":"${message}"`);
      }
      for (const path of [
        '/upload/:token',
        '/c/:token/',
        '/s/:token/original',
        '/api/v1/share/:token/unlock',
        '/api/v1/oauth/requests/:token/decision',
        '/auth/oidc/callback',
      ]) {
        expect(log, path).toContain(`"path":"${path}`);
      }
      expect(log).toContain('"level":"debug"');
      expect(metricsPage).toContain('route="/upload/:token"');
      expect(metricsPage).toContain('process_cpu_seconds_total');
      // Every kind of secret was there to find.
      const kinds = [
        ...['PINWALL_SECRET_KEY', 'another PINWALL_SECRET_KEY'].flatMap((key) => [
          key,
          `${key} (base64)`,
          `${key} (Buffer)`,
        ]),
        'PINWALL_OIDC_CLIENT_SECRET',
        ...(dialect === 'postgres' ? ['database password'] : []),
        'setup token',
        'owner password',
        'wrong password',
        'session cookie (setup)',
        'session cookie (sign-in)',
        'session cookie (OIDC)',
        'API token',
        'bogus bearer',
        'upload token',
        'upload token (expired)',
        'content grant token (review)',
        'content grant token (raw)',
        'content grant token (share)',
        'content grant token (share original)',
        'share token',
        'share password',
        'wrong share password',
        'unlock cookie MAC',
        'guest token',
        'consent request id',
        'OAuth state',
        'OAuth PKCE challenge',
        'OAuth PKCE verifier',
        'OAuth code',
        'OAuth access token',
        'OAuth refresh token',
        'stray client secret',
        'OIDC binding cookie',
        'OIDC state',
        'OIDC nonce',
        'OIDC PKCE challenge',
        'OIDC PKCE verifier',
        'OIDC code',
        'OIDC client credentials (Basic)',
        'IdP access token',
        'IdP ID token',
        'IdP refresh token',
      ];
      expect([...new Set(secrets.values())].sort()).toEqual(kinds.sort());
    },
    FLOW_TIMEOUT_MS,
  );

  test('content tokens stay out of the log when they are host names', async () => {
    const lines: string[] = [];
    const ctx = await createTestContext({ dialect, env: CONTENT_ENV, log: (l) => lines.push(l) });
    cleanups.push(() => ctx.close());
    const owner = await createSignedInUser(ctx);
    const { version } = await publishFiles(ctx, owner.user, { 'index.html': '<h1>Plan</h1>' });
    const { token } = await createGrant(ctx.deps, {
      versionId: version.id,
      mode: 'raw',
      user: null,
    });
    const unknown = newContentToken();
    const secrets = new Map([
      [token, 'content grant token'],
      [unknown, 'a content token nobody was given'],
    ]);

    expect((await fetchContent(ctx, token, 'index.html')).status).toBe(200);
    expect((await fetchContent(ctx, token, 'missing.html')).status).toBe(404);
    expect((await fetchContent(ctx, unknown, 'index.html')).status).toBe(404);

    expect(lines.join('')).toContain('"path":"/missing.html"');
    expect(leaksIn(lines, secrets)).toEqual([]);
    expect(onPage(await ctx.deps.metrics.registry.metrics(), secrets)).toEqual([]);
  });

  test('S3 keys stay out of the log, also when the store refuses them', async () => {
    const s3 = await startRefusingS3();
    cleanups.push(s3.close);
    const accessKeyId = random('s3-key');
    const secretAccessKey = random('s3-secret');
    const secrets = new Map([
      [accessKeyId, 'PINWALL_S3_ACCESS_KEY_ID'],
      [secretAccessKey, 'PINWALL_S3_SECRET_ACCESS_KEY'],
    ]);
    const lines: string[] = [];
    const ctx = await createTestContext({
      dialect,
      log: (line) => lines.push(line),
      env: {
        PINWALL_STORAGE: 's3',
        PINWALL_S3_BUCKET: 'pinwall',
        PINWALL_S3_ENDPOINT: s3.endpoint,
        PINWALL_S3_FORCE_PATH_STYLE: 'true',
        PINWALL_S3_ACCESS_KEY_ID: accessKeyId,
        PINWALL_S3_SECRET_ACCESS_KEY: secretAccessKey,
      },
    });
    cleanups.push(() => ctx.close());

    // Readiness asks for the bucket; a publish asks for its blob, fails, and cleans up after
    // itself, which is when the store reads the error document.
    expect((await ctx.request('/readyz')).status).toBe(503);
    const owner = await createSignedInUser(ctx);
    const token = await createUserToken(ctx, owner.user.id);
    const files = [{ path: 'index.html', content: '<!doctype html><h1>Plan</h1>' }];
    const published = await ctx.request(
      '/api/v1/publish/inline',
      apiInit(ctx, { bearer: token, body: { target: {}, files } }),
    );
    expect(published.status).toBe(500);

    // The refusals were logged, with the code and message an operator looks up...
    const log = lines.join('');
    expect(log).toContain('"msg":"Readiness check failed: storage"');
    expect(log).toContain('"msg":"Request failed with an unexpected error"');
    expect(log).toContain('"name":"SignatureDoesNotMatch"');
    expect(log).toContain('"message":"The request signature we calculated does not match');
    // ...without either key.
    expect(leaksIn(lines, secrets)).toEqual([]);
    expect(onPage(await ctx.deps.metrics.registry.metrics(), secrets)).toEqual([]);
    expect(credentialHeaders(lines)).toEqual([]);
  });
});
