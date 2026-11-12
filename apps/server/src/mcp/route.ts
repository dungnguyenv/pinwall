import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { type BearerResolver, resolveAuth } from '../auth/resolve.ts';
import { bearerResolvers } from '../auth/resolvers.ts';
import type { Config } from '../config/types.ts';
import { forbidden, methodNotAllowed, unauthorized } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { resourceMetadataUrl } from '../oauth/metadata.ts';
import { oauthAccessTokenResolver } from '../oauth/tokens.ts';
import { createMcpServer } from './server.ts';

/** JSON may write any one byte of a string as `\uXXXX`: six bytes. */
const WORST_CASE_ESCAPE_BYTES = 6;
/** Room for the JSON-RPC envelope and a tool's other arguments around an inline payload. */
const ENVELOPE_BYTES = 65_536;

/** OAuth access tokens are good here and nowhere else; API tokens work as everywhere. */
const MCP_RESOLVERS: readonly BearerResolver[] = [oauthAccessTokenResolver, ...bearerResolvers];

/** The `error` parameter of a `WWW-Authenticate` challenge set further down the chain. */
const CHALLENGE_ERROR = /\berror="([^"]*)"/;

/**
 * The largest `/mcp` request body read: an inline publish at the inline limit still fits when
 * the client escaped every byte of it, so an oversized payload reaches the tool, which explains
 * the limit, rather than failing at the transport.
 */
export function mcpBodyLimit(config: Config): number {
  return WORST_CASE_ESCAPE_BYTES * config.limits.maxInlineBytes + ENVELOPE_BYTES;
}

/**
 * DNS-rebinding guard: MCP clients send no `Origin`, so a request that carries one other than
 * the public origin came from a web page and is refused (`null` included), credentials or not.
 */
export function mcpOriginGuard(config: Config): MiddlewareHandler<AppEnv> {
  const expected = config.publicOrigin;
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== expected) {
      throw forbidden(t('mcp.origin', { origin, expected }));
    }
    await next();
  };
}

/**
 * Gives every 401 from `/mcp` the RFC 9728 challenge that points MCP clients at the resource
 * metadata, and through it at Pinwall's OAuth server, keeping the RFC 6750 `error` code a
 * resolver set (`invalid_token`, `invalid_request`).
 */
export function mcpChallenge(config: Config): MiddlewareHandler<AppEnv> {
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl(config)}"`;
  return async (c, next) => {
    await next();
    if (c.res.status !== 401) return;
    const error = CHALLENGE_ERROR.exec(c.res.headers.get('www-authenticate') ?? '')?.[1];
    c.header(
      'WWW-Authenticate',
      error === undefined ? challenge : `${challenge}, error="${error}"`,
    );
  };
}

/**
 * One MCP exchange: a fresh server and stateless transport for this caller, answered as JSON
 * (no event stream to keep open through proxies), then both closed. Only POST carries MCP
 * messages; without sessions or streams, GET and DELETE have nothing to do.
 */
async function serveMcp(c: Context<AppEnv>): Promise<Response> {
  const { deps, auth } = c.var;
  if (auth === null) throw unauthorized(t('mcp.signIn'));
  if (c.req.method !== 'POST') {
    c.header('Allow', 'POST');
    throw methodNotAllowed(t('mcp.method'));
  }
  const server = createMcpServer({ deps, auth, c });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: mcpBodyLimit(deps.config),
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } finally {
    await transport.close();
    await server.close();
  }
}

/** A middleware built from the app's config when the request arrives. */
function withConfig(
  make: (config: Config) => MiddlewareHandler<AppEnv>,
): MiddlewareHandler<AppEnv> {
  return (c, next) => make(c.var.deps.config)(c, next);
}

/**
 * `/mcp` (and `/mcp/`): MCP over Streamable HTTP, authenticated by a bearer token only, an
 * OAuth access token for this resource or an API token, never a cookie. The challenge wraps
 * everything so every 401 carries it; the Origin guard runs before any credential is looked at.
 * Mount it before the SPA.
 */
export function mountMcp(app: Hono<AppEnv>): void {
  app.on(
    ['POST', 'GET', 'DELETE'],
    ['/mcp', '/mcp/'],
    withConfig(mcpChallenge),
    withConfig(mcpOriginGuard),
    resolveAuth({ bearer: MCP_RESOLVERS, cookies: false }),
    serveMcp,
  );
}
