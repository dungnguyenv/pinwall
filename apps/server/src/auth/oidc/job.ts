import type { AppDeps } from '../../deps.ts';
import { oidcErrorCode, oidcRuntime } from './client.ts';
import { type RecheckOutcome, recheckUser } from './recheck.ts';

export const RECHECK_JOB_NAME = 'access-recheck';
export const RECHECK_JOB_PERIOD_MS = 900_000;
/** Users one run re-checks at most; the longest unchecked go first. */
export const RECHECK_BATCH_LIMIT = 200;
/** Re-checks one run has in flight at once. */
const RECHECK_CONCURRENCY = 4;

export interface RecheckSummary {
  checked: number;
  ok: number;
  removed: number;
  /** A refused refresh token, or an answer without the role claims: the person signs in again. */
  signInRequired: number;
  transient: number;
}

/**
 * The IdP users of `issuer` the job should re-check now: due before the next run, still able to
 * use Pinwall, holding a refresh token and at least one live credential (a session that has not
 * expired, an API token neither revoked nor expired, or an OAuth grant not revoked). Someone with
 * no live credential cannot use Pinwall, so the IdP is not asked about them until they sign in.
 */
async function dueUserIds(deps: AppDeps, issuer: string): Promise<string[]> {
  const now = deps.clock.now();
  const dueBefore = now - deps.config.access.recheckIntervalMs + RECHECK_JOB_PERIOD_MS;
  const rows = await deps.db.db
    .selectFrom('users')
    .select('users.id')
    .where('users.kind', '=', 'oidc')
    .where('users.oidc_issuer', '=', issuer)
    .where('users.disabled_at', 'is', null)
    .where('users.idp_refresh_token', 'is not', null)
    .where((eb) =>
      eb.and([
        eb.or([eb('users.role_override', 'is', null), eb('users.role_override', '!=', 'blocked')]),
        eb.or([eb('users.idp_checked_at', 'is', null), eb('users.idp_checked_at', '<', dueBefore)]),
        eb.or([
          eb.exists(
            eb
              .selectFrom('sessions')
              .select('sessions.id_hash')
              .whereRef('sessions.user_id', '=', 'users.id')
              .where('sessions.expires_at', '>', now),
          ),
          eb.exists(
            eb
              .selectFrom('api_tokens')
              .select('api_tokens.id')
              .whereRef('api_tokens.user_id', '=', 'users.id')
              .where('api_tokens.revoked_at', 'is', null)
              .where((t) =>
                t.or([
                  t('api_tokens.expires_at', 'is', null),
                  t('api_tokens.expires_at', '>', now),
                ]),
              ),
          ),
          eb.exists(
            eb
              .selectFrom('oauth_grants')
              .select('oauth_grants.id')
              .whereRef('oauth_grants.user_id', '=', 'users.id')
              .where('oauth_grants.revoked_at', 'is', null),
          ),
        ]),
      ]),
    )
    // Never-checked users first on both dialects, which sort nulls differently.
    .orderBy((eb) => eb.fn.coalesce('users.idp_checked_at', eb.lit(0)))
    .orderBy('users.id')
    .limit(RECHECK_BATCH_LIMIT)
    .execute();
  return rows.map((row) => row.id);
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * One run of the access re-check: asks the IdP about every due user (see `dueUserIds`), a few at
 * a time, and returns what came of it. A user whose check fails unexpectedly counts as
 * transient and is tried again next run. While discovery fails, nobody is checked.
 */
export async function runAccessRecheck(deps: AppDeps): Promise<RecheckSummary> {
  const summary: RecheckSummary = {
    checked: 0,
    ok: 0,
    removed: 0,
    signInRequired: 0,
    transient: 0,
  };
  if (deps.config.oidc === null) return summary;
  let issuer: string;
  try {
    issuer = (await oidcRuntime(deps).configuration()).serverMetadata().issuer;
  } catch (error) {
    deps.logger.warn(
      { class: 'unavailable', code: oidcErrorCode(error) },
      'idp re-check skipped: discovery failed',
    );
    return summary;
  }

  await forEachLimited(await dueUserIds(deps, issuer), RECHECK_CONCURRENCY, async (userId) => {
    let outcome: RecheckOutcome;
    try {
      outcome = (await recheckUser(deps, userId)).outcome;
    } catch (err) {
      deps.logger.error({ user_id: userId, err }, 'idp re-check failed unexpectedly');
      outcome = 'transient';
    }
    summary.checked += 1;
    if (outcome === 'ok' || outcome === 'removed' || outcome === 'transient') summary[outcome] += 1;
    else if (outcome === 'sign_in_required') summary.signInRequired += 1;
  });
  if (summary.checked > 0) deps.logger.info(summary, 'access re-check');
  return summary;
}

/**
 * The OIDC side of `pinwall serve`; does nothing without OIDC. Discovers the IdP now, so a wrong
 * issuer shows in the log at start (logged, never thrown: sign-in tries again on use), and
 * schedules the access re-check every `RECHECK_JOB_PERIOD_MS`.
 */
export function startOidc(deps: AppDeps): void {
  const { oidc } = deps.config;
  if (oidc === null) return;
  oidcRuntime(deps)
    .configuration()
    .catch((error: unknown) => {
      deps.logger.error(
        { issuer: oidc.issuer, code: oidcErrorCode(error) },
        'OIDC discovery failed',
      );
    });
  deps.scheduler.every(RECHECK_JOB_NAME, RECHECK_JOB_PERIOD_MS, () =>
    runAccessRecheck(deps).then(() => {}),
  );
}
