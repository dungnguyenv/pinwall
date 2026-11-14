import { effectiveRole } from '../auth/roles.ts';
import type { UserRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';

/** Publishes one person may have in progress at once, whichever way they publish. */
export const INGESTS_PER_PERSON = 2;
/** Publishes this process runs at once, everyone's together; admins' publishes are not counted. */
export const INGESTS_AT_ONCE = 4;
/** The `Retry-After` of a publish refused for want of a place. */
export const INGEST_RETRY_AFTER_SECONDS = 10;

const ALL = 'ingest:all';
const personKey = (userId: string) => `ingest:user:${userId}`;

/** Who takes a place: the person, and what makes them an admin (`effectiveRole`). */
export type IngestActor = Pick<UserRow, 'id' | 'kind' | 'idp_role' | 'role_override'>;

/**
 * Takes a place for one more publish by `actor`: an upload URL's upload, a web upload, an inline
 * publish or a restore. Each one reads, hashes and stores files, so how many run at once is
 * bounded per person (`INGESTS_PER_PERSON`) and in all (`INGESTS_AT_ONCE`). Admins are held to
 * their own bound only, so that the owner can still publish and restore while others hold every
 * place of the instance. Without a place it throws 429 `rate_limited`, with `Retry-After`
 * (`details.retry_after_seconds`) and `details.reason` `publishes_running` (the person's own) or
 * `server_busy` (everyone's), before anything is read. Call the returned function once the publish
 * has ended, either way; only its first call gives the place back.
 */
export function takeIngestSlot(deps: AppDeps, actor: IngestActor): () => void {
  const { inFlight } = deps;
  const own = { key: personKey(actor.id), limit: INGESTS_PER_PERSON };
  const quotas =
    effectiveRole(actor) === 'admin' ? [own] : [{ key: ALL, limit: INGESTS_AT_ONCE }, own];
  const release = inFlight.take(quotas);
  if (release !== null) return release;
  const mine = inFlight.usedOf(own.key) >= INGESTS_PER_PERSON;
  throw new AppError(
    'rate_limited',
    429,
    mine ? t('publish.busy.person', { max: INGESTS_PER_PERSON }) : t('publish.busy.server'),
    {
      retry_after_seconds: INGEST_RETRY_AFTER_SECONDS,
      reason: mine ? 'publishes_running' : 'server_busy',
    },
  );
}
