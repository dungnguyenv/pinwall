/**
 * A cap on the streams open at once under one key: a client address, a share link, a session.
 * Keys are free-form; give each kind a prefix (`address:`, `share-link:`) so they never clash.
 */
export interface StreamQuota {
  key: string;
  limit: number;
}

/**
 * The live-update streams open in this process, so that shutting down can end them (an open
 * stream holds its connection, and with it the server's close, until it ends), and how many are
 * open under each quota key, so that no client, link or session holds too many at once.
 */
export class LiveStreams {
  private readonly open = new Set<{ end: () => void; keys: readonly string[] }>();
  private readonly counts = new Map<string, number>();
  private closed = false;

  /** How many streams are open. */
  get size(): number {
    return this.open.size;
  }

  /** How many open streams count under `key`. */
  countOf(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /**
   * Whether one more stream fits under every one of `quotas`. Call it in the same synchronous run
   * as the `add` it decides on, so no other stream can take the place in between.
   */
  hasRoom(quotas: readonly StreamQuota[]): boolean {
    return quotas.every(({ key, limit }) => this.countOf(key) < limit);
  }

  /**
   * Tracks a stream that `end` closes, counted under the key of each of `quotas` (whose limits
   * `hasRoom` checks), until the returned function is called. Once `closeAll` has run, `end`
   * runs at once instead and nothing is counted.
   */
  add(end: () => void, quotas: readonly StreamQuota[] = []): () => void {
    if (this.closed) {
      end();
      return () => {};
    }
    // Its own object, so the same function added twice is two streams.
    const entry = { end, keys: quotas.map(({ key }) => key) };
    this.open.add(entry);
    for (const key of entry.keys) this.counts.set(key, this.countOf(key) + 1);
    return () => {
      if (!this.open.delete(entry)) return;
      for (const key of entry.keys) {
        const left = this.countOf(key) - 1;
        if (left > 0) this.counts.set(key, left);
        else this.counts.delete(key);
      }
    };
  }

  /** Ends every open stream, and every stream added from now on. */
  closeAll(): void {
    this.closed = true;
    const entries = [...this.open];
    this.open.clear();
    this.counts.clear();
    for (const { end } of entries) end();
  }
}
