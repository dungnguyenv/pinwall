/**
 * The annotator of one frame: it tells the viewer which page the frame shows, turns clicks and
 * selections into anchors in comment mode, and draws the pins the viewer sends. Every frame of a
 * review grant runs its own annotator and talks to `window.top` (the viewer) directly. It hears
 * the viewer only once it has posted `ready`, and draws only the anchors of its own page.
 */
import {
  ANNOTATOR_GLOBAL,
  type Anchor,
  type PageToViewerMessage,
  PROTOCOL_VERSION,
  type ViewerToPageMessage,
} from '@pinwall/shared/protocol';
import { elementAnchor, pointAnchor, textAnchor } from './anchors.ts';
import { pathTarget } from './css-path.ts';
import { viewportSize } from './geometry.ts';
import { guard } from './guard.ts';
import { onViewerMessage, postToViewer } from './messaging.ts';
import { createOverlay, type Overlay, type PinSpec } from './overlay.ts';
import { grantBase, pageOf } from './page.ts';
import {
  addListener,
  createRange,
  eventTarget,
  getRangeAt,
  getSelection,
  isCollapsed,
  isTrusted,
  preventDefault,
  rangeCount,
  removeListener,
  stopImmediatePropagation,
  windowListeners,
} from './pristine.ts';
import { type Placement, placeAnchor } from './reattach.ts';
import { buildTextIndex, type TextIndex } from './text-index.ts';

export interface BootOptions {
  /** The URL the annotator script was loaded from; it names the grant base. */
  scriptSrc: string | null;
  /** The viewer's window; `win.top` when left out. */
  top?: Window | null;
}

export interface Annotator {
  readonly page: string;
  readonly frameId: string;
  /** Removes the global, every listener and timer, and the overlay. */
  destroy(): void;
}

type ShowAnchors = Extract<ViewerToPageMessage, { type: 'show-anchors' }>['anchors'];
type Result = { id: string; found: boolean; via: Placement['via'] };
type Win = Window & typeof globalThis;

/** Unfound anchors are placed again this long after `show-anchors` (pages that render late). */
const RETRY_MS = 2000;
/** How often the frame's URL is checked for `pushState` navigations, which fire no event. */
const NAVIGATION_CHECK_MS = 1000;
/** Fallback layout throttle where there is no `requestAnimationFrame`. */
const LAYOUT_DELAY_MS = 50;
/** A clicked box covering this much of the viewport is "the page": the click becomes a point. */
const PAGE_SIZED = 0.8;

/** 16 hex characters from the platform's random source. */
function newFrameId(win: Win): string {
  const bytes = new Uint8Array(8);
  try {
    win.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let id = '';
  for (const byte of bytes) id += byte.toString(16).padStart(2, '0');
  return id;
}

function sameResults(a: readonly Result[], b: readonly Result[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.id === b[i]?.id && r.found === b[i]?.found && r.via === b[i]?.via)
  );
}

/** An index with no text: for anchors without a quote, and pages whose text cannot be read. */
function emptyIndex(doc: Document): TextIndex {
  return { text: '', complete: false, toOffset: () => 0, toRange: () => createRange(doc) };
}

/**
 * Starts the annotator in `win`, synchronously, so its listeners come before any page script's.
 * Null when one already runs there, when `opts.scriptSrc` is not an annotator URL of a grant,
 * when the frame's URL is not a page of that grant, or when there is no viewer window.
 */
export function boot(win: Window, opts: BootOptions): Annotator | null {
  const w = win as Win;
  if (ANNOTATOR_GLOBAL in w) return null;
  const base = opts.scriptSrc === null ? null : grantBase(opts.scriptSrc);
  if (base === null) return null;
  let href = w.location.href;
  let page = pageOf(href, base);
  if (page === null) return null;
  const top = opts.top === undefined ? w.top : opts.top;
  if (!top) return null;

  const doc = w.document;
  const events = windowListeners(w);
  const frameId = newFrameId(w);
  Object.defineProperty(w, ANNOTATOR_GLOBAL, {
    value: Object.freeze({ protocol: PROTOCOL_VERSION, frameId }),
    configurable: true,
    enumerable: false,
    writable: false,
  });

  let mode: 'browse' | 'comment' = 'browse';
  let overlay: Overlay | null = null;
  /** The DOM is loaded: the overlay exists and `ready` went out if there was a page to name. */
  let domReady = false;
  /**
   * `ready` was posted. Viewer messages before it are dropped: the viewer answers `ready`, so an
   * earlier one was meant for the document this window showed before, or for another frame.
   */
  let announced = false;
  let anchors: ShowAnchors = [];
  let results: Result[] = [];
  let unfound = false;
  let swallowClick = false;
  let swallowTimer: number | undefined;
  let retryTimer: number | undefined;
  let layoutPending = false;
  let resizeObserver: ResizeObserver | null = null;
  const removers: (() => void)[] = [];

  const post = (msg: PageToViewerMessage) => postToViewer(top, msg);

  /** Adds a guarded listener to the window. */
  const listen = (
    type: string,
    fn: (event: never) => unknown,
    options: AddEventListenerOptions,
  ) => {
    const listener = guard(fn);
    events.add(type, listener, options);
    removers.push(() => events.remove(type, listener, options));
  };

  const runLayout = guard(() => {
    layoutPending = false;
    overlay?.layout();
  });
  const scheduleLayout = () => {
    if (layoutPending || overlay === null) return;
    layoutPending = true;
    if (typeof w.requestAnimationFrame === 'function') w.requestAnimationFrame(runLayout);
    else w.setTimeout(runLayout, LAYOUT_DELAY_MS);
  };

  /**
   * Places the remembered anchors of the current page against one text index, draws their pins
   * and posts `anchors-placed`: always when `always`, else only when a result changed.
   */
  const placeAll = (always: boolean) => {
    const mine = page === null ? [] : anchors.filter((a) => a.anchor.page === page);
    const none = emptyIndex(doc);
    let index: TextIndex | null = null;
    const textIndex = (): TextIndex => {
      if (index === null) {
        try {
          index = buildTextIndex(doc);
        } catch {
          index = none;
        }
      }
      return index;
    };
    const pins: PinSpec[] = mine.map(({ id, number, resolved, anchor }) => ({
      id,
      number,
      resolved,
      anchor,
      placement: placeAnchor(doc, anchor.kind === 'text' ? textIndex() : none, anchor),
    }));
    const next = pins.map(({ id, placement }) => ({
      id,
      found: placement.found,
      via: placement.via,
    }));
    unfound = next.some((r) => !r.found);
    const changed = !sameResults(next, results);
    results = next;
    if (always || changed) post({ pinwall: 1, type: 'anchors-placed', results: next, frameId });
    overlay?.setPins(pins);
  };

  /** Places the remembered anchors now, and the unfound ones again a little later. */
  const applyAnchors = () => {
    if (retryTimer !== undefined) w.clearTimeout(retryTimer);
    retryTimer = undefined;
    placeAll(true);
    if (unfound) {
      retryTimer = w.setTimeout(
        guard(() => {
          retryTimer = undefined;
          if (unfound) placeAll(false);
        }),
        RETRY_MS,
      );
    }
  };

  const handle = (msg: ViewerToPageMessage) => {
    switch (msg.type) {
      case 'set-mode':
        mode = msg.mode;
        if (mode === 'browse') {
          swallowClick = false;
          overlay?.hover(null);
        }
        break;
      case 'show-anchors':
        anchors = msg.anchors;
        applyAnchors();
        break;
      case 'focus-anchor':
        overlay?.focus(msg.id);
        break;
    }
  };

  const checkNavigation = () => {
    const now = w.location.href;
    if (now === href) return;
    href = now;
    const next = pageOf(now, base);
    if (next === page) return;
    page = next;
    if (!domReady) return; // `ready` will name the page.
    if (next !== null) {
      post({ pinwall: 1, type: announced ? 'navigated' : 'ready', page: next, frameId });
      announced = true;
    }
    applyAnchors();
  };

  const isOverlay = (target: EventTarget | null) => overlay !== null && target === overlay.host;

  const pick = (anchor: Anchor | null) => {
    if (anchor !== null) post({ pinwall: 1, type: 'anchor-picked', anchor, frameId });
  };

  /** Whether `el`'s box covers most of the viewport, as page wrappers do. */
  const coversViewport = (el: Element): boolean => {
    if (typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    const { width, height } = viewportSize(doc);
    if (!(width > 0 && height > 0)) return false;
    const seen =
      Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0)) *
      Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
    return seen >= PAGE_SIZED * width * height;
  };

  /** The anchor a comment-mode click makes: an element, or a point for "the page itself". */
  const clickAnchor = (event: MouseEvent, target: EventTarget | null): Anchor | null => {
    if (page === null) return null;
    const ctx = { doc, page };
    const el = target !== null && (target as Node).nodeType === 1 ? (target as Element) : null;
    const isPage = el === null || el === doc.documentElement || el === doc.body;
    if (!event.altKey && !isPage && !coversViewport(pathTarget(el))) {
      const anchor = elementAnchor(ctx, el);
      if (anchor !== null) return anchor;
    }
    return pointAnchor(ctx, event.clientX, event.clientY);
  };

  /**
   * In comment mode every click is kept from the page, but only the user's own make an anchor:
   * pages click themselves (carousels, `el.click()` to open a file input), and such a click must
   * not replace the spot the reviewer is commenting on.
   */
  const onClick = (event: MouseEvent) => {
    if (mode !== 'comment') return;
    const target = eventTarget(event);
    if (isOverlay(target)) return;
    preventDefault(event);
    stopImmediatePropagation(event);
    if (!swallowClick && isTrusted(event)) pick(clickAnchor(event, target));
  };

  /** Middle clicks would open links in a new tab: comment mode keeps them from the page too. */
  const onAuxClick = (event: MouseEvent) => {
    if (mode !== 'comment' || isOverlay(eventTarget(event))) return;
    preventDefault(event);
    stopImmediatePropagation(event);
  };

  const onMouseUp = (event: MouseEvent) => {
    if (mode !== 'comment' || page === null || isOverlay(eventTarget(event))) return;
    if (!isTrusted(event)) return;
    const selection = getSelection(doc);
    if (selection === null || isCollapsed(selection) || rangeCount(selection) === 0) return;
    const anchor = textAnchor({ doc, page }, getRangeAt(selection, 0));
    if (anchor === null) return;
    pick(anchor);
    // The click that ends this selection belongs to it, not to the element under the pointer.
    swallowClick = true;
    if (swallowTimer !== undefined) w.clearTimeout(swallowTimer);
    swallowTimer = w.setTimeout(
      guard(() => {
        swallowClick = false;
        swallowTimer = undefined;
      }),
      0,
    );
  };

  const onMouseMove = (event: MouseEvent) => {
    if (mode !== 'comment' || overlay === null) return;
    const target = eventTarget(event);
    const el = target !== null && (target as Node).nodeType === 1 ? (target as Element) : null;
    const isPage = el === null || el === doc.documentElement || el === doc.body || isOverlay(el);
    overlay.hover(isPage ? null : pathTarget(el));
  };

  const onLoad = () => {
    if (unfound) placeAll(false);
    scheduleLayout();
  };

  const onReady = () => {
    if (domReady) return;
    domReady = true;
    overlay = createOverlay(doc, (id) => post({ pinwall: 1, type: 'pin-clicked', id }));
    overlay.layout();
    if (typeof w.ResizeObserver === 'function' && doc.documentElement) {
      resizeObserver = new w.ResizeObserver(guard(scheduleLayout));
      resizeObserver.observe(doc.documentElement);
    }
    if (page !== null) {
      post({ pinwall: 1, type: 'ready', page, frameId });
      announced = true;
    }
  };

  // Messages before `ready` still stop at the annotator: the page never sees viewer messages.
  removers.push(
    onViewerMessage(
      w,
      top,
      (msg) => {
        if (announced) handle(msg);
      },
      events,
    ),
  );
  const capture = { capture: true };
  const passive = { capture: true, passive: true };
  listen('click', onClick, capture);
  listen('auxclick', onAuxClick, capture);
  listen('mouseup', onMouseUp, capture);
  listen('mousemove', onMouseMove, passive);
  listen('popstate', checkNavigation, {});
  listen('load', onLoad, {});
  listen('resize', scheduleLayout, { passive: true });
  listen('scroll', scheduleLayout, passive);
  const navigationTimer = w.setInterval(guard(checkNavigation), NAVIGATION_CHECK_MS);

  if (doc.readyState === 'loading') {
    const ready = guard(onReady);
    addListener(doc, 'DOMContentLoaded', ready);
    removers.push(() => removeListener(doc, 'DOMContentLoaded', ready));
  } else guard(onReady)();

  let destroyed = false;
  return {
    get page() {
      return page ?? '';
    },
    frameId,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of removers) guard(remove)();
      w.clearInterval(navigationTimer);
      if (retryTimer !== undefined) w.clearTimeout(retryTimer);
      if (swallowTimer !== undefined) w.clearTimeout(swallowTimer);
      resizeObserver?.disconnect();
      overlay?.destroy();
      overlay = null;
      // Nothing is set up or heard after this, even if a listener could not be removed.
      domReady = true;
      announced = false;
      Reflect.deleteProperty(w, ANNOTATOR_GLOBAL);
    },
  };
}
