import { CommentThread } from '@pinwall/shared';
import type { Anchor } from '@pinwall/shared/protocol';
import { apiInit } from './auth.ts';
import type { TestContext } from './context.ts';

/** A text anchor on `docs/`, with a DOM path too, merged with `over`. */
export function sampleAnchor(over: Partial<Anchor> = {}): Anchor {
  return {
    page: 'docs/',
    kind: 'text',
    quote: { exact: 'Bảng giá', prefix: 'Xem ', suffix: ' mới' },
    dom: { path: '#pricing > h2' },
    position: { x: 0.1, y: 0.2 },
    viewport: { width: 1280 },
    ...over,
  };
}

/**
 * Opens a thread on the artifact as the holder of `cookie`, through the REST API, and returns it.
 * Defaults: body "Sửa giá", `sampleAnchor()`, the current version.
 */
export async function postThread(
  ctx: TestContext,
  cookie: string,
  artifactId: string,
  o: { body?: string; anchor?: Anchor; versionId?: string } = {},
): Promise<CommentThread> {
  const body = {
    body: o.body ?? 'Sửa giá',
    anchor: o.anchor ?? sampleAnchor(),
    ...(o.versionId === undefined ? {} : { version_id: o.versionId }),
  };
  const r = await ctx.request(
    `/api/v1/artifacts/${artifactId}/comments`,
    apiInit(ctx, { method: 'POST', cookie, body }),
  );
  if (r.status !== 201) {
    throw new Error(
      `POST /artifacts/${artifactId}/comments answered ${r.status}: ${await r.text()}`,
    );
  }
  return CommentThread.parse(await r.json());
}

/** How long `readSse(…).done()` waits for the end of a stream by default. */
const SSE_DONE_WAIT_MS = 3_000;
const SSE_PING = ': ping\n\n';

/**
 * Reads the server-sent events of `res`, however the bytes are cut into chunks. `next()`
 * resolves with the next message up to and including the blank line that ends it (`retry: …`,
 * `: ping` or an event), and fails when the stream ends first. `done()` resolves true once the
 * stream ends, skipping heartbeats on the way, false when it is still open after `ms`; any other
 * message before the end fails it. `cancel()` stops reading, which closes the connection.
 */
export function readSse(res: Response): {
  next(): Promise<string>;
  done(ms?: number): Promise<boolean>;
  cancel(): Promise<void>;
} {
  if (res.body === null) throw new Error('readSse: the response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  // A read still in flight when `done` gave up waiting; the next call takes it over.
  let pending: ReturnType<typeof reader.read> | null = null;

  /** Waits for one more chunk and adds it to the buffer; at the end of the stream sets `ended`. */
  async function fill(): Promise<void> {
    pending ??= reader.read();
    const { done, value } = await pending;
    pending = null;
    if (done) ended = true;
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
  }

  /** The next whole message already read, if any. */
  function take(): string | null {
    const end = buffer.indexOf('\n\n');
    if (end === -1) return null;
    const text = buffer.slice(0, end + 2);
    buffer = buffer.slice(end + 2);
    return text;
  }

  function assertNoPartial(): void {
    if (buffer !== '') throw new Error(`The stream ended within a message: ${buffer}`);
  }

  return {
    async next() {
      for (;;) {
        const text = take();
        if (text !== null) return text;
        if (ended) {
          assertNoPartial();
          throw new Error('The stream ended');
        }
        await fill();
      }
    },
    async done(ms = SSE_DONE_WAIT_MS) {
      const deadline = Date.now() + ms;
      for (;;) {
        for (let text = take(); text !== null; text = take()) {
          if (text !== SSE_PING) throw new Error(`A message before the end: ${text}`);
        }
        if (ended) {
          assertNoPartial();
          return true;
        }
        pending ??= reader.read();
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'open'>((resolve) => {
          timer = setTimeout(() => resolve('open'), Math.max(0, deadline - Date.now()));
        });
        // Settles either way, so a read that fails later is never an unhandled rejection.
        const read = pending.then(
          () => 'read' as const,
          () => 'read' as const,
        );
        const outcome = await Promise.race([read, timeout]);
        clearTimeout(timer);
        if (outcome === 'open') return false;
        await fill();
      }
    },
    async cancel() {
      await reader.cancel();
    },
  };
}
