import { LIVE_EVENT_TYPES, LiveEvent } from '../../api/dto.ts';

/**
 * How long to wait before each new connection once the browser has given up
 * on one, by attempt; the last step repeats. An open connection starts over.
 */
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;

/**
 * The wait before reconnect `attempt` (counting from 0): its step, give or
 * take 20 %, so tabs cut off together do not all come back at once.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  // Past the end of the ladder, its last step.
  const step = RECONNECT_DELAYS_MS[Math.max(attempt, 0)] ?? RECONNECT_DELAYS_MS[4];
  return Math.round(step * (0.8 + 0.4 * random()));
}

/**
 * `connecting` until the first open; `reconnecting` from any error until the
 * next open; `ended` for good, once the artifact is deleted or the server
 * refuses this browser the stream.
 */
export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';

export interface LiveHandlers {
  /** A change, parsed with `LiveEvent`. */
  onEvent(e: LiveEvent): void;
  /** Every change of status after the initial `connecting`. */
  onStatus?(s: StreamStatus): void;
  /**
   * Events may have been missed, because the server does not replay what was
   * sent while the connection was down: read the artifact and threads again.
   * Called when a connection opens after an error, and when the stream ends
   * because the server refuses it, so that reading again shows why.
   */
  onResync?(): void;
}

/** `EventSource.CLOSED`: the browser gave up and will not retry by itself. */
const CLOSED = 2;

/**
 * What a stream request answers once access is gone: the session ended (401),
 * the request is not one this stream serves (403), or the artifact or link no
 * longer exists (404, 410). Anything else, a rate limit or a proxy error
 * during a restart among them, is worth another try later.
 */
const REFUSED = new Set([401, 403, 404, 410]);

/** Whether the server now refuses this browser the stream at `url`. No answer counts as no. */
async function refused(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    return REFUSED.has(response.status);
  } catch {
    return false;
  }
}

function parseEvent(data: unknown): LiveEvent | null {
  if (typeof data !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = LiveEvent.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Follows the live updates at `path` (a same-origin stream route) until
 * `close()`.
 *
 * The browser reconnects by itself after a dropped connection or a stream the
 * server ended (it sent `retry: 5000`). When it gives up instead, after an
 * error status, a new `EventSource` follows on the `RECONNECT_DELAYS_MS`
 * ladder. Meanwhile a HEAD of the same path asks whether the server still
 * serves this browser: when it refuses (see `REFUSED`) the stream ends rather
 * than retrying forever. Any open after an error resyncs.
 */
export function openLiveStream(
  path: string,
  h: LiveHandlers,
  o: { random?: () => number } = {},
): { close(): void } {
  const random = o.random ?? Math.random;
  const url = new URL(path, location.href).href;
  let source: EventSource | null = null;
  let status: StreamStatus = 'connecting';
  let attempt = 0;
  /** An error since the last open: events may have been lost. */
  let missed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** Bumped by each access check and each open, so a check only counts if nothing came after it. */
  let generation = 0;

  function setStatus(s: StreamStatus): void {
    if (s === status) return;
    status = s;
    h.onStatus?.(s);
  }

  function stop(): void {
    stopped = true;
    clearTimeout(timer);
    source?.close();
    source = null;
  }

  function end(): void {
    stop();
    setStatus('ended');
  }

  function checkAccess(): void {
    const check = ++generation;
    void refused(url).then((isRefused) => {
      if (!isRefused || stopped || check !== generation) return;
      end();
      h.onResync?.();
    });
  }

  function connect(): void {
    const es = new EventSource(path);
    source = es;

    const onMessage = (event: Event) => {
      if (es !== source) return;
      const e = parseEvent((event as MessageEvent).data);
      if (e === null) return;
      h.onEvent(e);
      // Unless the handler already closed the stream, which then reports nothing more.
      if (e.type === 'artifact.deleted' && !stopped) end();
    };
    for (const type of LIVE_EVENT_TYPES) es.addEventListener(type, onMessage);

    es.addEventListener('open', () => {
      if (es !== source) return;
      generation += 1;
      setStatus('open');
      if (!missed) return;
      missed = false;
      attempt = 0;
      h.onResync?.();
    });

    es.addEventListener('error', () => {
      if (es !== source) return;
      missed = true;
      setStatus('reconnecting');
      // Still connecting: the browser is retrying by itself.
      if (es.readyState !== CLOSED) return;
      es.close();
      source = null;
      timer = setTimeout(connect, reconnectDelay(attempt, random));
      attempt += 1;
      checkAccess();
    });
  }

  connect();
  return { close: stop };
}
