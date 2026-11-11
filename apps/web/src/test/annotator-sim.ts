import type { Anchor, ViewerToPageMessage } from '@pinwall/shared/protocol';
import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

let frames = 0;

/**
 * Plays the annotator of the frame whose window is `win`, as the review viewer
 * sees it: each method dispatches the protocol message on the app's `window`
 * with `source: win` (inside `act`, like a user event). `received()` lists
 * what the viewer posted to `win` since this call, oldest first: a new
 * document in the same frame window gets a new `simFrame`. `postMessage` on
 * `win` is replaced by a spy, so nothing is delivered to the frame itself.
 */
export function simFrame(
  win: Window,
  o: { page?: string; frameId?: string } = {},
): {
  ready(): void;
  picked(a: Anchor, client?: { x: number; y: number }): void;
  placed(r: { id: string; found: boolean; via?: 'quote' | 'dom' | 'position' }[]): void;
  pinClicked(id: string): void;
  navigated(page: string): void;
  scrolled(x: number, y: number): void;
  received(): ViewerToPageMessage[];
} {
  frames += 1;
  const frameId = o.frameId ?? `frame-${frames}`;
  let page = o.page ?? '';
  const spy = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
  const since = spy.mock.calls.length;
  const post = (data: object) =>
    fireEvent(window, new MessageEvent('message', { data: { pinwall: 1, ...data }, source: win }));
  return {
    ready: () => post({ type: 'ready', page, frameId }),
    picked: (anchor, client) =>
      post({ type: 'anchor-picked', anchor, frameId, ...(client ? { client } : {}) }),
    placed: (results) => post({ type: 'anchors-placed', results, frameId }),
    pinClicked: (id) => post({ type: 'pin-clicked', id }),
    navigated: (next) => {
      page = next;
      post({ type: 'navigated', page, frameId });
    },
    scrolled: (x, y) => post({ type: 'scrolled', frameId, x, y }),
    received: () => spy.mock.calls.slice(since).map((call) => call[0] as ViewerToPageMessage),
  };
}

/**
 * Adds a frame inside `iframe`'s document (jsdom never loads the frame's URL,
 * so that document stays empty) and returns its window: a descendant of the
 * content frame, as an artifact's own `<iframe>` would be.
 */
export function nestedWindow(iframe: HTMLIFrameElement): Window {
  const doc = iframe.contentDocument;
  if (doc === null) throw new Error('The frame has no document to nest a frame in');
  const host = doc.body ?? doc.documentElement ?? doc.appendChild(doc.createElement('html'));
  const nested = doc.createElement('iframe');
  host.append(nested);
  if (nested.contentWindow === null) throw new Error('The nested frame has no window');
  return nested.contentWindow;
}
