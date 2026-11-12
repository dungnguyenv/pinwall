import { parseViewerMessage, type ViewerToPageMessage } from '@pinwall/shared/protocol';

/** How many frames below the content frame a message may come from. */
export const MAX_FRAME_DEPTH = 8;
/** The most frame windows the viewer keeps track of at once. */
export const MAX_FRAMES = 200;

/**
 * Whether `source` is `root` or a frame inside it, at most `MAX_FRAME_DEPTH`
 * frames down. Other windows (the app, sibling frames, popups), ports and
 * null are outside. Reading `parent` of a cross-origin window is allowed, but
 * it is guarded anyway: anything unreadable counts as outside.
 */
export function isWithinFrame(source: MessageEventSource | null, root: Window | null): boolean {
  if (source === null || root === null) return false;
  let win: unknown = source;
  for (let hops = 0; hops <= MAX_FRAME_DEPTH; hops++) {
    if (win === root) return true;
    let parent: unknown;
    try {
      parent = (win as { parent?: unknown }).parent;
    } catch {
      return false;
    }
    // The top window is its own parent; a port has none; a closed frame's is null.
    if (parent === undefined || parent === null || parent === win) return false;
    win = parent;
  }
  return false;
}

/**
 * Posts `msg` to `win` when it passes the protocol schema, as the schema
 * parsed it: a field outside the protocol (a comment body, an author) never
 * leaves the app, even when a caller hands one over. The target origin is
 * `'*'` because content origins are opaque. A window that is gone, or refuses
 * the message, is skipped.
 */
export function postTo(win: Window | null, msg: ViewerToPageMessage): void {
  if (win === null) return;
  const parsed = parseViewerMessage(msg);
  if (parsed === null) return;
  try {
    win.postMessage(parsed, '*');
  } catch {
    // The frame went away while the message was on its way.
  }
}
