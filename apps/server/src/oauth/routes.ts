import type { Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { enforceRateLimit } from '../auth/rate-limits.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, payloadTooLarge } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { renderErrorPage } from '../pages/error-page.tsx';
import { mediaType, readBody } from './body.ts';
import { registerClient } from './clients.ts';
import { OAUTH_RATES } from './constants.ts';
import { OAuthError, oauthJson } from './errors.ts';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.ts';
import { AuthorizePageError, startAuthorization } from './requests.ts';
import {
  exchangeCode,
  readTokenForm,
  refreshGrant,
  revokeToken,
  type TokenResponse,
} from './tokens.ts';

/** The largest registration request body read. */
const MAX_REGISTRATION_BYTES = 65_536;

const tooLarge = (): Error => payloadTooLarge(t('oauth.body.tooLarge'));

/** The registration request's JSON body; anything but JSON is `invalid_client_metadata`. */
async function readClientMetadata(c: Context<AppEnv>): Promise<unknown> {
  const notJson = () => new OAuthError('invalid_client_metadata', t('oauth.register.body'));
  if (mediaType(c.req.header('content-type')) !== 'application/json') throw notJson();
  const text = await readBody(c, MAX_REGISTRATION_BYTES, tooLarge);
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

/** The tokens the form's `grant_type` stands for; any type but those supported is refused. */
async function grantTokens(deps: AppDeps, form: URLSearchParams): Promise<TokenResponse> {
  switch (form.get('grant_type')) {
    case 'authorization_code':
      return exchangeCode(deps, form);
    case 'refresh_token':
      return refreshGrant(deps, form);
    default:
      throw new OAuthError('unsupported_grant_type', t('oauth.token.grantType'));
  }
}

/**
 * Pinwall's OAuth authorization server for its MCP resource: the metadata documents (JSON for
 * every client, browsers included), the authorization endpoint, which hands off to the SPA's
 * consent page, and the registration (RFC 7591), token and revocation (RFC 7009) endpoints,
 * whose every refusal is RFC 6749 JSON. Its URLs all come from the public origin. Mount it before
 * the SPA.
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

  app.post(
    '/oauth/token',
    oauthJson(async (c) => {
      // Counted before the body is read, so malformed requests use up the limit too.
      await enforceRateLimit(c, OAUTH_RATES.token);
      // RFC 6749 §5.1, with the `Cache-Control: no-store` every OAuth answer carries.
      c.header('Pragma', 'no-cache');
      return c.json(await grantTokens(c.var.deps, await readTokenForm(c)));
    }),
  );

  app.post(
    '/oauth/revoke',
    oauthJson(async (c) => {
      // Counted before the body is read, so malformed requests use up the limit too.
      await enforceRateLimit(c, OAUTH_RATES.revoke);
      await revokeToken(c.var.deps, await readTokenForm(c));
      // RFC 7009 §2.2: 200 whether or not there was anything to revoke; the body is ignored.
      return c.body(null, 200);
    }),
  );
}
