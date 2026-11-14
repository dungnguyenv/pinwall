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
/** The shortest time a publish may hold its place (`ingestDeadlineMs`). */
const INGEST_DEADLINE_MIN_MS = 10 * 60_000;
/** The average rate below which an upload of `PINWALL_MAX_UPLOAD_BYTES` misses its deadline. */
const INGEST_MIN_BYTES_PER_SECOND = 64 * 1024;

const ALL = 'ingest:all';
const personKey = (userId: string) => `ingest:user:${userId}`;

/** Who takes a place: the person, and what makes them an admin (`effectiveRole`). */
export type IngestActor = Pick<UserRow, 'id' | 'kind' | 'idp_role' | 'role_override'>;

/**
 * How long one publish may hold its place: the time an upload of `maxUploadBytes`
 * (`PINWALL_MAX_UPLOAD_BYTES`) takes at 64 KiB/s, and never less than 10 minutes. It bounds a
 * client that trickles its body, or stalls just short of the idle timeout, which would otherwise
 * keep its place for as long as it likes.
 */
export function ingestDeadlineMs(maxUploadBytes: number): number {
  return Math.max(
    INGEST_DEADLINE_MIN_MS,
    Math.ceil((maxUploadBytes * 1000) / INGEST_MIN_BYTES_PER_SECOND),
  );
}

/**
 * Takes a place for one more publish by `actor`: an upload URL's upload, a web upload, an inline
 * publish or a restore. Each one reads, hashes and stores files, so how many run at once is
 * bounded per person (`INGESTS_PER_PERSON`) and in all (`INGESTS_AT_ONCE`). Admins are held to
 * their own bound only, so that the owner can still publish and restore while others hold every
 * place of the instance. Without a place it throws 429 `rate_limited`, with `Retry-After`
 * (`details.retry_after_seconds`) and `details.reason` `publishes_running` (the person's own) or
 * `server_busy` (everyone's), before anything is read. Call the returned function once the publish
 * has ended, either way; only its first call gives the place back. Prefer `inIngestSlot`, which
 * also bounds how long the place is held.
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

/**
 * Runs `work` in a place `takeIngestSlot` gives `actor`, for at most `deps.ingestDeadlineMs`.
 * Without a place, `abandon` runs and the 429 is thrown.
 *
 * When the deadline passes first, the place is given back at once, `deadline` is aborted with the
 * 408 `request_timeout` (`details.reason` `publish_deadline`), and `abandon` gets that 408 to end
 * what `work` waits on with it, such as its client's body. `work` must then fail, removing what
 * it staged, and it fails with that 408 whatever it failed with: it checks `deadline` before it
 * commits, so only a commit already under way can still succeed. Otherwise the place is given
 * back once `work` has ended, either way.
 */
export async function inIngestSlot<T>(
  deps: AppDeps,
  actor: IngestActor,
  abandon: ((error?: Error) => void) | null,
  work: (deadline: AbortSignal) => Promise<T>,
): Promise<T> {
  let release: () => void;
  try {
    release = takeIngestSlot(deps, actor);
  } catch (error) {
    abandon?.();
    throw error;
  }
  const deadline = new AbortController();
  const ms = deps.ingestDeadlineMs;
  const timer = setTimeout(() => {
    const timedOut = publishTimedOut(ms);
    deadline.abort(timedOut);
    release();
    abandon?.(timedOut);
  }, ms);
  try {
    return await work(deadline.signal);
  } catch (error) {
    throw deadline.signal.aborted ? deadline.signal.reason : error;
  } finally {
    clearTimeout(timer);
    release();
  }
}

/** The 408 of a publish that held its place for `ms`, its deadline. */
function publishTimedOut(ms: number): AppError {
  return new AppError(
    'request_timeout',
    408,
    t('publish.deadline', { minutes: Math.max(1, Math.floor(ms / 60_000)) }),
    { reason: 'publish_deadline', deadline_seconds: Math.ceil(ms / 1000) },
  );
}
