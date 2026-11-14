import type { AppDeps } from '../deps.ts';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

/** Publishes one person may have in progress at once, whichever way they publish. */
export const INGESTS_PER_PERSON = 2;
/** Publishes this process runs at once, everyone's together. */
export const INGESTS_AT_ONCE = 4;
/** The `Retry-After` of a publish refused for want of a place. */
export const INGEST_RETRY_AFTER_SECONDS = 10;

const ALL = 'ingest:all';
const personKey = (userId: string) => `ingest:user:${userId}`;

/**
 * Takes a place for one more publish by `userId`: an upload URL's upload, a web upload, an inline
 * publish or a restore. Each one reads, hashes and stores files, so how many run at once is
 * bounded per person (`INGESTS_PER_PERSON`) and in all (`INGESTS_AT_ONCE`). Without a place it
 * throws 429 `rate_limited`, with `Retry-After` (`details.retry_after_seconds`) and
 * `details.reason` `publishes_running` (the person's own) or `server_busy` (everyone's), before
 * anything is read. Call the returned function once the publish has ended, either way.
 */
export function takeIngestSlot(deps: AppDeps, userId: string): () => void {
  const { inFlight } = deps;
  const release = inFlight.take([
    { key: ALL, limit: INGESTS_AT_ONCE },
    { key: personKey(userId), limit: INGESTS_PER_PERSON },
  ]);
  if (release !== null) return release;
  const own = inFlight.usedOf(personKey(userId)) >= INGESTS_PER_PERSON;
  throw new AppError(
    'rate_limited',
    429,
    own ? t('publish.busy.person', { max: INGESTS_PER_PERSON }) : t('publish.busy.server'),
    {
      retry_after_seconds: INGEST_RETRY_AFTER_SECONDS,
      reason: own ? 'publishes_running' : 'server_busy',
    },
  );
}
