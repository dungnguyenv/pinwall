import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** Below 768 px the sidebar becomes a drawer. */
export const PHONE_QUERY = '(max-width: 767px)';

/** Whether the media query `q` matches now; re-renders when that changes. */
export function useMediaQuery(q: string): boolean {
  const list = useMemo(() => window.matchMedia(q), [q]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [list],
  );
  return useSyncExternalStore(
    subscribe,
    () => list.matches,
    () => false,
  );
}
