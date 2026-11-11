import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import Provider, { type Account, interactionPolicy } from 'oidc-provider';

export interface TestIdpAccount {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  groups?: unknown;
}

export interface TestIdpOptions {
  /** Default: the Pinwall callback on http://localhost:8080 and on https://pinwall.test. */
  redirectUris?: string[];
  /** The claim released with scope `groups`, default `groups`; null = Google-like: neither. */
  groupsClaim?: string | null;
  /** Default true; false registers the client without the refresh_token grant. */
  refreshTokens?: boolean;
}

export interface TestIdp {
  /** `http://127.0.0.1:<port>` */
  readonly issuer: string;
  /** Pinwall's PINWALL_OIDC_* variables for this IdP, plus `extra`. */
  env(extra?: Record<string, string>): Record<string, string>;
  addAccount(account: TestIdpAccount): void;
  setGroups(sub: string, groups: unknown): void;
  /** The account is no longer found, so its refresh tokens get invalid_grant. */
  disable(sub: string): void;
  /** Destroys the grants the account received, so its refresh tokens get invalid_grant. */
  revokeGrants(sub: string): Promise<void>;
  /** The account that interactions complete as, until changed. */
  signInAs(sub: string): void;
  /** The next interaction ends with error=access_denied. */
  cancelNextSignIn(): void;
  /** While false, every request is counted, then its connection destroyed. */
  setReachable(reachable: boolean): void;
  /** A delay before handling every request. */
  setLatency(ms: number): void;
  /** The token endpoint answers this JSON error instead, until reset with null. */
  failTokenRequests(failure: { status: number; error: string } | null): void;
  /** The query of every request to the authorization endpoint, in order. */
  readonly authorizationRequests: URLSearchParams[];
  /** Token requests of this grant type, counted on arrival, also when dropped or failed. */
  tokenRequests(grantType: 'authorization_code' | 'refresh_token'): number;
  close(): Promise<void>;
}

const TEST_IDP_CLIENT_ID = 'pinwall';
const TEST_IDP_CLIENT_SECRET = 'pinwall-test-secret';
const DEFAULT_REDIRECT_URIS = [
  'http://localhost:8080/auth/oidc/callback',
  'https://pinwall.test/auth/oidc/callback',
];
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;

type StoredPayload = Record<string, unknown> & {
  grantId?: unknown;
  uid?: unknown;
  userCode?: unknown;
};

/**
 * One oidc-provider model's rows in a store shared by the IdP's models. Payloads are copied in
 * and out like a database would; expiry is left to oidc-provider's own checks.
 */
class ModelStore {
  constructor(
    private readonly rows: Map<string, StoredPayload>,
    private readonly model: string,
  ) {}

  private key(id: string): string {
    return `${this.model}:${id}`;
  }

  private *own(): Generator<[string, StoredPayload]> {
    for (const entry of this.rows) if (entry[0].startsWith(`${this.model}:`)) yield entry;
  }

  async upsert(id: string, payload: StoredPayload): Promise<void> {
    this.rows.set(this.key(id), structuredClone(payload));
  }

  async find(id: string): Promise<StoredPayload | undefined> {
    const row = this.rows.get(this.key(id));
    return row && structuredClone(row);
  }

  async findByUid(uid: string): Promise<StoredPayload | undefined> {
    for (const [, row] of this.own()) if (row.uid === uid) return structuredClone(row);
    return undefined;
  }

  async findByUserCode(userCode: string): Promise<StoredPayload | undefined> {
    for (const [, row] of this.own()) if (row.userCode === userCode) return structuredClone(row);
    return undefined;
  }

  async consume(id: string): Promise<void> {
    const row = this.rows.get(this.key(id));
    if (row) row.consumed = Math.floor(Date.now() / 1000);
  }

  async destroy(id: string): Promise<void> {
    this.rows.delete(this.key(id));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    for (const [key, row] of this.own()) if (row.grantId === grantId) this.rows.delete(key);
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * A stand-in for `req` whose body can be read again: the body was read on arrival to count the
 * grant type. It carries the request fields Koa and oidc-provider read.
 */
function withBody(req: IncomingMessage, body: Buffer): IncomingMessage {
  return Object.assign(Readable.from([body], { objectMode: false }), {
    headers: req.headers,
    rawHeaders: req.rawHeaders,
    method: req.method,
    url: req.url,
    httpVersion: req.httpVersion,
    httpVersionMajor: req.httpVersionMajor,
    httpVersionMinor: req.httpVersionMinor,
    socket: req.socket,
  }) as unknown as IncomingMessage;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * An OpenID Provider (oidc-provider) on 127.0.0.1 with a random port and an `http:` issuer.
 * One confidential client, `pinwall`, using client_secret_basic and the code flow. Interactions
 * finish at once as the `signInAs` account, granting every requested scope.
 */
export async function startTestIdp(opts: TestIdpOptions = {}): Promise<TestIdp> {
  const groupsClaim = opts.groupsClaim === undefined ? 'groups' : opts.groupsClaim;
  const refreshTokens = opts.refreshTokens ?? true;

  const accounts = new Map<string, TestIdpAccount>();
  const disabled = new Set<string>();
  const grantIds = new Map<string, string[]>();
  const authorizationRequests: URLSearchParams[] = [];
  const tokenCounts = { authorization_code: 0, refresh_token: 0 };
  let signedInAs: string | undefined;
  let cancelNext = false;
  let reachable = true;
  let latencyMs = 0;
  let tokenFailure: { status: number; error: string } | null = null;

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const policy = interactionPolicy.base();
  // oidc-provider refuses prompt=select_account unless a requestable prompt has that name.
  policy.add(new interactionPolicy.Prompt({ name: 'select_account', requestable: true }), 0);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rows = new Map<string, StoredPayload>();

  const provider = new Provider(issuer, {
    adapter: (model: string) => new ModelStore(rows, model),
    clients: [
      {
        client_id: TEST_IDP_CLIENT_ID,
        client_secret: TEST_IDP_CLIENT_SECRET,
        token_endpoint_auth_method: 'client_secret_basic',
        redirect_uris: opts.redirectUris ?? DEFAULT_REDIRECT_URIS,
        response_types: ['code'],
        grant_types: refreshTokens
          ? ['authorization_code', 'refresh_token']
          : ['authorization_code'],
      },
    ],
    scopes: ['openid', 'offline_access', 'email', 'profile', ...(groupsClaim ? ['groups'] : [])],
    claims: {
      email: ['email', 'email_verified'],
      profile: ['name', 'picture'],
      ...(groupsClaim ? { groups: [groupsClaim] } : {}),
    },
    findAccount: async (_ctx: unknown, sub: string): Promise<Account | undefined> => {
      if (disabled.has(sub) || !accounts.has(sub)) return undefined;
      return {
        accountId: sub,
        claims: async () => {
          const { groups, ...standard } = accounts.get(sub) ?? { sub };
          return groupsClaim && groups !== undefined
            ? { ...standard, [groupsClaim]: groups }
            : standard;
        },
      };
    },
    // Like Keycloak or Zitadel, a client allowed the refresh_token grant gets a refresh token
    // with every code grant, and it outlives the IdP browser session. oidc-provider alone keeps
    // offline_access only on a request with prompt=consent.
    issueRefreshToken: async (_ctx: unknown, client: { grantTypeAllowed(type: string): boolean }) =>
      client.grantTypeAllowed('refresh_token'),
    expiresWithSession: async () => false,
    rotateRefreshToken: true,
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false } },
    interactions: {
      policy,
      url: (_ctx: unknown, interaction: { uid: string }) => `/interaction/${interaction.uid}`,
    },
    jwks: {
      keys: [
        { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'test-idp' },
      ],
    },
    ttl: {
      AccessToken: HOUR_SECONDS,
      AuthorizationCode: 60,
      Grant: 14 * DAY_SECONDS,
      IdToken: HOUR_SECONDS,
      Interaction: HOUR_SECONDS,
      RefreshToken: 14 * DAY_SECONDS,
      Session: 14 * DAY_SECONDS,
    },
    // Defaults that print a notice to change them; this IdP has no browser pages or CORS.
    clientBasedCORS: () => false,
    renderError: async (ctx: { type: string; body: unknown }, out: Record<string, string>) => {
      ctx.type = 'json';
      ctx.body = out;
    },
  });
  const handleOidc = provider.callback();

  async function finishInteraction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const interaction = await provider.interactionDetails(req, res);
    if (cancelNext) {
      cancelNext = false;
      await provider.interactionFinished(req, res, {
        error: 'access_denied',
        error_description: 'The test IdP user cancelled the sign-in',
      });
      return;
    }
    const accountId = signedInAs;
    if (accountId === undefined || !accounts.has(accountId)) {
      throw new Error(`test IdP: no account to sign in as (signInAs: ${accountId})`);
    }
    const grant = new provider.Grant({ accountId, clientId: String(interaction.params.client_id) });
    grant.addOIDCScope(String(interaction.params.scope ?? 'openid'));
    const grantId = await grant.save();
    grantIds.set(accountId, [...(grantIds.get(accountId) ?? []), grantId]);
    // Every requested prompt must have a result, or the provider asks again.
    await provider.interactionFinished(req, res, {
      login: { accountId },
      consent: { grantId },
      select_account: {},
    });
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname, searchParams } = new URL(req.url ?? '/', issuer);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    if (pathname === '/auth') authorizationRequests.push(searchParams);
    if (pathname === '/token' && body !== undefined) {
      const grantType = new URLSearchParams(body.toString()).get('grant_type');
      if (grantType === 'authorization_code' || grantType === 'refresh_token') {
        tokenCounts[grantType] += 1;
      }
    }
    if (!reachable) {
      req.socket.destroy();
      return;
    }
    if (latencyMs > 0) await sleep(latencyMs);
    if (pathname === '/token' && tokenFailure !== null) {
      sendJson(res, tokenFailure.status, { error: tokenFailure.error });
    } else if (pathname.startsWith('/interaction/')) {
      await finishInteraction(req, res);
    } else {
      handleOidc(body === undefined ? req : withBody(req, body), res);
    }
  }

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    dispatch(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : String(error));
      }
    });
  });

  function account(sub: string): TestIdpAccount {
    const found = accounts.get(sub);
    if (!found) throw new Error(`test IdP: unknown account ${sub}`);
    return found;
  }

  return {
    issuer,
    env: (extra = {}) => ({
      PINWALL_OIDC_ISSUER: issuer,
      PINWALL_OIDC_CLIENT_ID: TEST_IDP_CLIENT_ID,
      PINWALL_OIDC_CLIENT_SECRET: TEST_IDP_CLIENT_SECRET,
      PINWALL_OIDC_DISPLAY_NAME: 'Test IdP',
      ...(groupsClaim
        ? {
            PINWALL_OIDC_SCOPES: 'openid email profile offline_access groups',
            PINWALL_OIDC_ROLES_CLAIM: groupsClaim,
          }
        : {}),
      ...extra,
    }),
    addAccount: (a) => {
      accounts.set(a.sub, { ...a });
    },
    setGroups: (sub, groups) => {
      account(sub).groups = groups;
    },
    disable: (sub) => {
      account(sub);
      disabled.add(sub);
    },
    revokeGrants: async (sub) => {
      for (const id of grantIds.get(sub) ?? []) await (await provider.Grant.find(id))?.destroy();
      grantIds.delete(sub);
    },
    signInAs: (sub) => {
      account(sub);
      signedInAs = sub;
    },
    cancelNextSignIn: () => {
      cancelNext = true;
    },
    setReachable: (value) => {
      reachable = value;
    },
    setLatency: (ms) => {
      latencyMs = ms;
    },
    failTokenRequests: (failure) => {
      tokenFailure = failure;
    },
    authorizationRequests,
    tokenRequests: (grantType) => tokenCounts[grantType],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** `Set-Cookie` lines applied to a name → value jar; expired or emptied cookies are removed. */
function storeCookies(jar: Map<string, string>, setCookies: string[]): void {
  for (const line of setCookies) {
    const [pair = '', ...attributes] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attributes.some((attribute) => {
      const [key = '', val = ''] = attribute.split('=').map((part) => part.trim());
      if (key.toLowerCase() === 'max-age') return Number(val) <= 0;
      if (key.toLowerCase() === 'expires') return Date.parse(val) <= Date.now();
      return false;
    });
    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

const MAX_REDIRECTS = 10;

/**
 * Plays the browser at the IdP: follows its redirects from `authorizeUrl`, with a cookie jar of
 * its own, until one leads off the issuer. Returns that URL: the client callback.
 */
export async function idpBrowserAuthorize(idp: TestIdp, authorizeUrl: string): Promise<URL> {
  const issuerOrigin = new URL(idp.issuer).origin;
  const jar = new Map<string, string>();
  let url = new URL(authorizeUrl);
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const res = await fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    storeCookies(jar, res.headers.getSetCookie());
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || location === null) {
      throw new Error(`test IdP answered ${res.status} at ${url.pathname}: ${await res.text()}`);
    }
    await res.body?.cancel();
    url = new URL(location, url);
    if (url.origin !== issuerOrigin) return url;
  }
  throw new Error(`test IdP: more than ${MAX_REDIRECTS} redirects`);
}
