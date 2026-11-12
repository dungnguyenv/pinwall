import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  type Configuration,
  calculatePKCECodeChallenge,
  fetchUserInfo,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import type { UserRow } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { endShareLinkStreams } from '../../domain/live.ts';
import { revokeShareLinksOf } from '../../domain/shares.ts';
import { safeEqual } from '../../lib/crypto.ts';
import { hashSecret } from '../../lib/ids.ts';
import { hasAccess } from '../roles.ts';
import { keepForAccountSwitch } from './account-switch.ts';
import {
  buildAuthParams,
  callbackUrl,
  classifyOidcError,
  oidcErrorCode,
  oidcRuntime,
} from './client.ts';
import { identityFromClaims, type OidcIdentity } from './identity.ts';
import { lacksGroupsClaim, lacksRoleClaims } from './policy.ts';
import { upsertOidcUser } from './users.ts';

/** How long a browser has to come back from the IdP. */
export const PENDING_LOGIN_TTL_MS = 600_000;

/** What `/start` keeps for `/callback`, under the hash of the request's `state`. */
export interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  selectAccount: boolean;
  /** `hashSecret` of the binding cookie of the browser that started the sign-in. */
  browserHash: string;
}

export type OidcFailure =
  | 'not_configured'
  | 'unavailable'
  | 'expired'
  | 'other_browser'
  | 'cancelled'
  | 'failed';

/** A sign-in that cannot go on; `returnTo` is where trying again should lead. */
export class OidcFlowError extends Error {
  override readonly name = 'OidcFlowError';

  constructor(
    readonly failure: OidcFailure,
    readonly returnTo: string,
    options?: { cause?: unknown },
  ) {
    super(`OIDC sign-in failed: ${failure}`, options);
  }
}

export type CallbackOutcome =
  | { kind: 'admitted'; user: UserRow; returnTo: string }
  | {
      kind: 'denied';
      user: UserRow;
      identity: OidcIdentity;
      returnTo: string;
      selectAccount: boolean;
      /** The ticket of the "Use a different account" link that signs out at the IdP, if any. */
      switchTicket: string | null;
    };

const pendingKey = (state: string) => `oidc:login:${hashSecret(state)}`;

/**
 * The error for `failure`, logged as a warning with the failure class and the cause's fixed
 * error code only: the cause itself may hold the state, the nonce, a code or claims, none of
 * which belong in a log.
 */
function flowError(
  deps: AppDeps,
  failure: OidcFailure,
  returnTo: string,
  cause?: unknown,
): OidcFlowError {
  const code = cause === undefined ? {} : { code: oidcErrorCode(cause) };
  deps.logger.warn({ failure, ...code }, 'oidc sign-in failed');
  return new OidcFlowError(failure, returnTo, cause === undefined ? undefined : { cause });
}

async function discovered(deps: AppDeps, returnTo: string): Promise<Configuration> {
  try {
    return await oidcRuntime(deps).configuration();
  } catch (error) {
    throw flowError(deps, 'unavailable', returnTo, error);
  }
}

/**
 * Starts a sign-in: fresh state, nonce and PKCE verifier, kept with `returnTo` and the hash of
 * the browser's binding secret for `PENDING_LOGIN_TTL_MS`. Returns the IdP authorization URL.
 */
export async function beginOidcSignIn(
  deps: AppDeps,
  p: { returnTo: string; selectAccount: boolean; browserSecret: string },
): Promise<string> {
  const { oidc } = deps.config;
  if (oidc === null) throw new OidcFlowError('not_configured', p.returnTo);
  const configuration = await discovered(deps, p.returnTo);
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  await deps.oneTime.put<PendingLogin>(
    pendingKey(state),
    {
      codeVerifier,
      nonce,
      returnTo: p.returnTo,
      selectAccount: p.selectAccount,
      browserHash: hashSecret(p.browserSecret),
    },
    PENDING_LOGIN_TTL_MS,
  );
  const params = buildAuthParams(oidc, {
    redirectUri: callbackUrl(deps.config),
    state,
    nonce,
    codeChallenge: await calculatePKCECodeChallenge(codeVerifier),
    selectAccount: p.selectAccount,
  });
  return buildAuthorizationUrl(configuration, params).href;
}

/**
 * Finishes a sign-in from the callback's raw query: takes the pending login (once), checks the
 * browser is the one that started it, redeems the code, reads the claims (userinfo over the ID
 * token) and records the user. A refused sign-in keeps its ID token for "Use a different
 * account" (`keepForAccountSwitch`). Throws `OidcFlowError` when the sign-in cannot finish.
 */
export async function finishOidcSignIn(
  deps: AppDeps,
  p: { query: string; browserSecret: string | undefined },
): Promise<CallbackOutcome> {
  const { config } = deps;
  if (config.oidc === null) throw new OidcFlowError('not_configured', '/');
  const state = new URLSearchParams(p.query).get('state');
  const pending = state ? await deps.oneTime.take<PendingLogin>(pendingKey(state)) : null;
  if (state === null || pending === null) throw flowError(deps, 'expired', '/');
  const { returnTo } = pending;
  const { browserSecret } = p;
  if (browserSecret === undefined || !safeEqual(hashSecret(browserSecret), pending.browserHash)) {
    throw flowError(deps, 'other_browser', returnTo);
  }

  const configuration = await discovered(deps, returnTo);
  // The redirect URI the IdP knows, whatever host the request came in on.
  const current = new URL(callbackUrl(config));
  current.search = p.query;
  let tokens: Awaited<ReturnType<typeof authorizationCodeGrant>>;
  try {
    tokens = await authorizationCodeGrant(configuration, current, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
  } catch (error) {
    const kind = classifyOidcError(error);
    const failure = kind === 'unavailable' || kind === 'cancelled' ? kind : 'failed';
    throw flowError(deps, failure, returnTo, error);
  }

  let claims: Record<string, unknown>;
  let identity: OidcIdentity;
  try {
    const idToken = tokens.claims();
    if (idToken === undefined) throw new Error('The token response has no ID token');
    claims = { ...idToken };
    if (configuration.serverMetadata().userinfo_endpoint !== undefined) {
      const userinfo = await fetchUserInfo(configuration, tokens.access_token, idToken.sub);
      claims = { ...claims, ...userinfo };
    }
    identity = identityFromClaims(claims, config.oidc.rolesClaim);
  } catch (error) {
    const failure = classifyOidcError(error) === 'unavailable' ? 'unavailable' : 'failed';
    throw flowError(deps, failure, returnTo, error);
  }
  logMissingRolesClaim(deps, claims);

  const result = await upsertOidcUser(deps, {
    issuer: configuration.serverMetadata().issuer,
    identity,
    refreshToken: tokens.refresh_token ?? null,
  });
  if (result.admitted && hasAccess(result.user)) {
    deps.logger.info({ user_id: result.user.id, created: result.created }, 'oidc sign-in');
    return { kind: 'admitted', user: result.user, returnTo };
  }
  deps.logger.info({ user_id: result.user.id }, 'oidc sign-in denied');
  // The IdP's whole answer earns no role: the person is out, as the access re-check would find,
  // and since this sign-in dropped their refresh token the re-check never will. What they shared
  // goes now. An answer that lacks a claim the rules read proves nothing, so it only refuses.
  if (!result.admitted && !lacksRoleClaims(config, claims)) {
    await revokeSharesOfDenied(deps, result.user.id);
  }
  const switchTicket = await keepForAccountSwitch(deps, configuration, {
    idToken: tokens.id_token,
    returnTo,
    browserSecret,
  });
  return {
    kind: 'denied',
    user: result.user,
    identity,
    returnTo,
    selectAccount: pending.selectAccount,
    switchTicket,
  };
}

/**
 * Warns, once per process, when group rules are set but a sign-in token carries no roles claim:
 * no group rule can match that person, which is easy to miss when the IdP never sends the claim
 * (a mapper or scope left out). Only the claim's name is logged, never a value.
 */
function logMissingRolesClaim(deps: AppDeps, claims: Record<string, unknown>): void {
  const runtime = oidcRuntime(deps);
  if (runtime.missingRolesClaimLogged || !lacksGroupsClaim(deps.config, claims)) return;
  runtime.missingRolesClaimLogged = true;
  deps.logger.warn(
    { claim: deps.config.oidc?.rolesClaim },
    'An OIDC sign-in token had no roles claim, so no group rule can match that person. ' +
      'If nobody gets in by group, make the identity provider send the claim that ' +
      'PINWALL_OIDC_ROLES_CLAIM names. Logged once.',
  );
}

/** Revokes the share links of a person a sign-in found out, and ends their live streams. */
async function revokeSharesOfDenied(deps: AppDeps, userId: string): Promise<void> {
  const { db, dialect } = deps.db;
  const linkIds = await db
    .transaction()
    .execute((trx) => revokeShareLinksOf(trx, dialect, userId, deps.clock.now()));
  for (const linkId of linkIds) endShareLinkStreams(deps, linkId);
  if (linkIds.length > 0) {
    deps.logger.info({ user_id: userId, share_links: linkIds.length }, 'share links revoked');
  }
}
