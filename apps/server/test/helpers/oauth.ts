import type { TestContext } from './context.ts';

/**
 * Registers a public client through `POST /oauth/register`, as an MCP client does on first
 * connect, and returns its id and first redirect URI. Defaults: named "Claude Code", with the
 * loopback redirect `http://127.0.0.1:33418/callback`.
 */
export async function registerTestClient(
  ctx: TestContext,
  o: { redirectUris?: string[]; name?: string } = {},
): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUris = o.redirectUris ?? ['http://127.0.0.1:33418/callback'];
  const r = await ctx.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: o.name ?? 'Claude Code',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (r.status !== 201) {
    throw new Error(`POST /oauth/register answered ${r.status}: ${await r.text()}`);
  }
  const { client_id } = (await r.json()) as { client_id: string };
  return { clientId: client_id, redirectUri: redirectUris[0] ?? '' };
}
