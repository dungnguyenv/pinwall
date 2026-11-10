import type { Clock } from '../lib/clock.ts';

export interface RateLimiter {
  /**
   * Counts one attempt against `key`. At most `limit` attempts are allowed per `windowMs`;
   * when refused, `retryAfterMs` is how long until the window ends (0 when allowed).
   */
  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterMs: number };
}

/** How often, at most, `consume` scans for windows that ended. */
const SWEEP_EVERY_MS = 60_000;

/**
 * Fixed windows: the first attempt for a key opens a window of `windowMs`, and the count starts
 * again when it ends. Refused attempts are not counted, so hammering a key cannot extend its
 * lockout.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; endsAt: number }>();
  private nextSweepAt = 0;

  constructor(private readonly clock: Clock) {}

  /** Windows held right now, including ended ones that have not been swept yet. */
  get size(): number {
    return this.windows.size;
  }

  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): { allowed: boolean; retryAfterMs: number } {
    const now = this.clock.now();
    this.sweep(now);

    let window = this.windows.get(key);
    if (!window || now >= window.endsAt) {
      window = { count: 0, endsAt: now + windowMs };
      this.windows.set(key, window);
    }
    if (window.count >= limit) return { allowed: false, retryAfterMs: window.endsAt - now };
    window.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Keys can come from the network, so ended windows must not pile up. */
  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_EVERY_MS;
    for (const [key, window] of this.windows) {
      if (now >= window.endsAt) this.windows.delete(key);
    }
  }
}
