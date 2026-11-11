import { LiveEvent } from '@pinwall/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../app.ts';
import type { PinwallEvent } from '../infra/event-bus.ts';
import { AppError } from '../lib/errors.ts';

/**
 * How often an open stream gets a heartbeat comment, well inside the 100 s after which proxies
 * drop an idle connection. Access is checked again at each one.
 */
export const SSE_HEARTBEAT_MS = 25_000;
/** How far, in bytes past what the stream holds, a reader may fall behind before it is cut off. */
export const SSE_MAX_BUFFERED_BYTES = 1_048_576;
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

/** How long a browser waits before it reconnects a stream that ended or broke. */
const RETRY_MS = 5000;
/** What the stream holds, in bytes, before it counts its reader as behind. */
const HIGH_WATER_BYTES = 65_536;
const PING = ': ping\n\n';

/** What a stream does with an event: send it, leave it out, or send it and end. */
export type Forward = 'send' | 'skip' | 'send-and-close';

export interface LiveStreamOptions {
  /** The `EventBus` topic the stream follows. */
  topic: string;
  forward(e: LiveEvent): Forward;
  /** What the reader gets of an event `forward` lets through; the event as it is without it. */
  redact?(e: LiveEvent): LiveEvent;
  /** Asked at every heartbeat; false or a throw closes the stream. */
  stillAllowed(): Promise<boolean>;
}

/** The Node adapter's response, through which a reader that fell behind is cut off. */
function nodeResponseOf(c: Context<AppEnv>): { destroy(): void } | undefined {
  const env = c.env as { outgoing?: { destroy(): void } } | undefined;
  return env?.outgoing;
}

/**
 * A `text/event-stream` response that follows `o.topic` on the event bus. It opens with
 * `retry: 5000`; each bus event that passes `LiveEvent` and `o.forward` goes out as
 * `event: <type>` and `data: <json>`; every `SSE_HEARTBEAT_MS` a `: ping` comment goes out and
 * `o.stillAllowed` is asked again. The stream ends, unsubscribing and stopping its timer, when
 * an event says so, access is gone, the client goes away, the server shuts down (`closeDeps`),
 * or the reader falls more than `SSE_MAX_BUFFERED_BYTES` behind, which also cuts its connection.
 */
export function liveStream(c: Context<AppEnv>, o: LiveStreamOptions): Response {
  // Hono answers HEAD with the GET handler and drops the body unread, so a stream made for one
  // would never end.
  if (c.req.method === 'HEAD') return new Response(null, { headers: SSE_HEADERS });
  const { events, liveStreams, logger } = c.var.deps;
  const { signal } = c.req.raw;
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let checking = false;
  let unsubscribe = (): void => {};
  let untrack = (): void => {};
  let timer: ReturnType<typeof setInterval> | undefined;

  /**
   * Ends the stream, once. `end` lets the reader have what is queued, `cut` drops it and the
   * connection, `cancelled` is for a reader that already let go.
   */
  function close(how: 'end' | 'cut' | 'cancelled'): void {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(timer);
    untrack();
    signal.removeEventListener('abort', onAbort);
    if (how === 'end') {
      controller.close();
    } else if (how === 'cut') {
      const response = nodeResponseOf(c);
      // Destroying the response makes the adapter cancel the stream, dropping what is queued.
      if (response) response.destroy();
      else controller.error(new Error('The reader fell too far behind'));
    }
  }

  function onAbort(): void {
    close('end');
  }

  function send(text: string): void {
    if (closed) return;
    controller.enqueue(encoder.encode(text));
    if ((controller.desiredSize ?? 0) < -SSE_MAX_BUFFERED_BYTES) {
      logger.warn({ topic: o.topic }, 'live stream reader fell behind; cut off');
      close('cut');
    }
  }

  function onEvent(raw: PinwallEvent): void {
    const parsed = LiveEvent.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ topic: o.topic, type: raw.type }, 'invalid live event dropped');
      return;
    }
    const action = o.forward(parsed.data);
    if (action === 'skip') return;
    const event = o.redact ? o.redact(parsed.data) : parsed.data;
    send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (action === 'send-and-close') close('end');
  }

  async function heartbeat(): Promise<void> {
    send(PING);
    // A check still running from the last heartbeat (a slow database) is not doubled.
    if (closed || checking) return;
    checking = true;
    try {
      if (!(await o.stillAllowed())) close('end');
    } catch (err) {
      // An `AppError` is an answer (the link is gone); anything else is worth a look.
      if (!(err instanceof AppError)) {
        logger.warn({ err, topic: o.topic }, 'live stream access check failed');
      }
      close('end');
    } finally {
      checking = false;
    }
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
        send(`retry: ${RETRY_MS}\n\n`);
        unsubscribe = events.subscribe(o.topic, onEvent);
        timer = setInterval(() => void heartbeat(), SSE_HEARTBEAT_MS);
        if (signal.aborted) {
          close('end');
          return;
        }
        signal.addEventListener('abort', onAbort);
        untrack = liveStreams.add(() => close('end'));
      },
      cancel() {
        close('cancelled');
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER_BYTES }),
  );
  return new Response(stream, { headers: SSE_HEADERS });
}
