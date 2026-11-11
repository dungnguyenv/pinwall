import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { LiveEvent } from '../../api/dto.ts';
import { FakeEventSource } from '../../test/fake-event-source.ts';
import type { LiveHandlers } from './event-stream.ts';
import { useLiveEvents } from './use-live-events.ts';

afterEach(() => vi.unstubAllGlobals());

const A = '/api/v1/artifacts/art_1/events';
const B = '/api/v1/artifacts/art_2/events';
const published: LiveEvent = {
  type: 'version.published',
  artifact_id: 'art_1',
  version_id: 'ver_2',
  number: 2,
};

function only(): FakeEventSource {
  expect(FakeEventSource.instances).toHaveLength(1);
  return FakeEventSource.instances[0] as FakeEventSource;
}

test('one stream per path, with the latest handlers', () => {
  const first = vi.fn<LiveHandlers['onEvent']>();
  const latest = vi.fn<LiveHandlers['onEvent']>();
  const { result, rerender } = renderHook(({ h }) => useLiveEvents(A, h), {
    initialProps: { h: { onEvent: first } as LiveHandlers },
  });
  expect(result.current).toBe('connecting');
  const es = only();
  expect(es.url).toBe(new URL(A, location.href).href);

  act(() => es.open());
  expect(result.current).toBe('open');

  // New handlers on every render do not reopen the stream.
  rerender({ h: { onEvent: latest } });
  act(() => es.emit('version.published', JSON.stringify(published)));
  expect(only()).toBe(es);
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith(published);
});

test('status changes and resyncs reach the handlers too', () => {
  const onStatus = vi.fn();
  const onResync = vi.fn();
  const { result } = renderHook(() => useLiveEvents(A, { onEvent: () => {}, onStatus, onResync }));
  const es = only();
  act(() => es.fail(0));
  expect(result.current).toBe('reconnecting');
  act(() => es.open());
  expect(result.current).toBe('open');
  expect(onStatus.mock.calls).toEqual([['reconnecting'], ['open']]);
  expect(onResync).toHaveBeenCalledTimes(1);
});

test('a new path reopens, and unmounting closes', () => {
  const { result, rerender, unmount } = renderHook(
    ({ path }) => useLiveEvents(path, { onEvent: () => {} }),
    { initialProps: { path: A } },
  );
  const [first] = FakeEventSource.instances;
  act(() => first?.open());
  expect(result.current).toBe('open');

  rerender({ path: B });
  expect(first?.close).toHaveBeenCalled();
  expect(FakeEventSource.instances).toHaveLength(2);
  const second = FakeEventSource.instances[1];
  expect(second?.url).toBe(new URL(B, location.href).href);
  expect(result.current).toBe('connecting');

  unmount();
  expect(second?.close).toHaveBeenCalled();
});

test('no path opens nothing yet', () => {
  const { result, rerender } = renderHook(
    ({ path }) => useLiveEvents(path, { onEvent: () => {} }),
    { initialProps: { path: null as string | null } },
  );
  expect(FakeEventSource.instances).toHaveLength(0);
  expect(result.current).toBe('connecting');
  rerender({ path: A });
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('a browser without EventSource has no live updates', () => {
  vi.stubGlobal('EventSource', undefined);
  const { result } = renderHook(() => useLiveEvents(A, { onEvent: () => {} }));
  expect(result.current).toBe('ended');
  expect(FakeEventSource.instances).toHaveLength(0);
});
