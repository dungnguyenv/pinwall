import type { Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { enforceRateLimit } from '../auth/rate-limits.ts';
import { AppError, payloadTooLarge } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { renderErrorPage } from '../pages/error-page.tsx';
import { registerClient } from './clients.ts';
import { OAUTH_RATES } from './constants.ts';
import { OAuthError, oauthJson } from './errors.ts';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.ts';
import { AuthorizePageError, startAuthorization } from './requests.ts';

/** The largest request body an OAuth endpoint reads. */
const MAX_BODY_BYTES = 65_536;

function tooLarge(): Error {
  return payloadTooLarge(t('oauth.body.tooLarge'));
}

/**
 * The request body as text, read inside the handler so `oauthJson` shapes a refusal: a declared
 * length over `MAX_BODY_BYTES` is refused before reading, and reading stops once the body
 * passes it.
 */
async function readBody(c: Context<AppEnv>): Promise<string> {
  const declared = Number(c.req.header('content-length'));
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  const stream = c.req.raw.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isJsonMediaType(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** The registration request's JSON body; anything but JSON is `invalid_client_metadata`. */
async function readClientMetadata(c: Context<AppEnv>): Promise<unknown> {
  const notJson = () => new OAuthError('invalid_client_metadata', t('oauth.register.body'));
  if (!isJsonMediaType(c.req.header('content-type'))) throw notJson();
  const text = await readBody(c);
  try {
    return JSON.parse(text);
  } catch {
    throw notJson();
  }
}

/** Counts one authorization request; a refusal is shown as a page, never sent to the client. */
async function enforceAuthorizeRate(c: Context<AppEnv>): Promise<void> {
  try {
    await enforceRateLimit(c, OAUTH_RATES.authorize);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'rate_limited') throw err;
    const retryAfter = err.details?.retry_after_seconds;
    throw new AuthorizePageError(
      429,
      err.message,
      typeof retryAfter === 'number' ? retryAfter : undefined,
    );
  }
}

/**
 * `GET /oauth/authorize`: hands a valid request to the consent page, or a protocol error back to
 * the client. Until the client and its redirect URI are validated, a refusal is an HTML page
 * whatever `Accept` says, so the browser is never sent to an address nobody vouched for. No
 * answer is cached: each one carries a fresh request id, code or refusal.
 */
async function authorize(c: Context<AppEnv>): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  try {
    await enforceAuthorizeRate(c);
    const query = new URL(c.req.url).searchParams;
    return c.redirect(await startAuthorization(c.var.deps, query), 302);
  } catch (err) {
    if (!(err instanceof AuthorizePageError)) throw err;
    if (err.retryAfterSeconds !== undefined) {
      c.header('Retry-After', String(err.retryAfterSeconds));
    }
    const page = renderErrorPage({
      status: err.status,
      title: t('oauth.authorize.title'),
      message: err.message,
      requestId: c.var.requestId,
    });
    return c.html(page, err.status);
  }
}

/**
 * Pinwall's OAuth authorization server for its MCP resource: the metadata documents (JSON for
 * every client, browsers included), the RFC 7591 registration endpoint, whose every refusal is
 * RFC 6749 JSON, and the authorization endpoint, which hands off to the SPA's consent page. Its
 * URLs all come from the public origin. Mount it before the SPA.
 */
export function mountOAuth(app: Hono<AppEnv>): void {
  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json(authorizationServerMetadata(c.var.deps.config)),
  );
  // RFC 9728 §3.1 puts the metadata of `/mcp` under the resource's path; clients that look
  // for it at the root find the same document.
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    app.get(path, (c) => c.json(protectedResourceMetadata(c.var.deps.config)));
  }

  app.post(
    '/oauth/register',
    oauthJson(async (c) => {
      // Counted before the body is read, so malformed requests use up the limit too.
      await enforceRateLimit(c, OAUTH_RATES.register);
      const client = await registerClient(c.var.deps, await readClientMetadata(c));
      return c.json(client, 201);
    }),
  );

  app.get('/oauth/authorize', authorize);
}
