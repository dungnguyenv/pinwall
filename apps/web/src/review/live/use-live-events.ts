import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type LiveHandlers, openLiveStream, type StreamStatus } from './event-stream.ts';

/**
 * Follows the live updates at `path` while the component is mounted: one
 * stream per path, opened again when the path changes. A null path opens
 * nothing yet. The handlers may change on every render; events always reach
 * the latest ones. Without `EventSource` there are no live updates: `ended`.
 */
export function useLiveEvents(path: string | null, h: LiveHandlers): StreamStatus {
  const handlers = useRef(h);
  useLayoutEffect(() => {
    handlers.current = h;
  });
  // The status of the stream at `path`; another path's status is stale.
  const [state, setState] = useState<{ path: string | null; status: StreamStatus }>({
    path,
    status: 'connecting',
  });
  const supported = typeof EventSource === 'function';

  useEffect(() => {
    if (path === null || !supported) return;
    const stream = openLiveStream(path, {
      onEvent: (e) => handlers.current.onEvent(e),
      onStatus: (status) => {
        setState({ path, status });
        handlers.current.onStatus?.(status);
      },
      onResync: () => handlers.current.onResync?.(),
    });
    return () => stream.close();
  }, [path, supported]);

  if (!supported) return 'ended';
  return state.path === path ? state.status : 'connecting';
}
