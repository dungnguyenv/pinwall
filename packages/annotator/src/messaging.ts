/**
 * The annotator's side of the `postMessage` protocol with the review viewer (the Pinwall app in
 * `window.top`). Both directions are checked against the schemas of `@pinwall/shared/protocol`.
 */
import {
  type PageToViewerMessage,
  PageToViewerMessage as PageToViewerSchema,
  parseViewerMessage,
  type ViewerToPageMessage,
} from '@pinwall/shared/protocol';
import { guard } from './guard.ts';
import {
  messageData,
  messageSource,
  stopImmediatePropagation,
  type WindowListeners,
  windowListeners,
} from './pristine.ts';

/**
 * Posts `msg` to the viewer when it passes the schema, as the schema parsed it (so no field
 * outside the protocol ever leaves the page). The viewer's origin is unknown to a sandboxed page,
 * hence `'*'`: messages carry anchors, ids and frame ids only.
 */
export function postToViewer(top: Window, msg: PageToViewerMessage): void {
  const parsed = PageToViewerSchema.safeParse(msg);
  if (parsed.success) top.postMessage(parsed.data, '*');
}

/**
 * Calls `handler` with each message `win` receives from `top` that passes the viewer schema.
 * Those messages stop at this listener, so page scripts that read every message never see them.
 * Returns what removes the listener. `listeners` are the window's own, taken at script load.
 */
export function onViewerMessage(
  win: Window,
  top: Window,
  handler: (m: ViewerToPageMessage) => void,
  listeners: WindowListeners = windowListeners(win),
): () => void {
  const listener = guard((event: MessageEvent) => {
    if (messageSource(event) !== top) return;
    const msg = parseViewerMessage(messageData(event));
    if (msg === null) return;
    stopImmediatePropagation(event);
    handler(msg);
  });
  listeners.add('message', listener);
  return () => listeners.remove('message', listener);
}
