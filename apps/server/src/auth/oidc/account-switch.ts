import { buildEndSessionUrl, type Configuration } from 'openid-client';
import type { AppDeps } from '../../deps.ts';
import { safeEqual } from '../../lib/crypto.ts';
import { hashSecret, newSecret } from '../../lib/ids.ts';
import { oidcErrorCode, oidcRuntime, signedOutUrl } from './client.ts';

/**
 * "Use a different account" after a refused sign-in. Asking the IdP for its account chooser is
 * not enough: Keycloak ignores `prompt=select_account` and signs the same person straight back
 * in from its single sign-on session. So when the IdP supports OpenID Connect RP-Initiated
 * Logout, Pinwall first ends that session (`/switch` → the IdP's end-session endpoint →
 * `/signed-out`), then asks the IdP to sign someone in again.
 *
 * The refused sign-in's ID token, which the IdP needs as `id_token_hint`, stays in memory for
 * `ACCOUNT_SWITCH_TTL_MS` under the hash of a ticket that only the no-access page's link holds,
 * bound to the browser's binding cookie. It is never put in a log line or anywhere the browser
 * can read it; the end-session redirect is the only place it goes.
 */

/**
 * How long a refused sign-in's switch link works, and how long the IdP then has to send the
 * browser back. The binding cookie lasts as long.
 */
export const ACCOUNT_SWITCH_TTL_MS = 600_000;

/** What a refused sign-in keeps for its switch link, under the hash of the link's ticket. */
interface KeptForSwitch {
  /** Sent to the IdP as `id_token_hint`, and nowhere else. */
  idToken: string;
  returnTo: string;
  /** `hashSecret` of the binding cookie of the browser that was refused. */
  browserHash: string;
}

/** What `/switch` keeps for `/signed-out`, under the hash of the sign-out request's `state`. */
interface PendingSignOut {
  returnTo: string;
  browserHash: string;
}

/** Why a switch went on without the IdP's sign-out. */
type Fallback = 'expired' | 'other_browser' | 'end_session_failed';

const ticketKey = (ticket: string) => `oidc:switch:${hashSecret(ticket)}`;
const signOutKey = (state: string) => `oidc:signed-out:${hashSecret(state)}`;

/** A ticket or state as `newSecret()` makes them. */
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const matchesBrowser = (browserSecret: string | undefined, browserHash: string): boolean =>
  browserSecret !== undefined && safeEqual(hashSecret(browserSecret), browserHash);

/** Logs why the switch goes on without the IdP's sign-out, with fixed values only. */
function fellBack(
  deps: AppDeps,
  step: 'switch' | 'signed_out',
  reason: Fallback,
  extra: { code?: string } = {},
): null {
  deps.logger.info({ step, reason, ...extra }, 'oidc account switch fell back');
  return null;
}

/**
 * Keeps a refused sign-in's ID token for its "Use a different account" link, when the IdP has an
 * `end_session_endpoint`. Returns the link's ticket, or null when there is nothing to keep.
 */
export async function keepForAccountSwitch(
  deps: AppDeps,
  configuration: Configuration,
  p: { idToken: string | undefined; returnTo: string; browserSecret: string },
): Promise<string | null> {
  if (p.idToken === undefined || !configuration.serverMetadata().end_session_endpoint) {
    return null;
  }
  const ticket = newSecret();
  await deps.oneTime.put<KeptForSwitch>(
    ticketKey(ticket),
    { idToken: p.idToken, returnTo: p.returnTo, browserHash: hashSecret(p.browserSecret) },
    ACCOUNT_SWITCH_TTL_MS,
  );
  return ticket;
}

/**
 * Starts signing a refused person out at the IdP: takes what their sign-in kept under `ticket`
 * (once) and checks the browser is the one that was refused. Returns the IdP's end-session URL
 * with that ID token as `id_token_hint`, the client id, Pinwall's fixed post-logout redirect URI
 * and a fresh `state`, nothing taken from the request. Null when the IdP cannot be asked: the
 * caller then asks it to choose an account instead.
 */
export async function beginAccountSwitch(
  deps: AppDeps,
  p: { ticket: string | undefined; browserSecret: string | undefined },
): Promise<string | null> {
  const kept =
    p.ticket !== undefined && SECRET.test(p.ticket)
      ? await deps.oneTime.take<KeptForSwitch>(ticketKey(p.ticket))
      : null;
  if (kept === null) return fellBack(deps, 'switch', 'expired');
  if (!matchesBrowser(p.browserSecret, kept.browserHash)) {
    return fellBack(deps, 'switch', 'other_browser');
  }

  const state = newSecret();
  let location: string;
  try {
    const configuration = await oidcRuntime(deps).configuration();
    location = buildEndSessionUrl(configuration, {
      id_token_hint: kept.idToken,
      post_logout_redirect_uri: signedOutUrl(deps.config),
      state,
    }).href;
  } catch (error) {
    // No error text: only the fixed code, which never carries the token.
    return fellBack(deps, 'switch', 'end_session_failed', { code: oidcErrorCode(error) });
  }
  await deps.oneTime.put<PendingSignOut>(
    signOutKey(state),
    { returnTo: kept.returnTo, browserHash: kept.browserHash },
    ACCOUNT_SWITCH_TTL_MS,
  );
  deps.logger.info('oidc account switch: signing out at the IdP');
  return location;
}

/**
 * The browser is back from the IdP's sign-out: takes the pending sign-out under `state` (once)
 * and checks the browser is the one that left. Returns where the next sign-in should lead, or
 * null when this is not a return Pinwall started.
 */
export async function finishAccountSwitch(
  deps: AppDeps,
  p: { state: string | undefined; browserSecret: string | undefined },
): Promise<string | null> {
  const pending =
    p.state !== undefined && SECRET.test(p.state)
      ? await deps.oneTime.take<PendingSignOut>(signOutKey(p.state))
      : null;
  if (pending === null) return fellBack(deps, 'signed_out', 'expired');
  if (!matchesBrowser(p.browserSecret, pending.browserHash)) {
    return fellBack(deps, 'signed_out', 'other_browser');
  }
  return pending.returnTo;
}
