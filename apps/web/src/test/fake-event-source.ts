import { type Mock, vi } from 'vitest';

/**
 * A stand-in for the browser's `EventSource`, which jsdom does not have.
 * `test-setup.ts` installs it as `EventSource` and empties `instances` before
 * each test. Nothing happens on its own: the test opens, feeds and breaks each
 * connection by hand. Like the real one, `url` is the resolved absolute URL,
 * and a closed source dispatches nothing more.
 */
export class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  /** Every source made since the test started, oldest first. */
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState: 0 | 1 | 2 = FakeEventSource.CONNECTING;
  readonly close: Mock<() => void> = vi.fn(() => {
    this.readyState = FakeEventSource.CLOSED;
  });

  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = new URL(url, location.href).href;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  /** The server sends `event: <type>` with `data: <data>`. */
  emit(type: string, data: string): void {
    if (this.readyState === FakeEventSource.CLOSED) return;
    this.dispatchEvent(new MessageEvent(type, { data }));
  }

  /** The connection is established (again). */
  open(): void {
    if (this.readyState === FakeEventSource.CLOSED) return;
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  /**
   * The connection breaks. `0`: the browser will retry by itself, as after a
   * dropped network or a stream the server ended. `2`: it gives up, as after
   * an error status.
   */
  fail(state: 0 | 2): void {
    if (this.readyState === FakeEventSource.CLOSED) return;
    this.readyState = state;
    this.dispatchEvent(new Event('error'));
  }
}
