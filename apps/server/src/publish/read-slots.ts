import { effectiveRole } from '../auth/roles.ts';
import type { AppDeps } from '../deps.ts';
import type { InFlightQuota } from '../infra/in-flight.ts';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import type { IngestActor } from './ingest-slots.ts';

/** Reads of whole stored files one person may have in progress at once. */
export const READS_PER_PERSON = 2;
/** Reads this process runs at once, everyone's together; admins' reads are not counted. */
export const READS_AT_ONCE = 4;
/** The `Retry-After` of a read refused for want of a place. */
export const READ_RETRY_AFTER_SECONDS = 3;

const ALL = 'read:all';
const personKey = (userId: string) => `read:user:${userId}`;

/** The bounds a read by `actor` counts toward: their own, and the instance's unless an admin's. */
function quotasOf(actor: IngestActor): InFlightQuota[] {
  const own = { key: personKey(actor.id), limit: READS_PER_PERSON };
  return effectiveRole(actor) === 'admin' ? [own] : [{ key: ALL, limit: READS_AT_ONCE }, own];
}

/**
 * Takes a place for one more read by `actor` of whole stored files into memory: `read_file`, the
 * pages `list_comments` locates threads on, and the files a merge diff compares. Each holds up to
 * a few megabytes of text, and its parsed or split forms, while it runs; the rate rules count
 * calls, not how many run at once. So how many run at once is bounded per person
 * (`READS_PER_PERSON`) and in all (`READS_AT_ONCE`), on the counter publishes use
 * (`deps.inFlight`), under keys of their own. Admins are held to their own bound only, as for
 * publishes. Null, taking nothing, without a place; otherwise call the returned function once
 * the read has ended, either way (only its first call gives the place back).
 */
export function tryReadSlot(deps: AppDeps, actor: IngestActor): (() => void) | null {
  return deps.inFlight.take(quotasOf(actor));
}

/**
 * Runs `work` in a place `tryReadSlot` gives `actor`, and gives the place back once it has ended,
 * whether it succeeded or failed. Without a place, `work` does not run: 429 `rate_limited`, with
 * `Retry-After` (`details.retry_after_seconds`) and `details.reason` `reads_running` (the
 * person's own) or `server_reads_busy` (everyone's).
 */
export async function inReadSlot<T>(
  deps: AppDeps,
  actor: IngestActor,
  work: () => Promise<T>,
): Promise<T> {
  const release = tryReadSlot(deps, actor);
  if (release === null) {
    const mine = deps.inFlight.usedOf(personKey(actor.id)) >= READS_PER_PERSON;
    throw new AppError(
      'rate_limited',
      429,
      mine ? t('read.busy.person', { max: READS_PER_PERSON }) : t('read.busy.server'),
      {
        retry_after_seconds: READ_RETRY_AFTER_SECONDS,
        reason: mine ? 'reads_running' : 'server_reads_busy',
      },
    );
  }
  try {
    return await work();
  } finally {
    release();
  }
}
