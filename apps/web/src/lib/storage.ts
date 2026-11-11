import { useCallback, useState } from 'react';

/*
 * The only place the app touches browser storage. Safari's private mode,
 * blocked site data and a full quota all make localStorage throw; then
 * preferences fall back to their defaults and live in memory.
 */

/** The stored value of `key` when it is one of `allowed`, else `fallback`. */
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    return fallback;
  }
  return allowed.find((value) => value === stored) ?? fallback;
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is unavailable: the caller's in-memory value still applies.
  }
}

/**
 * The text stored under `key`, or null when there is none, when it is longer
 * than `max` (it cannot be what the app wrote), or when storage is
 * unavailable. `session` reads this tab's sessionStorage instead of
 * localStorage.
 */
export function readText(key: string, o: { session?: boolean; max?: number } = {}): string | null {
  let stored: string | null;
  try {
    stored = (o.session ? window.sessionStorage : window.localStorage).getItem(key);
  } catch {
    return null;
  }
  if (stored === null || (o.max !== undefined && stored.length > o.max)) return null;
  return stored;
}

/** Stores `value` under `key`; null removes it. Never throws: without storage the write is lost. */
export function writeText(key: string, value: string | null, o: { session?: boolean } = {}): void {
  try {
    const area = o.session ? window.sessionStorage : window.localStorage;
    if (value === null) area.removeItem(key);
    else area.setItem(key, value);
  } catch {
    // Storage is unavailable: the caller's in-memory value still applies.
  }
}

/**
 * A preference kept across visits under `key`. With `key` null it lives in
 * memory only. A new `key` reads that key's stored value.
 */
export function usePref<T extends string>(
  key: string | null,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const read = (k: string | null) => (k === null ? fallback : readPref(k, allowed, fallback));
  const [state, setState] = useState(() => ({ key, value: read(key) }));

  let value = state.value;
  if (state.key !== key) {
    // Adjusting state during render: React re-renders at once with the new key's value.
    value = read(key);
    setState({ key, value });
  }

  const set = useCallback(
    (next: T) => {
      setState({ key, value: next });
      if (key !== null) writePref(key, next);
    },
    [key],
  );
  return [value, set];
}
