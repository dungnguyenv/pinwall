import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type CallToolResult, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, onTestFinished, test } from 'vitest';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { mcpBodyLimit } from '../../src/mcp/route.ts';
import { SERVER_INSTRUCTIONS, TOOL_NAMES } from '../../src/mcp/server.ts';
import { createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { CONTENT_ENV } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { connectMcp, toolText } from '../helpers/mcp.ts';
import { issueTestTokens } from '../helpers/oauth.ts';
import { listen } from '../helpers/socket.ts';

const T = Date.UTC(2026, 10, 10);
const CHALLENGE =
  'Bearer resource_metadata="http://localhost:8080/.well-known/oauth-protected-resource/mcp"';
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'probe', version: '1.0.0' },
  },
});

/** A JSON-RPC `initialize` POST as a Streamable HTTP client sends it, plus `headers`. */
function init(headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: INITIALIZE,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

type Whoami = { user: { id: string }; via: string; authoring_notes: string[] } & Record<
  string,
  unknown
>;

describe.each(dialects)('/mcp on %s', (dialect) => {
  let ctx: TestContext;
  /** An IdP member, freshly checked, named Ada. */
  let ada: { user: UserRow; cookie: string };
  let clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients) await client.close();
    clients = [];
    await ctx?.close();
  });

  async function start(env: Record<string, string> = {}): Promise<void> {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T), env });
    ada = await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' });
  }

  async function connect(token: string): Promise<Client> {
    const client = await connectMcp(ctx, { bearer: token });
    clients.push(client);
    return client;
  }

  async function whoami(client: Client): Promise<CallToolResult & { structuredContent: Whoami }> {
    const r = (await client.callTool({ name: 'whoami', arguments: {} })) as CallToolResult;
    expect(r.isError, toolText(r)).toBeFalsy();
    return r as CallToolResult & { structuredContent: Whoami };
  }

  test('the challenge names the public origin', async () => {
    await start({ PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test', PINWALL_TRUST_PROXY: 'true' });
    const r = await ctx.request(
      'http://internal:8080/mcp',
      init({
        host: 'internal:8080',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'http',
      }),
    );
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://pinwall.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(await r.json()).toEqual({ error: { code: 'unauthorized', message: t('mcp.signIn') } });
  });

  test('a bad token is invalid_token with the challenge', async () => {
    await start();
    const r = await ctx.request('/mcp', init(bearer('pwa_nope')));
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_token"`);

    const basic = await ctx.request('/mcp', init({ authorization: 'Basic YWRhOnB3' }));
    expect(basic.status).toBe(401);
    expect(basic.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_request"`);
  });

  test('cookies never authenticate /mcp', async () => {
    await start();
    const r = await ctx.request(
      '/mcp',
      init({ cookie: ada.cookie, origin: 'http://localhost:8080' }),
    );
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(CHALLENGE);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  test('an API token connects and sees the instructions and whoami', async () => {
    await start();
    const client = await connect(await createUserToken(ctx, ada.user.id));
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(client.getServerVersion()).toMatchObject({ name: 'pinwall', title: 'Pinwall' });

    const { tools } = await client.listTools();
    const found = tools.find((x) => x.name === 'whoami');
    expect(found).toMatchObject({
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
    for (const tool of tools) expect(TOOL_NAMES).toContain(tool.name);
  });

  test('a Node client connects over a real socket', async () => {
    await start();
    const server = await listen(ctx.app, ctx.deps.config);
    onTestFinished(() => server.close());
    const token = await createUserToken(ctx, ada.user.id);
    // Node's own fetch, as Node-based agents use: it sends no Origin header.
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
      { requestInit: { headers: bearer(token) } },
    );
    const client = new Client({ name: 'socket-probe', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    const r = await whoami(client);
    expect(r.structuredContent).toMatchObject({ user: { id: ada.user.id }, via: 'api_token' });
  });

  test('an OAuth access token connects', async () => {
    await start();
    const { access } = await issueTestTokens(ctx, ada.cookie);
    const r = await whoami(await connect(access));
    expect(r.structuredContent).toMatchObject({ user: { id: ada.user.id }, via: 'oauth' });
  });

  test('a foreign Origin is refused', async () => {
    await start();
    const token = await createUserToken(ctx, ada.user.id);
    for (const origin of ['http://evil.example', 'null']) {
      const r = await ctx.request('/mcp', init({ ...bearer(token), origin }));
      expect(r.status, origin).toBe(403);
      expect(await r.json(), origin).toEqual({
        error: {
          code: 'forbidden',
          message: t('mcp.origin', { origin, expected: 'http://localhost:8080' }),
        },
      });
    }
    // Refused before any credential is looked at.
    const anonymous = await ctx.request('/mcp', init({ origin: 'http://evil.example' }));
    expect(anonymous.status).toBe(403);

    const same = await ctx.request(
      '/mcp',
      init({ ...bearer(token), origin: 'http://localhost:8080' }),
    );
    expect(same.status).toBe(200);
    expect((await ctx.request('/mcp', init(bearer(token)))).status).toBe(200);
  });

  test('GET and DELETE are 405', async () => {
    await start();
    const token = await createUserToken(ctx, ada.user.id);
    for (const method of ['GET', 'DELETE']) {
      const r = await ctx.request('/mcp', {
        method,
        headers: { ...bearer(token), accept: 'application/json, text/event-stream' },
      });
      expect(r.status, method).toBe(405);
      expect(r.headers.get('allow'), method).toBe('POST');
      expect(await r.json(), method).toEqual({
        error: { code: 'method_not_allowed', message: t('mcp.method') },
      });
    }
    // Without a credential the answer is the challenge, so a client knows to sign in first.
    const anonymous = await ctx.request('/mcp', { method: 'GET' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(CHALLENGE);
  });

  test('a body of six times the inline limit plus 64 KB is read, one byte more is not', async () => {
    await start({ PINWALL_MAX_INLINE_BYTES: '1000' });
    const limit = mcpBodyLimit(ctx.deps.config);
    expect(limit).toBe(6 * 1000 + 65_536);
    const token = await createUserToken(ctx, ada.user.id);
    // Trailing whitespace keeps the JSON valid at any size.
    const padded = (size: number): RequestInit => ({
      ...init(bearer(token)),
      body: INITIALIZE.padEnd(size, ' '),
    });
    expect((await ctx.request('/mcp', padded(limit))).status).toBe(200);
    expect((await ctx.request('/mcp', padded(limit + 1))).status).toBe(413);
  });

  test('/mcp/ works like /mcp', async () => {
    await start();
    const token = await createUserToken(ctx, ada.user.id);
    const r = await ctx.request('/mcp/', init(bearer(token)));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'pinwall' }, instructions: SERVER_INSTRUCTIONS },
    });

    const anonymous = await ctx.request('/mcp/', init());
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(CHALLENGE);
    expect((await ctx.request('/mcp/', { method: 'GET', headers: bearer(token) })).status).toBe(
      405,
    );
  });

  test('a blocked user is refused', async () => {
    await start();
    const token = await createUserToken(ctx, ada.user.id);
    const { access } = await issueTestTokens(ctx, ada.cookie);
    await ctx.deps.db.db
      .updateTable('users')
      .set({ role_override: 'blocked' })
      .where('id', '=', ada.user.id)
      .execute();
    for (const credential of [token, access]) {
      const r = await ctx.request('/mcp', init(bearer(credential)));
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ error: { code: 'access_denied' } });
    }
  });

  test('whoami reports identity, limits, isolation and authoring notes', async () => {
    await start();
    const r = await whoami(await connect(await createUserToken(ctx, ada.user.id)));
    const notes = [
      t('mcp.notes.entry'),
      t('mcp.notes.relativeLinks'),
      t('mcp.notes.selfContained'),
      t('mcp.notes.opaqueOrigin'),
    ];
    expect(r.structuredContent).toEqual({
      user: { id: ada.user.id, name: 'Ada', email: ada.user.email, role: 'member' },
      via: 'api_token',
      pinwall_url: 'http://localhost:8080',
      isolation: 'single-domain',
      limits: {
        max_upload_bytes: 95_000_000,
        max_inline_bytes: 2_000_000,
        max_file_bytes: 50_000_000,
        max_version_bytes: 500_000_000,
        max_files: 10_000,
      },
      upload_url_ttl_seconds: 600,
      authoring_notes: notes,
    });
    expect(toolText(r)).toBe(
      `${t('mcp.whoami.text', {
        url: 'http://localhost:8080',
        name: 'Ada',
        role: 'member',
        via: 'api_token',
        isolation: 'single-domain',
        upload: '95 MB',
        inline: '2 MB',
      })}\n${notes.map((n) => `- ${n}`).join('\n')}`,
    );

    // The owner is always an admin, whatever its row says, and has no email.
    const owner = await createSignedInUser(ctx, { kind: 'owner', name: 'Olu' });
    const mine = await whoami(await connect(await createUserToken(ctx, owner.user.id)));
    expect(mine.structuredContent.user).toEqual({
      id: owner.user.id,
      name: 'Olu',
      email: null,
      role: 'admin',
    });
  });

  test('in content-domain mode the notes describe per-version origins', async () => {
    await start(CONTENT_ENV);
    const r = await whoami(await connect(await createUserToken(ctx, ada.user.id)));
    expect(r.structuredContent).toMatchObject({
      pinwall_url: 'https://pinwall.test',
      isolation: 'content-domain',
      authoring_notes: [
        t('mcp.notes.entry'),
        t('mcp.notes.relativeLinks'),
        t('mcp.notes.selfContained'),
        t('mcp.notes.perVersionOrigin'),
      ],
    });
  });
});
