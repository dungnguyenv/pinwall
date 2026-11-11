import { ANNOTATOR_GLOBAL, PROTOCOL_VERSION } from '@pinwall/shared/protocol';
import { JSDOM } from 'jsdom';
import { expect, onTestFinished, test, vi } from 'vitest';
import { boot } from '../src/boot.ts';
import { guard } from '../src/guard.ts';
import { postToViewer } from '../src/messaging.ts';
import { buildTextIndex } from '../src/text-index.ts';
import { el, rangeOf } from './helpers/dom.ts';
import {
  bootOptions,
  click,
  elementAt,
  pointAt,
  quoteAnchor,
  SCRIPT_SRC,
  send,
  sent,
  setMode,
  showAnchors,
  start,
  useRuntime,
} from './helpers/runtime.ts';

vi.mock('../src/text-index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/text-index.ts')>();
  return { ...actual, buildTextIndex: vi.fn(actual.buildTextIndex) };
});

useRuntime();

const opts = bootOptions;
const FRAME_ID = /^[0-9a-f]{16}$/;

function select(text: string): void {
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(rangeOf(text));
}

function mouseUp(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
}

/** Records `error` events on the window until the test finishes. */
function windowErrors(): ErrorEvent[] {
  const errors: ErrorEvent[] = [];
  const listener = (event: ErrorEvent) => errors.push(event);
  window.addEventListener('error', listener);
  onTestFinished(() => window.removeEventListener('error', listener));
  return errors;
}

test('boots once, adds one global and patches no prototype', () => {
  const before = new Set(Object.getOwnPropertyNames(window));
  const classes = [
    EventTarget,
    Node,
    Element,
    HTMLElement,
    Document,
    Range,
    Selection,
    History,
    Window,
  ];
  const protos = classes.map((C) => Object.getOwnPropertyNames(C.prototype).join());
  const a = boot(window, opts);
  expect(Object.getOwnPropertyNames(window).filter((k) => !before.has(k))).toEqual([
    '__pinwallAnnotator',
  ]);
  expect(classes.map((C) => Object.getOwnPropertyNames(C.prototype).join())).toEqual(protos);
  expect(boot(window, opts)).toBeNull();
  const descriptor = Object.getOwnPropertyDescriptor(window, ANNOTATOR_GLOBAL);
  expect(descriptor).toMatchObject({ enumerable: false, configurable: true, writable: false });
  expect(descriptor?.value).toEqual({ protocol: PROTOCOL_VERSION, frameId: a?.frameId });
  expect(Object.isFrozen(descriptor?.value)).toBe(true);
  a?.destroy();
  expect(ANNOTATOR_GLOBAL in window).toBe(false);
});

test('posts ready with its page and a frame id', () => {
  const annotator = start();
  expect(sent('ready')).toEqual([
    { pinwall: 1, type: 'ready', page: 'docs/', frameId: expect.stringMatching(FRAME_ID) },
  ]);
  expect(sent('ready')[0]?.frameId).toBe(annotator.frameId);
  expect(annotator.page).toBe('docs/');
  expect(window.postMessage).toHaveBeenCalledWith(expect.anything(), '*');
});

test('does nothing outside a grant', () => {
  expect(boot(window, { ...opts, scriptSrc: 'http://localhost:3000/app.js' })).toBeNull();
  expect(boot(window, { ...opts, scriptSrc: null })).toBeNull();
  history.replaceState(null, '', '/elsewhere/page.html');
  expect(boot(window, opts)).toBeNull();
  // A page longer than any message may carry.
  history.replaceState(null, '', `/c/tok/${'p'.repeat(1025)}`);
  expect(boot(window, opts)).toBeNull();
  history.replaceState(null, '', '/c/tok/docs/');
  expect(boot(window, { ...opts, top: null })).toBeNull();
  expect(window.postMessage).not.toHaveBeenCalled();
  expect(ANNOTATOR_GLOBAL in window).toBe(false);
  expect(document.querySelector('pinwall-overlay')).toBeNull();
});

test('ignores messages not from window.top and invalid messages', () => {
  start();
  const frame = document.createElement('iframe');
  document.body.append(frame);
  send({ pinwall: 1, type: 'set-mode', mode: 'comment' }, frame.contentWindow);
  send({ type: 'set-mode', mode: 'comment' });
  send({ pinwall: 2, type: 'set-mode', mode: 'comment' });
  send({ pinwall: 1, type: 'set-mode', mode: 'draw' });
  expect(click(el('#p1')).defaultPrevented).toBe(false);
  expect(sent('anchor-picked')).toEqual([]);

  setMode('comment');
  expect(click(el('#p1')).defaultPrevented).toBe(true);
  expect(sent('anchor-picked')).toHaveLength(1);
});

test('viewer messages stop at the annotator; the page still gets its own', () => {
  start();
  const seen: unknown[] = [];
  window.addEventListener('message', (event) => seen.push(event.data));
  setMode('comment');
  send({ hello: 'page' });
  send({ pinwall: 1, type: 'set-mode', mode: 'browse' }, null);
  expect(seen).toEqual([{ hello: 'page' }, { pinwall: 1, type: 'set-mode', mode: 'browse' }]);
});

test('comment mode: a selection posts a text anchor and swallows the click', async () => {
  const { frameId } = start();
  setMode('comment');
  select('beta gamma');
  mouseUp(el('#p1'));
  const event = click(el('#p1'));
  expect(sent('anchor-picked')).toEqual([
    {
      pinwall: 1,
      type: 'anchor-picked',
      anchor: expect.objectContaining({
        kind: 'text',
        page: 'docs/',
        quote: { exact: 'beta gamma', prefix: 'Alpha ', suffix: ' deltaa link' },
        dom: { path: '#p1' },
      }),
      frameId,
    },
  ]);
  expect(event.defaultPrevented).toBe(true);

  // The swallowed click was the selection's own; the next one picks an element again.
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.getSelection()?.removeAllRanges();
  click(el('#p1'));
  expect(sent('anchor-picked').map((m) => (m.anchor as { kind: string }).kind)).toEqual([
    'text',
    'element',
  ]);
});

test('comment mode: a mouseup without selected text picks nothing', () => {
  start();
  setMode('comment');
  mouseUp(el('#p1'));
  select(' ');
  mouseUp(el('#p1'));
  expect(sent('anchor-picked')).toEqual([]);
});

test('comment mode swallows clicks before page handlers', () => {
  start();
  const link = el('#l');
  const pageCapture = vi.fn();
  const pageHandler = vi.fn((event: Event) => event.stopPropagation());
  window.addEventListener('click', pageCapture, true);
  link.addEventListener('click', pageHandler);
  onTestFinished(() => window.removeEventListener('click', pageCapture, true));
  setMode('comment');

  const event = click(link);
  (link as HTMLAnchorElement).click();
  expect(pageCapture).not.toHaveBeenCalled();
  expect(pageHandler).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
  expect(location.hash).toBe('');
  const picked = sent('anchor-picked');
  expect(picked).toHaveLength(2);
  expect(picked[0]?.anchor).toMatchObject({ kind: 'element', dom: { path: '#l' } });
});

test('comment mode: alt-click, clicks on body and clicks on page-sized boxes are point anchors', () => {
  start();
  setMode('comment');
  click(el('#p1'), { altKey: true, clientX: 10, clientY: 20 });
  click(document.body);
  const main = el('#main');
  main.getBoundingClientRect = () => new DOMRect(0, 0, innerWidth, innerHeight * 0.85);
  click(main);
  main.getBoundingClientRect = () => new DOMRect(0, 0, innerWidth / 2, innerHeight / 2);
  click(main);
  expect(sent('anchor-picked').map((m) => (m.anchor as { kind: string }).kind)).toEqual([
    'point',
    'point',
    'point',
    'element',
  ]);
});

test('comment mode: middle clicks never reach the page', () => {
  start();
  const pageHandler = vi.fn();
  el('#l').addEventListener('auxclick', pageHandler);
  setMode('comment');
  const event = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  el('#l').dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(pageHandler).not.toHaveBeenCalled();
  expect(sent('anchor-picked')).toEqual([]);
});

test('browse mode leaves clicks alone', () => {
  start();
  const pageHandler = vi.fn();
  el('#p1').addEventListener('click', pageHandler);
  setMode('comment');
  setMode('browse');
  select('beta');
  mouseUp(el('#p1'));
  const event = click(el('#p1'));
  expect(pageHandler).toHaveBeenCalledTimes(1);
  expect(event.defaultPrevented).toBe(false);
  expect(sent('anchor-picked')).toEqual([]);
});

test('messages that arrive before the DOM is ready wait for it', () => {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
  onTestFinished(() => {
    Reflect.deleteProperty(document, 'readyState');
  });
  start();
  setMode('comment');
  showAnchors([{ id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') }]);
  expect(sent('ready')).toEqual([]);
  expect(sent('anchors-placed')).toEqual([]);
  expect(document.querySelector('pinwall-overlay')).toBeNull();

  Reflect.deleteProperty(document, 'readyState');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  expect(sent('ready')).toHaveLength(1);
  expect(sent('anchors-placed')).toMatchObject([{ results: [{ id: 'c1', found: true }] }]);
  click(el('#p1'));
  expect(sent('anchor-picked')).toHaveLength(1);
});

test('a same-document navigation posts navigated and re-applies anchors', () => {
  const { frameId } = start();
  showAnchors([
    { id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') },
    { id: 'c9', number: 9, anchor: pointAt(0.5, 0.5, { page: 'b.html' }) },
  ]);
  history.pushState(null, '', '/c/tok/b.html#top');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(sent('navigated')).toEqual([{ pinwall: 1, type: 'navigated', page: 'b.html', frameId }]);
  expect(sent('anchors-placed').at(-1)).toEqual({
    pinwall: 1,
    type: 'anchors-placed',
    results: [{ id: 'c9', found: true }],
    frameId,
  });
  // A fragment change is not another page.
  history.pushState(null, '', '/c/tok/b.html#bottom');
  window.dispatchEvent(new PopStateEvent('popstate'));
  expect(sent('navigated')).toHaveLength(1);
});

test('a pushState navigation is noticed within a second', () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  start();
  history.pushState(null, '', '/c/tok/');
  vi.advanceTimersByTime(1000);
  expect(sent('navigated')).toMatchObject([{ page: '' }]);
  expect(sent('anchors-placed')).toMatchObject([{ results: [] }]);
});

test('a nested frame runs its own annotator and reports its own page', () => {
  const frame = new JSDOM('<!doctype html><p id="n">Nested text here</p>', {
    url: 'http://localhost:3000/c/tok/inner/a.html',
    pretendToBeVisual: true,
  }).window;
  onTestFinished(() => frame.close());
  const own = boot(frame, { scriptSrc: SCRIPT_SRC, top: window });
  onTestFinished(() => own?.destroy());
  expect(own?.page).toBe('inner/a.html');
  expect(sent('ready')).toEqual([
    { pinwall: 1, type: 'ready', page: 'inner/a.html', frameId: own?.frameId },
  ]);

  const show = {
    pinwall: 1,
    type: 'show-anchors',
    anchors: [
      { id: 'c1', number: 1, resolved: false, anchor: quoteAnchor('Nested', { page: 'docs/' }) },
      {
        id: 'c2',
        number: 2,
        resolved: false,
        anchor: quoteAnchor('Nested text', { page: 'inner/a.html' }),
      },
    ],
  };
  // From the frame itself: ignored. From the viewer (top): answered with its own anchors only.
  frame.dispatchEvent(new frame.MessageEvent('message', { data: show, source: frame }));
  expect(sent('anchors-placed')).toEqual([]);
  frame.dispatchEvent(new frame.MessageEvent('message', { data: show, source: window }));
  expect(sent('anchors-placed')).toEqual([
    {
      pinwall: 1,
      type: 'anchors-placed',
      results: [{ id: 'c2', found: true }],
      frameId: own?.frameId,
    },
  ]);
});

test('errors inside handlers never escape', () => {
  const errors = windowErrors();
  start();
  vi.mocked(buildTextIndex).mockImplementationOnce(() => {
    throw new Error('broken page');
  });
  expect(() =>
    showAnchors([
      { id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') },
      { id: 'c2', number: 2, anchor: elementAt('#l') },
    ]),
  ).not.toThrow();
  // The text could not be read: the quote falls back, the rest still places.
  expect(sent('anchors-placed')).toMatchObject([
    {
      results: [
        { id: 'c1', found: false },
        { id: 'c2', found: true },
      ],
    },
  ]);

  const scrollIntoView = vi.fn(() => {
    throw new Error('broken scroll');
  });
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  onTestFinished(() => {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });
  expect(() => send({ pinwall: 1, type: 'focus-anchor', id: 'c2' })).not.toThrow();
  expect(scrollIntoView).toHaveBeenCalled();
  expect(errors).toEqual([]);
});

test('destroy removes the global, the overlay and every listener', () => {
  const annotator = start();
  setMode('comment');
  annotator.destroy();
  annotator.destroy();
  expect(ANNOTATOR_GLOBAL in window).toBe(false);
  expect(document.querySelector('pinwall-overlay')).toBeNull();
  expect(click(el('#p1')).defaultPrevented).toBe(false);
  showAnchors([{ id: 'c1', number: 1, anchor: quoteAnchor('beta') }]);
  expect(sent('anchors-placed')).toEqual([]);
  expect(boot(window, opts)?.destroy()).toBeUndefined();
});

// Vitest fails the run on an unhandled rejection, so the async case needs no listener of its own.
test('guard swallows throws and rejections', async () => {
  const calls: number[] = [];
  const sync = guard((n: number) => {
    calls.push(n);
    throw new Error('sync');
  });
  const async = guard(async (n: number) => {
    calls.push(n);
    throw new Error('async');
  });
  expect(sync(1)).toBeUndefined();
  expect(async(2)).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(calls).toEqual([1, 2]);
});

test('postToViewer posts only what the schema allows', () => {
  const top = { postMessage: vi.fn() } as unknown as Window;
  postToViewer(top, { pinwall: 1, type: 'pin-clicked', id: '' });
  postToViewer(top, {
    pinwall: 1,
    type: 'anchor-picked',
    anchor: { ...pointAt(0.1, 0.2), body: 'a comment body' } as never,
    frameId: 'f1',
  });
  expect(top.postMessage).toHaveBeenCalledTimes(1);
  expect(top.postMessage).toHaveBeenCalledWith(
    { pinwall: 1, type: 'anchor-picked', anchor: pointAt(0.1, 0.2), frameId: 'f1' },
    '*',
  );
});
