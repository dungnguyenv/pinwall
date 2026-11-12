import type { AppDeps } from '../deps.ts';
import { CLIENT_IDLE_MS, OAUTH_CLEANUP_PERIOD_MS } from './constants.ts';

/**
 * Deletes expired OAuth tokens, then clients unused for `CLIENT_IDLE_MS` (never used counts from
 * registration); their grants and tokens go with them by cascade. Returns how many expired
 * tokens and idle clients it deleted. A deleted client re-registers when it next connects.
 */
export async function purgeOAuth(deps: AppDeps): Promise<{ tokens: number; clients: number }> {
  const { db } = deps.db;
  const now = deps.clock.now();
  const tokens = await db
    .deleteFrom('oauth_tokens')
    .where('expires_at', '<=', now)
    .executeTakeFirst();
  const clients = await db
    .deleteFrom('oauth_clients')
    .where((eb) => eb(eb.fn.coalesce('last_used_at', 'created_at'), '<=', now - CLIENT_IDLE_MS))
    .executeTakeFirst();
  return { tokens: Number(tokens.numDeletedRows), clients: Number(clients.numDeletedRows) };
}

/** Schedules `purgeOAuth` every `OAUTH_CLEANUP_PERIOD_MS`; `startAuth` calls it. */
export function startOAuth(deps: AppDeps): void {
  deps.scheduler.every('oauth-cleanup', OAUTH_CLEANUP_PERIOD_MS, async () => {
    await purgeOAuth(deps);
  });
}
