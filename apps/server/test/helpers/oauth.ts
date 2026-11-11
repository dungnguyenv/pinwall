import { createHash, randomBytes } from 'node:crypto';
import { apiInit } from './auth.ts';
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

/** A fresh PKCE verifier and its S256 challenge, computed here rather than by the server code. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * `/oauth/authorize?…` as an MCP client sends it. Defaults: `response_type=code` and
 * `code_challenge_method=S256`; `state`, `resource` and `scope` are sent only when given.
 */
export function authorizePath(p: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  resource?: string;
  scope?: string;
  responseType?: string;
  method?: string;
}): string {
  const query = new URLSearchParams({
    response_type: p.responseType ?? 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.challenge,
    code_challenge_method: p.method ?? 'S256',
  });
  if (p.state !== undefined) query.set('state', p.state);
  if (p.resource !== undefined) query.set('resource', p.resource);
  if (p.scope !== undefined) query.set('scope', p.scope);
  return `/oauth/authorize?${query}`;
}

/** The request id in a `/oauth/consent?request=<id>` hand-off; throws on any other answer. */
export async function consentRequestId(res: Response): Promise<string> {
  const location = res.headers.get('location');
  const id = location ? new URL(location).searchParams.get('request') : null;
  if (res.status !== 302 || id === null) {
    throw new Error(`authorize answered ${res.status} (${location}): ${await res.text()}`);
  }
  return id;
}

/**
 * The browser side of a sign-in: authorize with a fresh PKCE pair, then allow the request on
 * the consent API as the holder of `cookie`. Returns the code, the verifier to redeem it with
 * and the URL the browser is sent back to.
 */
export async function approve(
  ctx: TestContext,
  cookie: string,
  p: { clientId: string; redirectUri: string; state?: string; resource?: string },
): Promise<{ code: string; verifier: string; redirectTo: URL }> {
  const { verifier, challenge } = pkcePair();
  const id = await consentRequestId(await ctx.request(authorizePath({ ...p, challenge })));
  const r = await ctx.request(
    `/api/v1/oauth/requests/${id}/decision`,
    apiInit(ctx, { cookie, body: { approve: true } }),
  );
  if (r.status !== 200) {
    throw new Error(`the decision answered ${r.status}: ${await r.text()}`);
  }
  const { redirect_to } = (await r.json()) as { redirect_to: string };
  const redirectTo = new URL(redirect_to);
  const code = redirectTo.searchParams.get('code');
  if (code === null) throw new Error(`the decision sent no code: ${redirect_to}`);
  return { code, verifier, redirectTo };
}
