/** One bound of `InFlight`: at most `limit` units under `key` at once. */
export interface InFlightQuota {
  key: string;
  limit: number;
}

/**
 * Work this process runs at once and must keep bounded, such as publishes being ingested or bytes
 * held in memory for a response, counted in units under free-form keys (give each kind a prefix,
 * `ingest:`, `review-html:`, so they never clash). Nothing waits: `take` either has room now or
 * says no, and the caller refuses the work or does it another way.
 */
export class InFlight {
  private readonly used = new Map<string, number>();

  /** How many units are taken under `key`. */
  usedOf(key: string): number {
    return this.used.get(key) ?? 0;
  }

  /**
   * Takes `units` under the key of each of `quotas` when every one of them has room for them, and
   * returns the function that gives them back (only its first call does). Null, taking nothing,
   * when one has no room.
   */
  take(quotas: readonly InFlightQuota[], units = 1): (() => void) | null {
    if (!quotas.every(({ key, limit }) => this.usedOf(key) + units <= limit)) return null;
    for (const { key } of quotas) this.used.set(key, this.usedOf(key) + units);
    let given = false;
    return () => {
      if (given) return;
      given = true;
      for (const { key } of quotas) {
        const left = this.usedOf(key) - units;
        if (left > 0) this.used.set(key, left);
        else this.used.delete(key);
      }
    };
  }
}
