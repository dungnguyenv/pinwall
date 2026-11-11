import {
  type Anchor,
  MAX_ANCHORS,
  parsePageMessage,
  type ViewerToPageMessage,
} from '@pinwall/shared/protocol';
import {
  type RefCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { READY_TIMEOUT_MS } from './sandbox.ts';
import { isWithinFrame, MAX_FRAMES, postTo } from './windows.ts';

/** The frame moves to a renewed grant this long before the grant it loaded from expires. */
export const RELOAD_BEFORE_EXPIRY_MS = 60_000;

/** Whether the top content frame's annotator answered: not yet, yes, or not within 3 s of load. */
export type AnnotatorState = 'waiting' | 'ready' | 'missing';
/**
 * Where a pin stands on what the frame shows: found on its page, on its page
 * but its text or element is gone (`detached`), on a page no frame shows, or
 * not reported yet.
 */
export type PinPlacement = 'placed' | 'detached' | 'elsewhere' | 'pending';

/** What the frame learns of a comment thread: no body, no author. */
export interface ViewerPin {
  id: string;
  number: number;
  resolved: boolean;
  anchor: Anchor;
}

/** A spot the reviewer chose in comment mode. `client` is in the top frame's viewport only. */
export interface PickedAnchor {
  anchor: Anchor;
  frameId: string;
  topFrame: boolean;
  client: { x: number; y: number } | null;
}

export interface FrameBridgeOptions {
  pins: ViewerPin[];
  mode: 'browse' | 'comment';
  /** The page a new grant opens on; the entry page by default. */
  startPage?: string;
  /**
   * The version the grant shows, and when the grant expires (epoch ms). With
   * both, a new `baseUrl` for the same version is a renewal: the frame keeps
   * the document it shows until the grant it loaded from nears its expiry,
   * then loads the same page from the newest grant. Without them, every new
   * `baseUrl` starts over.
   */
  version?: number;
  expiresAt?: number;
  onPicked?(p: PickedAnchor): void;
  onPinClicked?(id: string): void;
  onScrolled?(f: { x: number; y: number }): void;
}

export interface FrameBridge {
  src: string;
  frameRef: RefCallback<HTMLIFrameElement>;
  onFrameLoad(): void;
  loading: boolean;
  annotator: AnnotatorState;
  /** The page the top content frame shows, as its annotator last named it (or as asked). */
  topPage: string;
  placement(pin: { id: string; anchor: Anchor }): PinPlacement;
  focus(id: string): void;
  navigate(page: string): void;
  scrollTo(f: { x: number; y: number }): void;
}

/** One frame window that posted a valid `ready`. */
interface FrameRecord {
  readonly frameId: string;
  readonly page: string;
  /** The latest `anchors-placed`: pin id → found. */
  readonly results: ReadonlyMap<string, boolean>;
  /** The anchors last sent to it, serialized, so an unchanged list is not sent again. */
  readonly sent: string;
}

interface Snapshot {
  readonly src: string;
  readonly loading: boolean;
  readonly annotator: AnnotatorState;
  readonly topPage: string;
  readonly frames: readonly FrameRecord[];
}

interface Grant {
  readonly base: string;
  readonly version: number | undefined;
  readonly expiresAt: number | undefined;
}

/** `page` under `base`, each path segment percent-encoded. */
function pageUrl(base: string, page: string): string {
  return base + page.split('/').map(encodeURIComponent).join('/');
}

function placementOf(s: Snapshot, pin: { id: string; anchor: Anchor }): PinPlacement {
  const { page } = pin.anchor;
  const showing = s.frames.filter((f) => f.page === page);
  if (showing.length === 0) {
    if (page !== s.topPage) return 'elsewhere';
    // The overlay draws point pins where they were made; nothing can find text or elements.
    if (s.annotator === 'missing') return pin.anchor.kind === 'point' ? 'placed' : 'detached';
    return 'pending';
  }
  if (showing.some((f) => f.results.get(pin.id) === true)) return 'placed';
  if (showing.some((f) => f.results.get(pin.id) === false)) return 'detached';
  return 'pending';
}

/**
 * The mutable side of one content frame: which of its windows answered
 * `ready`, the timers, and the grant it loaded from. React reads it through
 * `subscribe`/`getSnapshot`.
 */
class Bridge {
  private frame: HTMLIFrameElement | null = null;
  /** Windows that posted a valid `ready`, bound to the frame id they named. */
  private readonly frames = new Map<Window, FrameRecord>();
  private opts: FrameBridgeOptions;
  private pinsKey: string;
  /** The grant the frame's document came from, and the newest one for the same version. */
  private loaded: Grant;
  private latest: Grant;
  /**
   * The last `load` of the frame has had its `ready` (true before the first `load`). The top
   * document's `ready` and the frame's `load` event may arrive in either order: a `ready`
   * answers the last `load` while that one is unanswered (late, even after the 3 s); otherwise
   * it comes from the next document and answers the `load` still to come.
   */
  private loadAnswered = true;
  /** A top `ready` came ahead of the `load` of its document. */
  private readyAhead = false;
  /** A pin to focus once a frame showing its page posts `ready`. */
  private pendingFocus: string | null = null;
  private missingTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private snapshot: Snapshot;
  private readonly subscribers = new Set<() => void>();

  constructor(grant: Grant, opts: FrameBridgeOptions) {
    this.opts = opts;
    this.pinsKey = keyOf(opts.pins);
    this.loaded = grant;
    this.latest = grant;
    const page = opts.startPage ?? '';
    this.snapshot = {
      src: grant.base === '' ? '' : pageUrl(grant.base, page),
      loading: true,
      annotator: 'waiting',
      topPage: page,
      frames: [],
    };
  }

  readonly subscribe = (fn: () => void) => {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  };

  readonly getSnapshot = () => this.snapshot;

  readonly frameRef = (el: HTMLIFrameElement | null) => {
    this.frame = el;
  };

  /** Listens for frame messages until the returned function stops it. */
  start(): () => void {
    this.started = true;
    window.addEventListener('message', this.onMessage);
    this.armReload();
    return () => {
      this.started = false;
      window.removeEventListener('message', this.onMessage);
      this.clearMissing();
      this.clearReload();
    };
  }

  setOptions(opts: FrameBridgeOptions): void {
    const modeChanged = opts.mode !== this.opts.mode;
    const pinsChanged = opts.pins !== this.opts.pins && keyOf(opts.pins) !== this.pinsKey;
    this.opts = opts;
    if (pinsChanged) this.pinsKey = keyOf(opts.pins);
    if (!modeChanged && !pinsChanged) return;
    for (const [win, rec] of this.live()) {
      if (modeChanged) postTo(win, this.modeMessage());
      if (pinsChanged) this.sendAnchors(win, rec);
    }
  }

  setGrant(next: Grant): void {
    const { latest, loaded } = this;
    if (
      next.base === latest.base &&
      next.version === latest.version &&
      next.expiresAt === latest.expiresAt
    ) {
      return;
    }
    const renewal =
      next.base !== '' &&
      loaded.base !== '' &&
      next.version !== undefined &&
      next.version === loaded.version &&
      next.expiresAt !== undefined &&
      loaded.expiresAt !== undefined;
    if (!renewal) {
      this.reset(next);
      return;
    }
    this.latest = next;
    if (next.base === loaded.base) this.loaded = next;
    this.armReload();
  }

  readonly onFrameLoad = () => {
    if (this.readyAhead) {
      this.readyAhead = false;
      this.loadAnswered = true;
      this.publish({ loading: false });
      return;
    }
    // The document that just loaded has not said `ready`: the top window's binding was the
    // previous document's. Without a `ready` soon, it has no annotator.
    this.loadAnswered = false;
    const root = this.root();
    if (root !== null) this.frames.delete(root);
    this.clearMissing();
    if (this.snapshot.annotator === 'missing') {
      this.publish({ loading: false });
      return;
    }
    this.missingTimer = setTimeout(() => {
      this.missingTimer = undefined;
      this.publish({ annotator: 'missing' });
    }, READY_TIMEOUT_MS);
    this.publish({ loading: false, annotator: 'waiting' });
  };

  readonly navigate = (page: string) => {
    const base = this.latest.base;
    if (base === '') return;
    this.loaded = this.latest;
    this.clearReload();
    this.forgetDocument();
    this.pendingFocus = null;
    const src = pageUrl(base, page);
    // The frame may have moved on by itself: the same address must still load again.
    if (src === this.snapshot.src && this.frame !== null) this.frame.src = src;
    this.publish({
      src,
      loading: true,
      topPage: page,
      annotator: this.snapshot.annotator === 'missing' ? 'missing' : 'waiting',
    });
  };

  readonly focus = (id: string) => {
    const pin = this.pin(id);
    if (pin === undefined) return;
    const { page } = pin.anchor;
    const showing = this.live().filter(([, rec]) => rec.page === page);
    if (showing.length > 0) {
      for (const [win] of showing) postTo(win, { pinwall: 1, type: 'focus-anchor', id });
      return;
    }
    if (page === this.snapshot.topPage) {
      // The top frame is loading that page now; the overlay has nothing to focus.
      if (this.snapshot.annotator !== 'missing') this.pendingFocus = id;
      return;
    }
    this.navigate(page);
    this.pendingFocus = id;
  };

  readonly scrollTo = (f: { x: number; y: number }) => {
    const root = this.root();
    if (root !== null && this.frames.has(root)) {
      postTo(root, { pinwall: 1, type: 'scroll-to', x: f.x, y: f.y });
    }
  };

  private readonly onMessage = (event: MessageEvent) => {
    const root = this.root();
    if (!isWithinFrame(event.source, root)) return;
    const msg = parsePageMessage(event.data);
    if (msg === null) return;
    const win = event.source as Window;
    const top = win === root;
    if (msg.type === 'ready') {
      this.onReady(win, top, msg.page, msg.frameId);
      return;
    }
    // Everything else comes only from a window that announced itself, under its own frame id.
    const rec = this.frames.get(win);
    if (rec === undefined || ('frameId' in msg && msg.frameId !== rec.frameId)) return;
    switch (msg.type) {
      case 'navigated': {
        const next = { frameId: rec.frameId, page: msg.page, results: new Map(), sent: '' };
        this.frames.set(win, next);
        this.sendAnchors(win, next);
        this.focusPending(win, msg.page);
        this.publish(top ? { topPage: msg.page } : {});
        break;
      }
      case 'anchors-placed':
        this.frames.set(win, {
          ...rec,
          results: new Map(msg.results.map((r) => [r.id, r.found])),
        });
        this.publish({});
        break;
      case 'anchor-picked':
        if (this.opts.mode !== 'comment') return;
        this.opts.onPicked?.({
          anchor: msg.anchor,
          frameId: msg.frameId,
          topFrame: top,
          client: top ? (msg.client ?? null) : null,
        });
        break;
      case 'pin-clicked':
        if (this.pin(msg.id) !== undefined) this.opts.onPinClicked?.(msg.id);
        break;
      case 'scrolled':
        if (top) this.opts.onScrolled?.({ x: msg.x, y: msg.y });
        break;
    }
  };

  private onReady(win: Window, top: boolean, page: string, frameId: string): void {
    if (!this.frames.has(win) && this.frames.size >= MAX_FRAMES) {
      this.prune();
      if (this.frames.size >= MAX_FRAMES) return;
    }
    const rec = { frameId, page, results: new Map(), sent: '' };
    this.frames.set(win, rec);
    postTo(win, this.modeMessage());
    this.sendAnchors(win, rec);
    this.focusPending(win, page);
    if (!top) {
      this.publish({});
      return;
    }
    // An unanswered `load` is this document's; otherwise its `load` is still to come.
    if (this.loadAnswered) this.readyAhead = true;
    else this.loadAnswered = true;
    this.clearMissing();
    this.publish({ annotator: 'ready', topPage: page });
  }

  /** Sends `win` the anchors of its page, unless it has them already. */
  private sendAnchors(win: Window, rec: FrameRecord): void {
    const anchors = this.opts.pins
      .filter((p) => p.anchor.page === rec.page)
      .slice(0, MAX_ANCHORS)
      .map(({ id, number, resolved, anchor }) => ({ id, number, resolved, anchor }));
    const sent = JSON.stringify(anchors);
    if (sent === rec.sent) return;
    this.frames.set(win, { ...rec, sent });
    postTo(win, { pinwall: 1, type: 'show-anchors', anchors });
  }

  private focusPending(win: Window, page: string): void {
    const id = this.pendingFocus;
    if (id === null) return;
    const pin = this.pin(id);
    if (pin === undefined) {
      this.pendingFocus = null;
    } else if (pin.anchor.page === page) {
      this.pendingFocus = null;
      postTo(win, { pinwall: 1, type: 'focus-anchor', id });
    }
  }

  private modeMessage(): ViewerToPageMessage {
    return { pinwall: 1, type: 'set-mode', mode: this.opts.mode };
  }

  private pin(id: string): ViewerPin | undefined {
    return this.opts.pins.find((p) => p.id === id);
  }

  private root(): Window | null {
    return this.frame?.contentWindow ?? null;
  }

  /**
   * Forgets bound windows that are no longer inside the content frame: frames of a document
   * the content frame left lose their parent. Returns whether any was forgotten.
   */
  private prune(): boolean {
    const root = this.root();
    let gone = false;
    for (const win of [...this.frames.keys()]) {
      if (!isWithinFrame(win, root)) {
        this.frames.delete(win);
        gone = true;
      }
    }
    return gone;
  }

  /** The bound windows still inside the content frame. */
  private live(): [Window, FrameRecord][] {
    if (this.prune()) this.publish({});
    return [...this.frames];
  }

  /** Drops every binding and pending `load` answer: the frame is about to load a new document. */
  private forgetDocument(): void {
    this.clearMissing();
    this.frames.clear();
    this.loadAnswered = true;
    this.readyAhead = false;
  }

  private reset(grant: Grant): void {
    this.loaded = grant;
    this.latest = grant;
    this.clearReload();
    this.forgetDocument();
    this.pendingFocus = null;
    const page = this.opts.startPage ?? '';
    this.publish({
      src: grant.base === '' ? '' : pageUrl(grant.base, page),
      loading: true,
      annotator: 'waiting',
      topPage: page,
    });
  }

  /** Moves the frame to the newest grant when the one it loaded from is about to expire. */
  private armReload(): void {
    this.clearReload();
    const expiresAt = this.loaded.expiresAt;
    if (!this.started || this.latest.base === this.loaded.base || expiresAt === undefined) return;
    const reload = () => {
      this.reloadTimer = undefined;
      this.navigate(this.snapshot.topPage);
    };
    const wait = expiresAt - RELOAD_BEFORE_EXPIRY_MS - Date.now();
    if (wait <= 0) reload();
    else this.reloadTimer = setTimeout(reload, wait);
  }

  private clearMissing(): void {
    if (this.missingTimer !== undefined) clearTimeout(this.missingTimer);
    this.missingTimer = undefined;
  }

  private clearReload(): void {
    if (this.reloadTimer !== undefined) clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
  }

  private publish(patch: Partial<Omit<Snapshot, 'frames'>>): void {
    this.prune();
    this.snapshot = { ...this.snapshot, ...patch, frames: [...this.frames.values()] };
    for (const fn of this.subscribers) fn();
  }
}

/** What the frames could be told about `pins`, as one string. */
function keyOf(pins: readonly ViewerPin[]): string {
  return JSON.stringify(pins.map((p) => [p.id, p.number, p.resolved, p.anchor]));
}

/**
 * Connects the review frame showing `baseUrl` (a content grant's URL) to the
 * annotators inside it. Messages count only from the frame's window or frames
 * inside it, and only when they pass the protocol schema. The frame windows
 * that posted `ready` each get the mode and the anchors of their own page, and
 * nothing else does. Frame messages change view state only: they reach the
 * callbacks, never the network or the app's location.
 */
export function useFrameBridge(baseUrl: string, o: FrameBridgeOptions): FrameBridge {
  const { version, expiresAt } = o;
  const [bridge] = useState(() => new Bridge({ base: baseUrl, version, expiresAt }, o));
  useLayoutEffect(() => {
    bridge.setOptions(o);
  });
  useLayoutEffect(() => {
    bridge.setGrant({ base: baseUrl, version, expiresAt });
  }, [bridge, baseUrl, version, expiresAt]);
  useEffect(() => bridge.start(), [bridge]);
  const s = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  return useMemo(
    () => ({
      src: s.src,
      frameRef: bridge.frameRef,
      onFrameLoad: bridge.onFrameLoad,
      loading: s.loading,
      annotator: s.annotator,
      topPage: s.topPage,
      placement: (pin: { id: string; anchor: Anchor }) => placementOf(s, pin),
      focus: bridge.focus,
      navigate: bridge.navigate,
      scrollTo: bridge.scrollTo,
    }),
    [bridge, s],
  );
}
