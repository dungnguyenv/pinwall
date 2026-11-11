export interface FollowInput {
  /** Whether the viewer follows the latest version (`/a/:id`) rather than one it chose (`/a/:id/v/:n`). */
  follow: boolean;
  /** The version number on screen, null before the first one is shown. */
  shown: number | null;
  /** The artifact's current version number, null before the artifact is read. */
  current: number | null;
  /** Whether the reviewer is writing a comment. */
  composing: boolean;
}

/**
 * Which version a review shows once the current one changes, and which newer
 * one it only offers (`pending`) because the reviewer is mid-comment. A
 * follower moves to the current version; a draft holds it back from a newer
 * one, but not from an older one, which means the shown version was deleted.
 * A viewer of a chosen version stays on it.
 */
export function followVersion(i: FollowInput): { shown: number | null; pending: number | null } {
  const { follow, shown, current, composing } = i;
  if (!follow || current === null || current === shown) return { shown, pending: null };
  if (composing && shown !== null && current > shown) return { shown, pending: current };
  return { shown: current, pending: null };
}
