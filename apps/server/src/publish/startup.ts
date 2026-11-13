import { purgeExpiredGrants } from '../content/grants.ts';
import type { AppDeps } from '../deps.ts';
import { sweepBlobs, sweepBlobTemp } from '../domain/blobs.ts';
import { ensureDefaultProject } from '../domain/projects.ts';
import { pruneTombstones } from '../domain/tombstones.ts';

const CONTENT_CLEANUP_INTERVAL_MS = 3_600_000;
const BLOB_SWEEP_INTERVAL_MS = 600_000;

/**
 * The publishing side of `pinwall serve`, run once the server listens: makes sure the default
 * project exists, and schedules the hourly removal of expired tombstones and of content grants
 * expired for longer than `EXPIRED_GRANT_RETENTION_MS`, and the sweep of blobs no version
 * references every ten minutes (what a backup deferred, or what a crash left behind). The temp
 * files of puts a crash cut short go with that sweep, and once at start, since the first
 * scheduled run comes only after ten minutes.
 */
export async function startPublishing(deps: AppDeps): Promise<void> {
  await ensureDefaultProject(deps);
  // Housekeeping: a failure is logged, and the scheduled sweep tries again.
  await sweepBlobTemp(deps).catch((err: unknown) => {
    deps.logger.warn({ err }, 'Could not remove the temp files of unfinished uploads');
  });
  deps.scheduler.every('content-cleanup', CONTENT_CLEANUP_INTERVAL_MS, async () => {
    await purgeExpiredGrants(deps);
    await pruneTombstones(deps);
  });
  deps.scheduler.every('blob-sweep', BLOB_SWEEP_INTERVAL_MS, async () => {
    await sweepBlobs(deps);
    await sweepBlobTemp(deps);
  });
}
