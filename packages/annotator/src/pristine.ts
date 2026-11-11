/**
 * Built-in methods the annotator relies on, taken when its script runs. The script tag comes
 * before every page script, so these are the browser's own: a page that later replaces or wraps
 * them (a polyfill, an analytics library, hostile code) cannot change what the annotator does.
 *
 * Each method is "uncurried": it takes its receiver as the first argument and calls the captured
 * function directly, so later patches of `Function.prototype.call` or `bind` do not reach it
 * either. A method the environment lacks throws when called; callers run under `guard`.
 *
 * Messages to the viewer go through `top.postMessage` instead: the viewer's window is
 * cross-origin, so the page cannot replace what that property returns, and a method taken from
 * this window could not be called on another one.
 */

// biome-ignore lint/suspicious/noExplicitAny: an uncurried built-in has the signature its wrapper declares
type AnyFunction = (...args: any[]) => any;

const { bind, call } = Function.prototype;
const uncurryThis = bind.bind(call) as (fn: AnyFunction) => AnyFunction;

function missing(name: string): AnyFunction {
  return () => {
    throw new TypeError(`${name} is not available`);
  };
}

/** `owner[name]` as a function taking its `this` first. */
function method(owner: object | undefined, name: string): AnyFunction {
  try {
    const fn: unknown = owner === undefined ? undefined : Reflect.get(owner, name);
    return typeof fn === 'function' ? uncurryThis(fn as AnyFunction) : missing(name);
  } catch {
    return missing(name);
  }
}

/** The getter of `owner[name]` as a function of the receiver. */
function getter(owner: object | undefined, name: string): AnyFunction {
  try {
    const get = owner === undefined ? undefined : Object.getOwnPropertyDescriptor(owner, name)?.get;
    return typeof get === 'function' ? uncurryThis(get) : missing(name);
  } catch {
    return missing(name);
  }
}

/** `object` when `name` is its own property, else undefined. */
function ownerOf(object: object | undefined, name: string): object | undefined {
  return object !== undefined && Object.hasOwn(object, name) ? object : undefined;
}

const EventTargetProto = typeof EventTarget === 'function' ? EventTarget.prototype : undefined;
const EventProto = typeof Event === 'function' ? Event.prototype : undefined;
const MessageEventProto = typeof MessageEvent === 'function' ? MessageEvent.prototype : undefined;
const DocumentProto = typeof Document === 'function' ? Document.prototype : undefined;
const RangeProto = typeof Range === 'function' ? Range.prototype : undefined;
const SelectionProto = typeof Selection === 'function' ? Selection.prototype : undefined;

type Listener = (event: never) => void;

/** `EventTarget.prototype.addEventListener`, for nodes (the document, the overlay's shadow root). */
export const addListener: (
  target: EventTarget,
  type: string,
  listener: Listener,
  options?: AddEventListenerOptions,
) => void = method(EventTargetProto, 'addEventListener');

export const removeListener: (
  target: EventTarget,
  type: string,
  listener: Listener,
  options?: EventListenerOptions,
) => void = method(EventTargetProto, 'removeEventListener');

export interface WindowListeners {
  add(type: string, listener: Listener, options?: AddEventListenerOptions): void;
  remove(type: string, listener: Listener, options?: EventListenerOptions): void;
}

/**
 * The window's `addEventListener` and `removeEventListener` as they are now: `boot` takes them
 * while the script loads. Read from the window itself rather than from `EventTarget.prototype`,
 * for environments whose global object carries its own (jsdom under Vitest).
 */
export function windowListeners(win: Window): WindowListeners {
  const add = uncurryThis(win.addEventListener);
  const remove = uncurryThis(win.removeEventListener);
  return {
    add: (type, listener, options) => add(win, type, listener, options),
    remove: (type, listener, options) => remove(win, type, listener, options),
  };
}

export const preventDefault: (event: Event) => void = method(EventProto, 'preventDefault');
export const stopImmediatePropagation: (event: Event) => void = method(
  EventProto,
  'stopImmediatePropagation',
);
export const stopPropagation: (event: Event) => void = method(EventProto, 'stopPropagation');
/**
 * Whether the browser made `event` for a real user action, not a script (`el.click()`,
 * `dispatchEvent`). `isTrusted` is an own, non-configurable property of every event, so the page
 * cannot redefine it; its getter is taken from an event made here (from `Event.prototype` in an
 * environment that keeps it there).
 */
export const isTrusted: (event: Event) => boolean = getter(
  ownerOf(typeof Event === 'function' ? new Event('pinwall') : undefined, 'isTrusted') ??
    EventProto,
  'isTrusted',
);
/** The event's target as the current listener sees it (retargeted out of shadow trees). */
export const eventTarget: (event: Event) => EventTarget | null = getter(EventProto, 'target');
export const messageSource: (event: MessageEvent) => MessageEventSource | null = getter(
  MessageEventProto,
  'source',
);
export const messageData: (event: MessageEvent) => unknown = getter(MessageEventProto, 'data');

export const querySelector: (doc: Document, selector: string) => Element | null = method(
  DocumentProto,
  'querySelector',
);
export const querySelectorAll: (doc: Document, selector: string) => NodeListOf<Element> = method(
  DocumentProto,
  'querySelectorAll',
);
export const createRange: (doc: Document) => Range = method(DocumentProto, 'createRange');
export const getSelection: (doc: Document) => Selection | null = method(
  DocumentProto,
  'getSelection',
);
export const setStart: (range: Range, node: Node, offset: number) => void = method(
  RangeProto,
  'setStart',
);
export const setEnd: (range: Range, node: Node, offset: number) => void = method(
  RangeProto,
  'setEnd',
);
export const rangeCount: (selection: Selection) => number = getter(SelectionProto, 'rangeCount');
export const isCollapsed: (selection: Selection) => boolean = getter(SelectionProto, 'isCollapsed');
export const getRangeAt: (selection: Selection, index: number) => Range = method(
  SelectionProto,
  'getRangeAt',
);

export const normalize: (text: string, form: 'NFC') => string = method(
  String.prototype,
  'normalize',
);

const exec: (re: RegExp, text: string) => RegExpExecArray | null = method(RegExp.prototype, 'exec');

/** Whether `re` (not global, not sticky) matches somewhere in `text`. */
export function matches(re: RegExp, text: string): boolean {
  return exec(re, text) !== null;
}

/** Calls `fn` with each match of the global `re` in `text`, in order. */
export function eachMatch(re: RegExp, text: string, fn: (match: RegExpExecArray) => void): void {
  re.lastIndex = 0;
  for (let match = exec(re, text); match !== null; match = exec(re, text)) {
    if (match[0] === '') re.lastIndex++;
    fn(match);
  }
}

/** The URL constructor and `decodeURIComponent` as the script found them. */
export const URLClass: typeof URL = URL;
export const decodeComponent: (text: string) => string = decodeURIComponent;
