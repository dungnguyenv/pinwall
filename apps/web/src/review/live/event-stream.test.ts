import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from 'vitest';
import type { LiveEvent } from '../../api/dto.ts';
import { FakeEventSource } from '../../test/fake-event-source.ts';
import { fx } from '../../test/fixtures.ts';
import { API, server } from '../../test/server.ts';
import {
  type LiveHandlers,
  openLiveStream,
  reconnectDelay,
  type StreamStatus,
} from './event-stream.ts';

const PATH = '/api/v1/artifacts/art_1/events';

let stream: { close(): void } | null = null;
/** The access checks a failed stream sends. */
let checks: MockInstance<typeof globalThis.fetch>;

beforeEach(() => {
  checks = vi.spyOn(globalThis, 'fetch');
  // Only the timeouts are faked: `vi.waitFor` keeps polling on real time while
  // the mock network answers the access check.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  stream?.close();
  stream = null;
  // Every access check gets its answer before the test's handlers are dropped.
  await Promise.allSettled(checks.mock.results.map((r) => r.value));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open(random: () => number = () => 0.5) {
  const statuses: StreamStatus[] = [];
  const h = {
    onEvent: vi.fn<LiveHandlers['onEvent']>(),
    onStatus: vi.fn((s: StreamStatus) => {
      statuses.push(s);
    }),
    onResync: vi.fn(),
  };
  stream = openLiveStream(PATH, h, { random });
  return { h, statuses, last: () => statuses.at(-1) };
}

/** The `n`th source made, counting from 0. */
function source(n: number): FakeEventSource {
  const s = FakeEventSource.instances[n];
  if (s === undefined) throw new Error(`no source ${n}`);
  return s;
}

const created: LiveEvent = { type: 'comment.created', artifact_id: 'art_1', thread: fx.thread() };

test('one source per stream, listening on the path', () => {
  open();
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(source(0).url).toBe(new URL(PATH, location.href).href);
});

test('events arrive parsed; invalid ones are dropped', () => {
  const log = vi.spyOn(console, 'log');
  const warn = vi.spyOn(console, 'warn');
  const error = vi.spyOn(console, 'error');
  const { h } = open();
  source(0).open();

  source(0).emit('comment.created', JSON.stringify(created));
  expect(h.onEvent).toHaveBeenCalledTimes(1);
  expect(h.onEvent).toHaveBeenCalledWith(created);

  source(0).emit('comment.created', '{');
  source(0).emit('comment.created', JSON.stringify({ type: 'comment.created', id: 'cmt_1' }));
  source(0).emit('version.published', JSON.stringify({ type: 'version.published', number: 'x' }));
  expect(h.onEvent).toHaveBeenCalledTimes(1);
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test('every live event type is heard', () => {
  const { h } = open();
  source(0).open();
  const published: LiveEvent = {
    type: 'version.published',
    artifact_id: 'art_1',
    version_id: 'ver_2',
    number: 2,
  };
  const deleted: LiveEvent = { type: 'version.deleted', artifact_id: 'art_1', number: 1 };
  const commentDeleted: LiveEvent = {
    type: 'comment.deleted',
    artifact_id: 'art_1',
    thread_id: 'cmt_1',
    comment_id: 'cmt_1',
    version_number: 1,
    thread: null,
  };
  for (const e of [published, deleted, created, commentDeleted]) {
    source(0).emit(e.type, JSON.stringify(e));
  }
  for (const type of ['comment.updated', 'comment.resolved', 'comment.reopened'] as const) {
    source(0).emit(type, JSON.stringify({ ...created, type }));
  }
  expect(h.onEvent.mock.calls.map(([e]) => e.type)).toEqual([
    'version.published',
    'version.deleted',
    'comment.created',
    'comment.deleted',
    'comment.updated',
    'comment.resolved',
    'comment.reopened',
  ]);
});

// Review Focus 3: a tab left open through sleep, a dropped network or a server restart.
test('a dropped connection reconnects with growing delays and resyncs', () => {
  const { h, last } = open();
  source(0).open();
  expect(last()).toBe('open');
  expect(h.onResync).not.toHaveBeenCalled();

  source(0).fail(2);
  expect(last()).toBe('reconnecting');
  expect(source(0).close).toHaveBeenCalled();
  vi.advanceTimersByTime(999);
  expect(FakeEventSource.instances).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(source(1).url).toBe(source(0).url);

  source(1).fail(2);
  expect(last()).toBe('reconnecting');
  vi.advanceTimersByTime(1999);
  expect(FakeEventSource.instances).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(FakeEventSource.instances).toHaveLength(3);

  source(2).open();
  expect(last()).toBe('open');
  expect(h.onResync).toHaveBeenCalledTimes(1);

  // An open resets the ladder: the next failure waits one second again.
  source(2).fail(2);
  vi.advanceTimersByTime(999);
  expect(FakeEventSource.instances).toHaveLength(3);
  vi.advanceTimersByTime(1);
  expect(FakeEventSource.instances).toHaveLength(4);
});

test('the delays climb to thirty seconds and stay there', () => {
  open(() => 0.5);
  const waits: number[] = [];
  for (let n = 0; n < 7; n += 1) {
    source(n).fail(2);
    let waited = 0;
    while (FakeEventSource.instances.length === n + 1 && waited < 60_000) {
      vi.advanceTimersByTime(1000);
      waited += 1000;
    }
    waits.push(waited);
  }
  expect(waits).toEqual([1000, 2000, 5000, 10_000, 30_000, 30_000, 30_000]);
});

test("the browser's own retry also resyncs", () => {
  const { h, last } = open();
  source(0).open();
  source(0).fail(0);
  expect(last()).toBe('reconnecting');
  expect(source(0).close).not.toHaveBeenCalled();

  source(0).open();
  expect(last()).toBe('open');
  expect(h.onResync).toHaveBeenCalledTimes(1);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('a first connection that failed resyncs once it opens', () => {
  const { h } = open();
  source(0).fail(0);
  source(0).open();
  expect(h.onResync).toHaveBeenCalledTimes(1);
});

test('artifact.deleted ends the stream', () => {
  const { h, last } = open();
  source(0).open();
  const deleted: LiveEvent = { type: 'artifact.deleted', artifact_id: 'art_1' };
  source(0).emit('artifact.deleted', JSON.stringify(deleted));

  expect(h.onEvent).toHaveBeenCalledWith(deleted);
  expect(source(0).close).toHaveBeenCalled();
  expect(last()).toBe('ended');
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('a handler that closes on artifact.deleted hears nothing more', () => {
  const onStatus = vi.fn();
  stream = openLiveStream(PATH, { onEvent: () => stream?.close(), onStatus });
  source(0).emit(
    'artifact.deleted',
    JSON.stringify({ type: 'artifact.deleted', artifact_id: 'a' }),
  );
  expect(source(0).close).toHaveBeenCalled();
  expect(onStatus).not.toHaveBeenCalled();
});

test('close stops everything', () => {
  const { h, statuses } = open();
  source(0).open();
  source(0).fail(2);
  stream?.close();
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(h.onResync).not.toHaveBeenCalled();
  expect(statuses).toEqual(['open', 'reconnecting']);

  // A close while connected closes the source.
  open();
  stream?.close();
  expect(source(1).close).toHaveBeenCalled();
});

// The server ends a stream when the session or the link ends, or the artifact
// is deleted; the browser's retry then gets an error status and gives up.
test.each([401, 403, 404, 410])(
  'a stream the server refuses with %i ends, and resyncs so the page learns why',
  async (status) => {
    server.use(
      http.head(`${API}/artifacts/art_1/events`, () => new HttpResponse(null, { status })),
    );
    const { h, last } = open();
    source(0).open();
    source(0).fail(0);
    source(0).fail(2);
    expect(last()).toBe('reconnecting');

    await vi.waitFor(() => expect(last()).toBe('ended'), { interval: 1, timeout: 5000 });
    expect(h.onResync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  },
);

test.each([
  ['a rate limit', () => new HttpResponse(null, { status: 429 })],
  ['a proxy error', () => new HttpResponse(null, { status: 502 })],
  ['no answer', () => HttpResponse.error()],
])('%s while reconnecting keeps backing off', async (_name, answer) => {
  server.use(http.head(`${API}/artifacts/art_1/events`, answer));
  const { h, last } = open();
  source(0).fail(2);

  expect(checks).toHaveBeenCalledTimes(1);
  const [url, init] = checks.mock.calls[0] ?? [];
  expect(String(url)).toBe(new URL(PATH, location.href).href);
  expect(init).toMatchObject({ method: 'HEAD', credentials: 'same-origin' });
  // The answer arrives well before the reconnect is due, and changes nothing.
  await checks.mock.results[0]?.value.then(
    () => {},
    () => {},
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(last()).toBe('reconnecting');

  vi.advanceTimersByTime(1000);
  expect(FakeEventSource.instances).toHaveLength(2);
  source(1).open();
  expect(last()).toBe('open');
  expect(h.onResync).toHaveBeenCalledTimes(1);
});

test('reconnectDelay jitters within ±20 %', () => {
  expect(reconnectDelay(0, () => 0)).toBe(800);
  expect(reconnectDelay(0, () => 1)).toBe(1200);
  expect(reconnectDelay(9, () => 0.5)).toBe(30_000);
  expect(reconnectDelay(2, () => 0.5)).toBe(5000);
  for (let i = 0; i < 50; i += 1) {
    const d = reconnectDelay(1);
    expect(d).toBeGreaterThanOrEqual(1600);
    expect(d).toBeLessThanOrEqual(2400);
  }
});
