import type { Anchor } from '@pinwall/shared/protocol';
import { afterEach, beforeEach, vi } from 'vitest';
import { type Annotator, type BootOptions, boot } from '../../src/boot.ts';
import { anchorOf } from './dom.ts';
import { asUser } from './user-events.ts';

export const SCRIPT_SRC = 'http://localhost:3000/c/tok/__pinwall/annotator.js';
/** Boot options of a frame whose viewer is this very window (the tests play the viewer). */
export const bootOptions: BootOptions = { scriptSrc: SCRIPT_SRC, top: window };

export const PAGE_HTML =
  '<main id="main"><p id="p1">Alpha beta gamma delta</p><a href="#x" id="l">a link</a></main>';

type Message = { type?: unknown } & Record<string, unknown>;

let posted: Message[] = [];
let running: Annotator[] = [];

/**
 * Before each test: the frame shows `/c/tok/docs/` with `PAGE_HTML`, and what the annotator
 * posts to its viewer (`window.postMessage`, as top is this window) is captured. After each test,
 * every annotator `start` booted is destroyed.
 */
export function useRuntime(): void {
  beforeEach(() => {
    history.replaceState(null, '', '/c/tok/docs/');
    document.head.replaceChildren();
    document.body.innerHTML = PAGE_HTML;
    posted = [];
    vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Message);
    });
  });
  afterEach(() => {
    for (const annotator of running) annotator.destroy();
    running = [];
    document.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });
}

/** Boots the annotator of this window; throws when it does not boot. */
export function start(opts: BootOptions = bootOptions): Annotator {
  const annotator = boot(window, opts);
  if (!annotator) throw new Error('the annotator did not boot');
  running.push(annotator);
  return annotator;
}

/** A message to this window, from the viewer (this window) unless `source` says otherwise. */
export function send(data: unknown, source: MessageEventSource | null = window): void {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

/** The messages posted to the viewer so far, of `type`. */
export function sent(type: string): Message[] {
  return posted.filter((message) => message.type === type);
}

export function setMode(mode: 'browse' | 'comment'): void {
  send({ pinwall: 1, type: 'set-mode', mode });
}

export interface ShownAnchor {
  id: string;
  number: number;
  resolved?: boolean;
  anchor: Anchor;
}

export function showAnchors(anchors: ShownAnchor[]): void {
  send({
    pinwall: 1,
    type: 'show-anchors',
    anchors: anchors.map((a) => ({ resolved: false, ...a })),
  });
}

/** A text anchor of page `docs/` quoting `exact`, with no DOM path. */
export function quoteAnchor(exact: string, over: Partial<Anchor> = {}): Anchor {
  return anchorOf({ quote: { exact, prefix: '', suffix: '' }, dom: undefined, ...over });
}

/** An element anchor of page `docs/` at `path`. */
export function elementAt(path: string, over: Partial<Anchor> = {}): Anchor {
  return anchorOf({ kind: 'element', quote: undefined, dom: { path }, ...over });
}

/** A point anchor of page `docs/` at fractions `x`, `y` of the document. */
export function pointAt(x: number, y: number, over: Partial<Anchor> = {}): Anchor {
  return anchorOf({ kind: 'point', quote: undefined, dom: undefined, position: { x, y }, ...over });
}

/** The overlay host; throws when there is none. */
export function overlayHost(): HTMLElement {
  const host = document.querySelector<HTMLElement>('pinwall-overlay');
  if (!host) throw new Error('no overlay host');
  return host;
}

/** Every pin in the overlay, in order. */
export function pinButtons(): HTMLElement[] {
  return Array.from(overlayHost().shadowRoot?.querySelectorAll<HTMLElement>('[data-pin-id]') ?? []);
}

/** The pin of thread `id`; throws when there is none. */
export function pinOf(id: string): HTMLElement {
  const pin = pinButtons().find((button) => button.getAttribute('data-pin-id') === id);
  if (!pin) throw new Error(`no pin ${id}`);
  return pin;
}

/** Resolves after the next animation frame (and so after a throttled layout). */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** A cancelable click of the user on `target`, returned after dispatch. */
export function click(target: EventTarget, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  target.dispatchEvent(asUser(event));
  return event;
}

/** The user releasing the mouse button over `target`. */
export function mouseUp(target: EventTarget): void {
  target.dispatchEvent(asUser(new MouseEvent('mouseup', { bubbles: true, cancelable: true })));
}
