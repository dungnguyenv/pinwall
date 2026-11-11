import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { publicUrl } from '../../src/http/public-url.ts';
import type { TestContext } from './context.ts';

/** A `fetch` that hands every request to the app in this process, URL and all. */
export function inProcessFetch(ctx: TestContext): FetchLike {
  return async (url, init) => ctx.app.request(url, init);
}

/**
 * An MCP SDK client connected to `/mcp` on the public origin through `inProcessFetch`, as an
 * agent connects: with `bearer` sent as `Authorization: Bearer`, or `authProvider` running the
 * SDK's own OAuth flow. `rewriteBody` changes each string request body before it is sent (to
 * play another client's JSON escaping). The client has finished `initialize` when this resolves.
 */
export async function connectMcp(
  ctx: TestContext,
  o: {
    bearer?: string;
    authProvider?: OAuthClientProvider;
    rewriteBody?: (body: string) => string;
  },
): Promise<Client> {
  const base = inProcessFetch(ctx);
  const { rewriteBody } = o;
  const fetch: FetchLike = rewriteBody
    ? (url, init) =>
        base(url, typeof init?.body === 'string' ? { ...init, body: rewriteBody(init.body) } : init)
    : base;
  const transport = new StreamableHTTPClientTransport(new URL(publicUrl(ctx.deps.config, '/mcp')), {
    fetch,
    ...(o.bearer === undefined
      ? {}
      : { requestInit: { headers: { authorization: `Bearer ${o.bearer}` } } }),
    ...(o.authProvider === undefined ? {} : { authProvider: o.authProvider }),
  });
  const client = new Client({ name: 'pinwall-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** The text blocks of a tool result, joined by newlines. */
export function toolText(r: CallToolResult): string {
  return r.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}
