import type { CommentThread } from '../../api/dto.ts';
import { pinNumbers, threadsForVersion } from '../comments/threads.ts';

/*
 * The comments of a comparison. A version's threads are what its review page
 * shows: those written on it or on an older version. The older version's
 * threads are all on the newer one's page too, so each thread is listed once,
 * under the older of the two versions that shows it, numbered as that
 * version's page numbers it, and opened on that page.
 */

/** The threads listed under one of the two versions. */
export interface VersionThreads {
  /** The version: the review page the threads are numbered by and open on. */
  version: number;
  /** Its threads in pin order, whatever their status. */
  threads: CommentThread[];
  /** Each thread's pin number on that version's review page. */
  numbers: Map<string, number>;
}

/**
 * The threads of `pair`, whichever way round it is: the older version's (its
 * page's), then the newer version's that the older one does not show, those
 * written after the older version.
 */
export function compareThreads(
  list: CommentThread[],
  pair: { from: number; to: number },
): { older: VersionThreads; newer: VersionThreads } {
  const older = Math.min(pair.from, pair.to);
  const newer = Math.max(pair.from, pair.to);
  const olderPage = threadsForVersion(list, older);
  const newerPage = threadsForVersion(list, newer);
  return {
    older: { version: older, threads: olderPage, numbers: pinNumbers(olderPage) },
    newer: {
      version: newer,
      threads: newerPage.filter((thread) => thread.version.number > older),
      numbers: pinNumbers(newerPage),
    },
  };
}

/**
 * Whether the change from `older` to `newer` resolved `thread`: it was resolved in the newer
 * version or one between the two.
 */
export function resolvedBetween(
  thread: CommentThread,
  range: { older: number; newer: number },
): boolean {
  const resolvedIn = thread.resolved_in_version?.number;
  return (
    thread.status === 'resolved' &&
    resolvedIn !== undefined &&
    resolvedIn > range.older &&
    resolvedIn <= range.newer
  );
}
