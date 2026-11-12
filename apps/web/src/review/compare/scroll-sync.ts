/** One of the two versions being compared: the older side (`from`) or the newer (`to`). */
export type Side = 'from' | 'to';

export interface ScrollSync {
  /** Makes `side` the frame whose scrolling the other follows. */
  lead(side: Side): void;
  setEnabled(on: boolean): void;
  /**
   * What to do with a scroll reported by `side`: scroll the other side to the
   * same fractions, or nothing. Only the leader is mirrored, so the follower's
   * own report of the scroll it was sent never echoes back.
   */
  scrolled(
    side: Side,
    f: { x: number; y: number },
  ): { side: Side; f: { x: number; y: number } } | null;
}

/** Keeps two frames scrolled alike, following whichever one the reviewer is using. */
export function createScrollSync(): ScrollSync {
  let leader: Side | null = null;
  let enabled = true;
  return {
    lead(side) {
      leader = side;
    },
    setEnabled(on) {
      enabled = on;
    },
    scrolled(side, f) {
      if (!enabled || side !== leader) return null;
      return { side: side === 'from' ? 'to' : 'from', f: { x: f.x, y: f.y } };
    },
  };
}
