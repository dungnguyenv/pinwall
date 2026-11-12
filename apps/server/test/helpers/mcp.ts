import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OAuthConsentRequest, OAuthDecisionResult } from '@pinwall/shared';
import { publicUrl } from '../../src/http/public-url.ts';
import { apiInit } from './auth.ts';
import type { TestContext } from './context.ts';
import { consentRequestId } from './oauth.ts';

/** A `fetch` that hands every request to the app in this process, URL and all. */
export function inProcessFetch(ctx: TestContext): FetchLike {
  return async (url, init) => ctx.app.request(url, init);
}

/**
 * The SDK's Streamable HTTP transport for `/mcp` on the public origin, sending through `fetch`
 * (`inProcessFetch` by default): with `bearer` as `Authorization: Bearer`, or `authProvider`
 * running the SDK's own OAuth flow. Keep it to call `finishAuth` once the browser is done.
 */
export function mcpTransport(
  ctx: TestContext,
  o: { bearer?: string; authProvider?: OAuthClientProvider; fetch?: FetchLike } = {},
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(publicUrl(ctx.deps.config, '/mcp')), {
    fetch: o.fetch ?? inProcessFetch(ctx),
    ...(o.bearer === undefined
      ? {}
      : { requestInit: { headers: { authorization: `Bearer ${o.bearer}` } } }),
    ...(o.authProvider === undefined ? {} : { authProvider: o.authProvider }),
  });
}

/**
 * An MCP SDK client connected to `/mcp` through `mcpTransport`, as an agent connects.
 * `rewriteBody` changes each string request body before it is sent (to play another client's
 * JSON escaping). The client has finished `initialize` when this resolves.
 */
export async function connectMcp(
  ctx: TestContext,
  o: {
    bearer?: string;
    authProvider?: OAuthClientProvider;
    fetch?: FetchLike;
    rewriteBody?: (body: string) => string;
  },
): Promise<Client> {
  const base = o.fetch ?? inProcessFetch(ctx);
  const { rewriteBody } = o;
  const fetch: FetchLike = rewriteBody
    ? (url, init) =>
        base(url, typeof init?.body === 'string' ? { ...init, body: rewriteBody(init.body) } : init)
    : base;
  const client = new Client({ name: 'pinwall-test', version: '0.0.0' });
  await client.connect(mcpTransport(ctx, { ...o, fetch }));
  return client;
}

/** The text blocks of a tool result, joined by newlines. */
export function toolText(r: CallToolResult): string {
  return r.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/**
 * An MCP client's OAuth side as a desktop agent keeps it, all in memory: a public client that
 * registers itself with one redirect URL, its tokens and its PKCE verifier. Where an agent would
 * open a browser, `redirectToAuthorization` only notes the URL in `authorizationUrl`. When the
 * server refuses what it holds, the SDK drops it through `invalidateCredentials` and signs in
 * again, as Claude Code does.
 */
export class TestOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  /** Where the SDK last sent the browser; set by `redirectToAuthorization`. */
  authorizationUrl: URL | null = null;
  private client: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;
  private verifier: string | undefined;

  constructor(o: { redirectUrl: string; clientName: string }) {
    this.redirectUrl = o.redirectUrl;
    this.clientMetadata = {
      client_name: o.clientName,
      redirect_uris: [o.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  state(): string {
    return 'flow-state';
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.client;
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    this.client = information;
  }

  tokens(): OAuthTokens | undefined {
    return this.saved;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.saved = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.verifier === undefined) throw new Error('No PKCE verifier was saved');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all' || scope === 'client') this.client = undefined;
    if (scope === 'all' || scope === 'tokens') this.saved = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
  }
}

/**
 * The browser side of an agent's sign-in, for the person holding `cookie`: opens
 * `authorizationUrl` (sent without cookies, as a fresh tab follows a link, and handed to the
 * consent page), reads the consent request and allows it as the SPA does. Checks that the answer
 * goes to the redirect URI with the same `state` and `iss` set to the public origin (RFC 9207),
 * and returns the code the agent receives.
 */
export async function approveInBrowser(
  ctx: TestContext,
  authorizationUrl: URL,
  cookie: string,
): Promise<string> {
  const redirectUri = authorizationUrl.searchParams.get('redirect_uri');
  const state = authorizationUrl.searchParams.get('state');
  const handOff = await ctx.request(authorizationUrl.href);
  const consentPage = publicUrl(ctx.deps.config, '/oauth/consent');
  const location = handOff.headers.get('location') ?? '';
  if (!location.startsWith(`${consentPage}?`)) {
    throw new Error(`authorize sent the browser to ${location || 'nowhere'}, not the consent page`);
  }
  const id = await consentRequestId(handOff);

  const described = await ctx.request(`/api/v1/oauth/requests/${id}`, apiInit(ctx, { cookie }));
  if (described.status !== 200) {
    throw new Error(`the consent request answered ${described.status}: ${await described.text()}`);
  }
  const request = OAuthConsentRequest.parse(await described.json());
  if (redirectUri === null || request.redirect_host !== new URL(redirectUri).host) {
    throw new Error(`the consent page names ${request.redirect_host}, not ${redirectUri}`);
  }

  const decided = await ctx.request(
    `/api/v1/oauth/requests/${id}/decision`,
    apiInit(ctx, { cookie, body: { approve: true } }),
  );
  if (decided.status !== 200) {
    throw new Error(`the decision answered ${decided.status}: ${await decided.text()}`);
  }
  const back = new URL(OAuthDecisionResult.parse(await decided.json()).redirect_to);
  const code = back.searchParams.get('code');
  if (
    `${back.origin}${back.pathname}` !== redirectUri ||
    back.searchParams.get('state') !== state ||
    back.searchParams.get('iss') !== ctx.deps.config.publicOrigin ||
    code === null
  ) {
    throw new Error(`the browser was sent back to ${back.href}`);
  }
  return code;
}
