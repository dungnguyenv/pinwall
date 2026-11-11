import type { Clock } from '../lib/clock.ts';

/** Short-lived values that can be redeemed once: upload sessions, OAuth codes, preview tokens. */
export interface OneTimeStore {
  /**
   * Stores `value` for `ttlMs`, replacing any value under `key` (and its group). A `group`, such
   * as the user the value works for, lets `deleteGroup` remove it along with the rest.
   */
  put<T>(key: string, value: T, ttlMs: number, opts?: { group?: string }): Promise<void>;
  /** Returns the value and removes it, so the next call gets null; null once it has expired. */
  take<T>(key: string): Promise<T | null>;
  /** Returns the value without removing it. */
  peek<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  /** Removes every value put in `group`; returns how many had not expired. */
  deleteGroup(group: string): Promise<number>;
}

/** How often, at most, `put` scans for entries that expired without ever being taken. */
const SWEEP_EVERY_MS = 60_000;

export class InMemoryOneTimeStore implements OneTimeStore {
  private readonly entries = new Map<
    string,
    { value: unknown; expiresAt: number; group: string | undefined }
  >();
  private nextSweepAt = 0;

  constructor(private readonly clock: Clock) {}

  /** Entries held right now, including expired ones that have not been swept yet. */
  get size(): number {
    return this.entries.size;
  }

  async put<T>(key: string, value: T, ttlMs: number, opts?: { group?: string }): Promise<void> {
    const now = this.clock.now();
    this.sweep(now);
    this.entries.set(key, { value, expiresAt: now + ttlMs, group: opts?.group });
  }

  async take<T>(key: string): Promise<T | null> {
    const value = this.read<T>(key);
    this.entries.delete(key);
    return value;
  }

  async peek<T>(key: string): Promise<T | null> {
    return this.read<T>(key);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** A scan: groups are deleted rarely (a revocation), and the store holds few entries. */
  async deleteGroup(group: string): Promise<number> {
    const now = this.clock.now();
    let live = 0;
    for (const [key, entry] of this.entries) {
      if (entry.group !== group) continue;
      if (now < entry.expiresAt) live += 1;
      this.entries.delete(key);
    }
    return live;
  }

  /** A value is live for `ttlMs` from `put`: it is gone at `expiresAt` itself. */
  private read<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.clock.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  /** Without this, values nobody redeems would stay in memory for the life of the process. */
  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_EVERY_MS;
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}
