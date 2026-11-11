/**
 * The pins, highlights and hover outline the annotator draws over a page. Everything lives in the
 * open shadow root of one `<pinwall-overlay>` element appended to `<html>`: absolutely positioned
 * and zero-sized, so it never moves page content, and styled only from inside its shadow tree
 * plus `!important` inline declarations on the host, so page CSS cannot hide or restyle it.
 * Page nodes are never moved, wrapped or restyled; pins follow them by measuring.
 */
import type { Anchor } from '@pinwall/shared/protocol';
import { type DocPoint, docSize, fromFraction, viewportSize } from './geometry.ts';
import { guard } from './guard.ts';
import { addListener, eventTarget, preventDefault, stopPropagation } from './pristine.ts';
import type { Placement } from './reattach.ts';

/** A thread's pin: what the viewer sent, and where `placeAnchor` put it. */
export interface PinSpec {
  id: string;
  number: number;
  resolved: boolean;
  anchor: Anchor;
  placement: Placement;
}

export interface Overlay {
  /** The `<pinwall-overlay>` element; its shadow root holds everything drawn. */
  readonly host: HTMLElement;
  /** Replaces every pin, then lays them out. */
  setPins(pins: PinSpec[]): void;
  /** Measures again and moves pins and highlights; puts the host back if the page removed it. */
  layout(): void;
  /** Outlines `el` (what a click would pick in comment mode), or nothing. */
  hover(el: Element | null): void;
  /** Scrolls the pin of thread `id` into view and marks it for a moment. False for no such pin. */
  focus(id: string): boolean;
  /** Removes the host for good. */
  destroy(): void;
}

const HOST_TAG = 'pinwall-overlay';
const PIN_SIZE = 22;
/** How far up and to the left of its anchor a pin's centre sits. */
const PIN_OFFSET = 12;
/** How long a focused pin stays marked. */
const FOCUS_MS = 1500;
/** Most highlight boxes one text anchor draws (one per line box). */
const MAX_MARKS = 200;

/** The host's inline declarations, each `!important`: `all: initial` first, so it resets the rest. */
const HOST_STYLE: readonly (readonly [string, string])[] = [
  ['all', 'initial'],
  ['display', 'block'],
  ['position', 'absolute'],
  ['left', '0'],
  ['top', '0'],
  ['width', '0'],
  ['height', '0'],
  ['overflow', 'visible'],
  ['z-index', '2147483647'],
  ['pointer-events', 'none'],
];

const SHADOW_CSS = `
.layer { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; }
.mark, .outline, .hover { position: absolute; box-sizing: border-box; pointer-events: none; }
.mark { background: rgba(250, 204, 21, 0.32); border-radius: 2px; }
.mark[data-resolved] { background: rgba(148, 163, 184, 0.22); }
.outline { border: 2px solid rgba(17, 24, 39, 0.45); border-radius: 3px; }
.outline[data-resolved] { border-color: rgba(148, 163, 184, 0.45); }
.hover { display: none; border: 2px dashed rgba(37, 99, 235, 0.85); background: rgba(37, 99, 235, 0.06); border-radius: 3px; }
.hover[data-on] { display: block; }
.pin {
  position: absolute; box-sizing: border-box; display: block; margin: 0; padding: 0;
  width: ${PIN_SIZE}px; height: ${PIN_SIZE}px; border: 2px solid #ffffff;
  border-radius: 50% 50% 50% 4px; background: #111827; color: #ffffff;
  font: 600 11px/18px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  text-align: center; cursor: pointer; pointer-events: auto; user-select: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35); transition: transform 120ms ease, box-shadow 120ms ease;
}
.pin[data-resolved] { background: #6b7280; }
.pin:hover { transform: scale(1.12); }
.pin[data-focus] { transform: scale(1.25); box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.45); }
@media (prefers-reduced-motion: reduce) {
  .pin { transition: none; }
  .pin:hover, .pin[data-focus] { transform: none; }
}
`;

interface Pin {
  spec: PinSpec;
  button: HTMLElement;
  marks: HTMLElement[];
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, value));
}

/** Writes `!important` inline declarations through the CSSOM (allowed under any style-src). */
function setStyles(el: HTMLElement, styles: readonly (readonly [string, string])[]): void {
  for (const [name, value] of styles) el.style.setProperty(name, value, 'important');
}

function place(el: HTMLElement, left: number, top: number, width?: number, height?: number): void {
  el.style.setProperty('left', `${finite(left)}px`);
  el.style.setProperty('top', `${finite(top)}px`);
  if (width !== undefined) el.style.setProperty('width', `${finite(width)}px`);
  if (height !== undefined) el.style.setProperty('height', `${finite(height)}px`);
}

function isEmpty(rect: DOMRect | undefined): boolean {
  return !rect || !(rect.width > 0 || rect.height > 0);
}

/** The client rects of a range, when the browser has them (jsdom's ranges do not). */
function rangeRects(range: Range): DOMRect[] {
  if (typeof range.getClientRects !== 'function') return [];
  const rects: DOMRect[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (!isEmpty(rect)) rects.push(rect);
    if (rects.length >= MAX_MARKS) break;
  }
  return rects;
}

function boundingRect(el: Element): DOMRect | undefined {
  return typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : undefined;
}

/** The element a range starts in. */
function startElement(range: Range): Element | null {
  const node = range.startContainer;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** Applies the shadow stylesheet: an adopted sheet when the browser has them, else `<style>`. */
function adoptStyles(doc: Document, shadow: ShadowRoot): void {
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  try {
    const Sheet = win?.CSSStyleSheet;
    if (
      Sheet &&
      'adoptedStyleSheets' in shadow &&
      typeof Sheet.prototype.replaceSync === 'function'
    ) {
      const sheet = new Sheet();
      sheet.replaceSync(SHADOW_CSS);
      shadow.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    // Fall back to a style element.
  }
  const style = doc.createElement('style');
  style.textContent = SHADOW_CSS;
  shadow.appendChild(style);
}

/** Creates the overlay host (it joins the document at the first `layout`). */
export function createOverlay(doc: Document, onPinClick: (id: string) => void): Overlay {
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  const host = doc.createElement(HOST_TAG);
  setStyles(host, HOST_STYLE);
  const shadow = host.attachShadow({ mode: 'open' });
  adoptStyles(doc, shadow);
  const layer = (name: string) => {
    const el = doc.createElement('div');
    el.className = name;
    shadow.appendChild(el);
    return el;
  };
  const marksLayer = layer('layer');
  const hoverBox = layer('hover');
  const pinsLayer = layer('layer');

  let pins = new Map<string, Pin>();
  let hovered: Element | null = null;
  let focused: HTMLElement | null = null;
  let focusTimer: number | undefined;
  let destroyed = false;

  addListener(
    shadow,
    'click',
    guard((event: MouseEvent) => {
      for (let node = eventTarget(event) as Node | null; node && node !== shadow; ) {
        if (node.nodeType === 1 && (node as Element).hasAttribute('data-pin-id')) {
          // The page never sees clicks on pins.
          stopPropagation(event);
          preventDefault(event);
          onPinClick((node as Element).getAttribute('data-pin-id') as string);
          return;
        }
        node = node.parentNode;
      }
    }),
  );

  const scroll = (): DocPoint => ({ x: finite(win?.scrollX ?? 0), y: finite(win?.scrollY ?? 0) });

  /** The document point of a client rect's top-left corner. */
  const toDoc = (rect: DOMRect, at: DocPoint): DocPoint => ({
    x: rect.left + at.x,
    y: rect.top + at.y,
  });

  const setMarks = (pin: Pin, boxes: DOMRect[], at: DocPoint, origin: DocPoint, kind: string) => {
    while (pin.marks.length > boxes.length) pin.marks.pop()?.remove();
    while (pin.marks.length < boxes.length) {
      const mark = doc.createElement('div');
      if (pin.spec.resolved) mark.setAttribute('data-resolved', '');
      marksLayer.appendChild(mark);
      pin.marks.push(mark);
    }
    boxes.forEach((box, i) => {
      const mark = pin.marks[i] as HTMLElement;
      mark.className = kind;
      const corner = toDoc(box, at);
      place(mark, corner.x - origin.x, corner.y - origin.y, box.width, box.height);
    });
  };

  /** Where a pin's anchor is, in document pixels, drawing its highlight on the way. */
  const anchorPoint = (pin: Pin, at: DocPoint, origin: DocPoint): DocPoint => {
    const { placement, anchor } = pin.spec;
    if (placement.via === 'quote') {
      const rects = rangeRects(placement.range);
      setMarks(pin, rects, at, origin, 'mark');
      const first = rects[0];
      if (first) return toDoc(first, at);
    } else if (placement.via === 'dom' && placement.element.isConnected) {
      const rect = boundingRect(placement.element);
      if (rect && !isEmpty(rect)) {
        setMarks(pin, [rect], at, origin, 'outline');
        return toDoc(rect, at);
      }
      setMarks(pin, [], at, origin, 'outline');
    } else {
      setMarks(pin, [], at, origin, 'mark');
    }
    return fromFraction(doc, anchor.position);
  };

  const drawHover = (at: DocPoint, origin: DocPoint) => {
    const rect = hovered?.isConnected ? boundingRect(hovered) : undefined;
    if (!rect || isEmpty(rect)) {
      hoverBox.removeAttribute('data-on');
      return;
    }
    const corner = toDoc(rect, at);
    place(hoverBox, corner.x - origin.x, corner.y - origin.y, rect.width, rect.height);
    hoverBox.setAttribute('data-on', '');
  };

  const layout = () => {
    if (destroyed) return;
    const root = doc.documentElement;
    if (!host.isConnected && root) root.appendChild(host);
    const at = scroll();
    // The host's own document origin: non-zero when the page positions or offsets <html>.
    const hostRect = boundingRect(host);
    const origin = hostRect ? toDoc(hostRect, at) : { x: 0, y: 0 };
    const size = docSize(doc);
    for (const pin of pins.values()) {
      const point = anchorPoint(pin, at, origin);
      const x = clamp(point.x - PIN_OFFSET - PIN_SIZE / 2, 0, size.width - PIN_SIZE);
      const y = clamp(point.y - PIN_OFFSET - PIN_SIZE / 2, 0, size.height - PIN_SIZE);
      place(pin.button, x - origin.x, y - origin.y);
    }
    drawHover(at, origin);
  };

  const makeButton = (spec: PinSpec): HTMLElement => {
    const button = doc.createElement('button');
    button.className = 'pin';
    button.setAttribute('type', 'button');
    button.setAttribute('tabindex', '-1');
    button.setAttribute('data-pin-id', spec.id);
    button.setAttribute('aria-label', `Comment ${spec.number}`);
    if (spec.resolved) button.setAttribute('data-resolved', '');
    button.textContent = String(spec.number);
    return button;
  };

  const clearFocus = () => {
    if (focusTimer !== undefined) win?.clearTimeout(focusTimer);
    focusTimer = undefined;
    focused?.removeAttribute('data-focus');
    focused = null;
  };

  const reducedMotion = (): boolean => {
    try {
      return win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    } catch {
      return false;
    }
  };

  /** Scrolls the anchor of `spec` to the middle of the viewport. */
  const reveal = (spec: PinSpec) => {
    const behavior: ScrollBehavior = reducedMotion() ? 'auto' : 'smooth';
    const { placement } = spec;
    const target =
      placement.via === 'quote'
        ? startElement(placement.range)
        : placement.via === 'dom'
          ? placement.element
          : null;
    if (target?.isConnected && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior });
      return;
    }
    if (!win || typeof win.scrollTo !== 'function') return;
    const point = fromFraction(doc, spec.anchor.position);
    const view = viewportSize(doc);
    win.scrollTo({
      left: Math.max(0, point.x - view.width / 2),
      top: Math.max(0, point.y - view.height / 2),
      behavior,
    });
  };

  return {
    host,
    setPins(specs) {
      for (const pin of pins.values()) {
        pin.button.remove();
        for (const mark of pin.marks) mark.remove();
      }
      clearFocus();
      pins = new Map();
      for (const spec of specs) {
        const button = makeButton(spec);
        pinsLayer.appendChild(button);
        pins.set(spec.id, { spec, button, marks: [] });
      }
      layout();
    },
    layout,
    hover(el) {
      hovered = el;
      if (destroyed) return;
      const at = scroll();
      const hostRect = boundingRect(host);
      drawHover(at, hostRect ? toDoc(hostRect, at) : { x: 0, y: 0 });
    },
    focus(id) {
      const pin = pins.get(id);
      if (!pin || destroyed) return false;
      reveal(pin.spec);
      clearFocus();
      focused = pin.button;
      focused.setAttribute('data-focus', '');
      focusTimer = win?.setTimeout(guard(clearFocus), FOCUS_MS);
      return true;
    },
    destroy() {
      destroyed = true;
      clearFocus();
      host.remove();
    },
  };
}
