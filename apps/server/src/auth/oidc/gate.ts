import type { Config } from '../../config/types.ts';
import type { UserRow } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { oidcRuntime } from './client.ts';
import { type RecheckResult, recheckUser } from './recheck.ts';

export { INLINE_RECHECK_TIMEOUT_MS } from './client.ts';

/** With a refresh token, an IdP user's credentials hold at most this long after a good check. */
export const MAX_IDP_STALENESS_MS = 86_400_000;
/** After an inline re-check fails transiently or times out, the next waits this long. */
export const INLINE_RETRY_BACKOFF_MS = 60_000;

/** Whether the IdP should be asked about `user` again: only IdP users, once per interval. */
export function isRecheckDue(user: UserRow, now: number, config: Config): boolean {
  return (
    user.kind === 'oidc' &&
    (user.idp_checked_at === null || now - user.idp_checked_at >= config.access.recheckIntervalMs)
  );
}

/**
 * When the last IdP check of `user` stops being recent enough to act on. With a refresh token
 * Pinwall can re-check, so access survives an IdP outage up to `MAX_IDP_STALENESS_MS` after the
 * check; without one it cannot, so access ends when a re-check falls due and the person signs in
 * again. A user never checked has no access: 0. Null for non-IdP users (the owner), whose access
 * never depends on the IdP. Anything handed to an IdP user (a content grant) ends by then.
 */
export function idpAccessDeadline(user: UserRow, config: Config): number | null {
  if (user.kind !== 'oidc') return null;
  if (user.idp_checked_at === null) return 0;
  const bound =
    user.idp_refresh_token !== null ? MAX_IDP_STALENESS_MS : config.access.recheckIntervalMs;
  return user.idp_checked_at + bound;
}

/** Whether the last IdP check of `user` is still current: before `idpAccessDeadline`. */
export function idpAccessCurrent(user: UserRow, now: number, config: Config): boolean {
  const deadline = idpAccessDeadline(user, config);
  return deadline === null || now < deadline;
}

/**
 * A refusal says whether the IdP could answer: `idpUnavailable` is true when the inline re-check
 * failed transiently, timed out or is backing off from such a failure, so asking again later may
 * let the user in; false when no check ran or the IdP's answer ended access.
 */
export type GateResult = { ok: true; user: UserRow } | { ok: false; idpUnavailable: boolean };

/**
 * The IdP access gate every credential passes. With `inline`, a due IdP user who has a refresh
 * token is re-checked first, waiting at most the runtime's inline timeout; then the user (as the
 * check left them) passes only while their last IdP check is current. Role and disabled checks
 * stay with the caller. Bearer requests pass `inline: false`, so they never wait on the IdP.
 */
export async function gateUser(
  deps: AppDeps,
  user: UserRow,
  opts: { inline: boolean },
): Promise<GateResult> {
  if (user.kind !== 'oidc') return { ok: true, user };
  let checked: InlineCheck = { user, idpUnavailable: false };
  if (
    opts.inline &&
    deps.config.oidc !== null &&
    user.idp_refresh_token !== null &&
    isRecheckDue(user, deps.clock.now(), deps.config)
  ) {
    checked = await inlineRecheck(deps, user);
  }
  return idpAccessCurrent(checked.user, deps.clock.now(), deps.config)
    ? { ok: true, user: checked.user }
    : { ok: false, idpUnavailable: checked.idpUnavailable };
}

/** The row an inline re-check left, and whether the IdP failed to answer it. */
interface InlineCheck {
  user: UserRow;
  idpUnavailable: boolean;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Re-checks `user` for a waiting request, unless an earlier inline check failed less than
 * `INLINE_RETRY_BACKOFF_MS` ago. Returns the row to judge the request by: the checked one, or
 * `user` unchanged, with `idpUnavailable`, when the check failed transiently, ran past the
 * timeout or was skipped for the backoff. A check that runs past the timeout is never aborted
 * (it may already hold a rotated refresh token): it finishes in the background and saves its
 * result.
 */
async function inlineRecheck(deps: AppDeps, user: UserRow): Promise<InlineCheck> {
  const runtime = oidcRuntime(deps);
  const unavailable: InlineCheck = { user, idpUnavailable: true };
  if ((runtime.inlineBackoffUntil.get(user.id) ?? 0) > deps.clock.now()) return unavailable;
  const pause = () =>
    runtime.inlineBackoffUntil.set(user.id, deps.clock.now() + INLINE_RETRY_BACKOFF_MS);

  const check = recheckUser(deps, user.id);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, runtime.inlineRecheckTimeoutMs, TIMED_OUT);
  });
  let result: RecheckResult | typeof TIMED_OUT;
  try {
    result = await Promise.race([check, timeout]);
  } catch (err) {
    // A database failure or a bug: the request goes on, still bound by the last good check.
    deps.logger.error({ user_id: user.id, err }, 'inline idp re-check failed');
    pause();
    return unavailable;
  } finally {
    clearTimeout(timer);
  }

  if (result === TIMED_OUT) {
    check.catch((err: unknown) => {
      deps.logger.error({ user_id: user.id, err }, 'inline idp re-check failed');
    });
    pause();
    return unavailable;
  }
  if (result.outcome === 'transient') {
    pause();
    return { user: result.user ?? user, idpUnavailable: true };
  }
  runtime.inlineBackoffUntil.delete(user.id);
  return { user: result.user ?? user, idpUnavailable: false };
}
