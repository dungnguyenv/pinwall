import type { AppDeps } from '../deps.ts';
import { startOidc } from './oidc/job.ts';
import { purgeExpiredSessions } from './sessions.ts';
import { announceSetupLink } from './setup.ts';

const AUTH_CLEANUP_INTERVAL_MS = 3_600_000;

/**
 * The sign-in side of `pinwall serve`, run once the server listens: logs the setup link while
 * no owner exists, schedules the hourly removal of expired sessions, and starts OIDC (discovery
 * and the access re-check job) when it is configured. Returns the setup link it logged, or null,
 * so `serve` can also show it to a person reading the terminal.
 */
export async function startAuth(deps: AppDeps): Promise<string | null> {
  const setupUrl = await announceSetupLink(deps);
  deps.scheduler.every('auth-cleanup', AUTH_CLEANUP_INTERVAL_MS, async () => {
    await purgeExpiredSessions(deps);
  });
  startOidc(deps);
  return setupUrl;
}
