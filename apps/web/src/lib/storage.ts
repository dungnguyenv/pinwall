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
