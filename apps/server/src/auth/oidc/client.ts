import {
  AuthorizationResponseError,
  allowInsecureRequests,
  ClientError,
  ClientSecretBasic,
  type Configuration,
  discovery,
  None,
  ResponseBodyError,
} from 'openid-client';
import type { Config } from '../../config/types.ts';
import type { AppDeps } from '../../deps.ts';
import { publicUrl } from '../../http/public-url.ts';
import { newSecret } from '../../lib/ids.ts';

/** Timeout of every request to the IdP: discovery, token, userinfo. */
export const OIDC_HTTP_TIMEOUT_SECONDS = 10;
/** How long a request waits for an inline re-check, unless a test shortens it. */
export const INLINE_RECHECK_TIMEOUT_MS = 5_000;

type OidcConfig = NonNullable<Config['oidc']>;

/** Per-process OIDC state, shared by sign-in and the access re-check. */
export interface OidcRuntime {
  /** The discovered client configuration, fetched once; a failed discovery is tried again. */
  configuration(): Promise<Configuration>;
  /** This process's lease holder id for re-checks. */
  readonly holder: string;
  /** Re-checks in progress, by user id, so concurrent requests share one refresh. */
  readonly inflight: Map<string, Promise<unknown>>;
  /** User id → epoch ms until which inline re-checks pause after a transient failure. */
  readonly inlineBackoffUntil: Map<string, number>;
  /** How long a request waits for an inline re-check. */
  inlineRecheckTimeoutMs: number;
}

/** Any failure to fetch or accept the IdP's discovery document. */
class OidcDiscoveryError extends Error {
  override readonly name = 'OidcDiscoveryError';

  constructor(cause: unknown) {
    super('OIDC discovery failed', { cause });
  }
}

const runtimes = new WeakMap<AppDeps, OidcRuntime>();

/** loadConfig allows an http: issuer only with PINWALL_OIDC_ALLOW_HTTP_ISSUER, and warns. */
const isHttpIssuer = (oidc: OidcConfig) => new URL(oidc.issuer).protocol === 'http:';

async function discover(oidc: OidcConfig): Promise<Configuration> {
  const clientAuth =
    oidc.clientSecret === undefined ? None() : ClientSecretBasic(oidc.clientSecret);
  try {
    return await discovery(new URL(oidc.issuer), oidc.clientId, undefined, clientAuth, {
      timeout: OIDC_HTTP_TIMEOUT_SECONDS,
      execute: isHttpIssuer(oidc) ? [allowInsecureRequests] : [],
    });
  } catch (error) {
    throw new OidcDiscoveryError(error);
  }
}

/** The OIDC runtime of `deps`, created on first use. Throws when OIDC is not configured. */
export function oidcRuntime(deps: AppDeps): OidcRuntime {
  const existing = runtimes.get(deps);
  if (existing) return existing;
  const oidc = deps.config.oidc;
  if (oidc === null) {
    throw new Error('OIDC is not configured: set PINWALL_OIDC_ISSUER and PINWALL_OIDC_CLIENT_ID');
  }
  let discovered: Promise<Configuration> | undefined;
  const runtime: OidcRuntime = {
    configuration() {
      if (discovered === undefined) {
        const attempt = discover(oidc);
        discovered = attempt;
        attempt.catch(() => {
          if (discovered === attempt) discovered = undefined;
        });
      }
      return discovered;
    },
    holder: newSecret(),
    inflight: new Map(),
    inlineBackoffUntil: new Map(),
    inlineRecheckTimeoutMs: INLINE_RECHECK_TIMEOUT_MS,
  };
  runtimes.set(deps, runtime);
  return runtime;
}

/** The redirect URI registered at the IdP, always on the public origin. */
export function callbackUrl(config: Config): string {
  return publicUrl(config, '/auth/oidc/callback');
}

/**
 * Where the IdP sends the browser back after signing someone out for "Use a different account":
 * a fixed route on the public origin, which operators register as a post-logout redirect URI.
 */
export function signedOutUrl(config: Config): string {
  return publicUrl(config, '/auth/oidc/signed-out');
}

/**
 * Authorization request parameters: the configured extra parameters, then the protected ones,
 * which no extra parameter can replace, then `prompt`. `prompt` keeps the extra values except
 * `none` (an interactive sign-in must be allowed to interact), adds `select_account` when asked,
 * and adds `consent` with it when offline_access is requested, since IdPs drop offline_access
 * from a prompted request without consent. It is left out when empty.
 */
export function buildAuthParams(
  oidc: OidcConfig,
  p: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    selectAccount: boolean;
  },
): Record<string, string> {
  const { prompt: extraPrompt, ...extra } = oidc.extraAuthParams;
  const params: Record<string, string> = {
    ...extra,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    scope: oidc.scopes.join(' '),
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
  };
  const prompt = new Set((extraPrompt ?? '').split(' ').filter((v) => v !== '' && v !== 'none'));
  if (p.selectAccount) {
    prompt.add('select_account');
    if (oidc.scopes.includes('offline_access')) prompt.add('consent');
  }
  if (prompt.size > 0) params.prompt = [...prompt].join(' ');
  return params;
}

export type OidcErrorClass = 'invalid_grant' | 'cancelled' | 'unavailable' | 'failed';

/** The IdP could not be reached in time, or answered with a server error. */
function isUnavailable(e: unknown): boolean {
  // fetch rejects with a plain TypeError when the connection fails; coded TypeErrors are bugs.
  if (e instanceof TypeError) return (e as { code?: unknown }).code === undefined;
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) return true;
  if (e instanceof ClientError) {
    if (e.code === 'OAUTH_TIMEOUT' || e.code === 'OAUTH_ABORT') return true;
    // A 5xx carries no OAuth error body to parse, so it arrives as a non-conform response.
    return e.cause instanceof Response && e.cause.status >= 500;
  }
  return false;
}

/**
 * What an OIDC failure means: `invalid_grant` (the IdP no longer accepts the grant),
 * `cancelled` (the person or IdP ended the sign-in), `unavailable` (transient: network,
 * timeout, 5xx, discovery) or `failed` (anything else).
 */
export function classifyOidcError(e: unknown): OidcErrorClass {
  if (e instanceof OidcDiscoveryError) return 'unavailable';
  if (e instanceof ResponseBodyError) {
    if (e.error === 'invalid_grant') return 'invalid_grant';
    return e.status >= 500 ? 'unavailable' : 'failed';
  }
  if (e instanceof AuthorizationResponseError) {
    return e.error === 'temporarily_unavailable' || e.error === 'server_error'
      ? 'unavailable'
      : 'cancelled';
  }
  return isUnavailable(e) ? 'unavailable' : 'failed';
}

/** What a logged error code may look like: a constant, never free text. */
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

const safeCode = (value: unknown): string | undefined =>
  typeof value === 'string' && ERROR_CODE.test(value) ? value : undefined;

/**
 * A fixed code that names an OIDC failure in a log line: the OAuth `error` value the IdP sent
 * (`invalid_client`), openid-client's code constant (`OAUTH_RESPONSE_IS_NOT_CONFORM`), the
 * network error code (`ECONNREFUSED`), or else the error's class name. Never a message, an
 * `error_description` or anything else that may carry a token, a code or a claim.
 */
export function oidcErrorCode(e: unknown): string {
  if (e instanceof OidcDiscoveryError) return oidcErrorCode(e.cause);
  if (e instanceof ResponseBodyError || e instanceof AuthorizationResponseError) {
    return safeCode(e.error) ?? e.code;
  }
  // fetch rejects with a TypeError whose cause holds the network error code.
  if (e instanceof TypeError) return safeCode((e.cause as { code?: unknown })?.code) ?? e.name;
  if (e instanceof Error) return safeCode((e as { code?: unknown }).code) ?? e.name;
  return 'unknown';
}
