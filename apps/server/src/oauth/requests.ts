import type { OAuthConsentRequest, OAuthDecisionResult } from '@pinwall/shared';
import type { Config } from '../config/types.ts';
import type { UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { publicUrl } from '../http/public-url.ts';
import { notFound } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { hashSecret, newSecret } from '../lib/ids.ts';
import { clientRedirectUris, getClient, quoteUri, touchClient } from './clients.ts';
import {
  AUTH_CODE_TTL_MS,
  AUTH_REQUEST_TTL_MS,
  MAX_STATE_LENGTH,
  OAUTH_SCOPE,
} from './constants.ts';
import { findOrCreateGrant } from './grants.ts';
import { mcpResourceUrl, normalizeResource } from './metadata.ts';
import { isValidPkceString } from './pkce.ts';
import { matchRedirectUri, redirectHost } from './redirect-uris.ts';

/**
 * A validated authorization request waiting for the person to sign in and decide. It is not
 * tied to whoever was signed in when it arrived, so it outlives signing out and back in as
 * someone else ("Not you?") within its lifetime.
 */
export interface AuthorizationRequest {
  clientId: string;
  /** Exactly as the client sent it; the token request must repeat it. */
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** Always the MCP resource, in its canonical spelling. */
  resource: string;
  scope: string;
  createdAt: number;
}

/** What an authorization code stands for, until the token endpoint redeems it. */
export interface AuthorizationCode {
  grantId: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
}

/**
 * A refusal of `/oauth/authorize` that must not go back to the client, because the client or
 * its redirect URI is not known yet (or the caller is rate limited): the route shows it as an
 * HTML page instead.
 */
export class AuthorizePageError extends Error {
  override readonly name = 'AuthorizePageError';

  constructor(
    readonly status: 400 | 429,
    message: string,
    /** For a 429, the `Retry-After` to send. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const requestKey = (id: string) => `oauth:request:${hashSecret(id)}`;
const codeKey = (code: string) => `oauth:code:${hashSecret(code)}`;

const expired = () => notFound(t('oauth.request.expired'));

/**
 * The client's redirect URI carrying `params` (those that are not null) and the issuer as `iss`
 * (RFC 9207), so the client can tell which server answered. A query the URI already has is kept.
 */
export function authorizationRedirect(
  config: Pick<Config, 'publicOrigin'>,
  redirectUri: string,
  params: Record<string, string | null>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', config.publicOrigin);
  return url.href;
}

/**
 * Checks an authorization request (RFC 6749 §4.1.1 with OAuth 2.1 PKCE and RFC 8707 resource),
 * stores it for the consent page and returns where the browser goes: the SPA's
 * `/oauth/consent?request=<id>`. Until the client and its redirect URI check out, a refusal is an
 * `AuthorizePageError`; after that it is the redirect URI carrying `error`, `error_description`,
 * `state` (unless that is what is wrong) and `iss`. Each parameter's first value is the one read.
 * Whatever scope is asked for, the grant is for `pinwall`, the only scope (RFC 6749 §3.3).
 */
export async function startAuthorization(deps: AppDeps, query: URLSearchParams): Promise<string> {
  const { config } = deps;
  const clientId = query.get('client_id');
  const client = clientId === null ? undefined : await getClient(deps.db.db, clientId);
  if (!client) throw new AuthorizePageError(400, t('oauth.authorize.unknownClient'));

  const redirectUri = query.get('redirect_uri');
  if (redirectUri === null || !matchRedirectUri(clientRedirectUris(client), redirectUri)) {
    const uri = redirectUri === null ? '(none)' : quoteUri(redirectUri);
    throw new AuthorizePageError(400, t('oauth.authorize.badRedirect', { uri }));
  }

  const askedState = query.get('state');
  // An overlong state is not echoed back, not even with another error.
  const state = askedState !== null && askedState.length <= MAX_STATE_LENGTH ? askedState : null;
  const refuse = (error: string, description: string) =>
    authorizationRedirect(config, redirectUri, { error, error_description: description, state });

  if (query.get('response_type') !== 'code') {
    return refuse('unsupported_response_type', t('oauth.authorize.responseType'));
  }
  const challenge = query.get('code_challenge') ?? '';
  if (query.get('code_challenge_method') !== 'S256' || !isValidPkceString(challenge)) {
    return refuse('invalid_request', t('oauth.authorize.pkce'));
  }
  if (askedState !== null && state === null) {
    return refuse('invalid_request', t('oauth.authorize.state'));
  }
  const resource = mcpResourceUrl(config);
  const resources = query.getAll('resource');
  const [askedResource] = resources;
  if (
    resources.length > 1 ||
    (askedResource !== undefined && normalizeResource(askedResource) !== resource)
  ) {
    return refuse('invalid_target', t('oauth.authorize.resource', { resource }));
  }

  const id = newSecret();
  await deps.oneTime.put<AuthorizationRequest>(
    requestKey(id),
    {
      clientId: client.id,
      redirectUri,
      codeChallenge: challenge,
      state,
      resource,
      scope: OAUTH_SCOPE,
      createdAt: deps.clock.now(),
    },
    AUTH_REQUEST_TTL_MS,
  );
  await touchClient(deps, client.id);
  return publicUrl(config, `/oauth/consent?request=${id}`);
}

/**
 * What the consent page shows for a pending request, to `user`, the person signed in now.
 * A request that expired, was already decided or whose client is gone is `not_found`.
 */
export async function getConsentRequest(
  deps: AppDeps,
  user: UserRow,
  id: string,
): Promise<OAuthConsentRequest> {
  const request = await deps.oneTime.peek<AuthorizationRequest>(requestKey(id));
  const client = request ? await getClient(deps.db.db, request.clientId) : undefined;
  if (!request || !client) throw expired();
  return {
    client_name: client.name,
    // Not stored at registration: it would be one more unverified claim to show.
    client_uri: null,
    redirect_host: redirectHost(request.redirectUri),
    scopes: request.scope.split(' '),
    user: { name: user.name ?? user.email ?? t('oauth.consent.unnamedUser'), email: user.email },
  };
}

/**
 * Records `user`'s answer to a pending request, which is used up whatever the answer. Denied,
 * the client gets `access_denied`. Approved, the client's grant for `user` is found or made, and
 * the client gets a single-use code that the token endpoint redeems within `AUTH_CODE_TTL_MS`.
 * Either way the answer goes back with the request's `state` and `iss`.
 */
export async function decideConsentRequest(
  deps: AppDeps,
  user: UserRow,
  id: string,
  approve: boolean,
): Promise<OAuthDecisionResult> {
  const request = await deps.oneTime.take<AuthorizationRequest>(requestKey(id));
  const client = request ? await getClient(deps.db.db, request.clientId) : undefined;
  if (!request || !client) throw expired();
  const { config } = deps;
  const { redirectUri, state } = request;

  if (!approve) {
    return {
      redirect_to: authorizationRedirect(config, redirectUri, { error: 'access_denied', state }),
    };
  }

  const grant = await findOrCreateGrant(deps, {
    clientId: client.id,
    userId: user.id,
    resource: request.resource,
    scope: request.scope,
  });
  const code = newSecret();
  await deps.oneTime.put<AuthorizationCode>(
    codeKey(code),
    {
      grantId: grant.id,
      clientId: client.id,
      userId: user.id,
      redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      scope: request.scope,
    },
    AUTH_CODE_TTL_MS,
  );
  await touchClient(deps, client.id);
  deps.logger.info(
    { client_id: client.id, user_id: user.id, grant_id: grant.id },
    'oauth grant approved',
  );
  return { redirect_to: authorizationRedirect(config, redirectUri, { code, state }) };
}
