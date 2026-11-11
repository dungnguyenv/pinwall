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
 * Whether the last IdP check of `user` is recent enough to act on. With a refresh token Pinwall
 * can re-check, so access survives an IdP outage up to `MAX_IDP_STALENESS_MS`; without one it
 * cannot, so access ends when a re-check falls due and the person signs in again. Non-IdP users
 * (the owner) are always current.
 */
export function idpAccessCurrent(user: UserRow, now: number, config: Config): boolean {
  if (user.kind !== 'oidc') return true;
  if (user.idp_checked_at === null) return false;
  const age = now - user.idp_checked_at;
  return user.idp_refresh_token !== null
    ? age < MAX_IDP_STALENESS_MS
    : age < config.access.recheckIntervalMs;
}

export type GateResult = { ok: true; user: UserRow } | { ok: false };

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
  let row = user;
  if (
    opts.inline &&
    deps.config.oidc !== null &&
    user.idp_refresh_token !== null &&
    isRecheckDue(user, deps.clock.now(), deps.config)
  ) {
    row = await inlineRecheck(deps, user);
  }
  return idpAccessCurrent(row, deps.clock.now(), deps.config)
    ? { ok: true, user: row }
    : { ok: false };
}

const TIMED_OUT = Symbol('timed out');

/**
 * Re-checks `user` for a waiting request, unless an earlier inline check failed less than
 * `INLINE_RETRY_BACKOFF_MS` ago. Returns the row to judge the request by: the checked one, or
 * `user` unchanged when the check failed transiently or ran past the timeout. A check that runs
 * past it is never aborted (it may already hold a rotated refresh token): it finishes in the
 * background and saves its result.
 */
async function inlineRecheck(deps: AppDeps, user: UserRow): Promise<UserRow> {
  const runtime = oidcRuntime(deps);
  if ((runtime.inlineBackoffUntil.get(user.id) ?? 0) > deps.clock.now()) return user;
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
    return user;
  } finally {
    clearTimeout(timer);
  }

  if (result === TIMED_OUT) {
    check.catch((err: unknown) => {
      deps.logger.error({ user_id: user.id, err }, 'inline idp re-check failed');
    });
    pause();
    return user;
  }
  if (result.outcome === 'transient') pause();
  else runtime.inlineBackoffUntil.delete(user.id);
  return result.user ?? user;
}
