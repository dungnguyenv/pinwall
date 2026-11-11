import { expect, onTestFinished, test, vi } from 'vitest';
import { el } from './helpers/dom.ts';
import { stubLayout } from './helpers/layout.ts';
import {
  elementAt,
  nextFrame,
  overlayHost,
  pinButtons,
  pinOf,
  pointAt,
  quoteAnchor,
  send,
  sent,
  setMode,
  showAnchors,
  start,
  useRuntime,
} from './helpers/runtime.ts';

useRuntime();

/** Defines `key` on `target` for this test only. */
function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  onTestFinished(() => {
    Reflect.deleteProperty(target, key);
  });
}

function shadowOf(host: HTMLElement): ShadowRoot {
  if (!host.shadowRoot) throw new Error('the overlay has no open shadow root');
  return host.shadowRoot;
}

function boxOf(element: Element | undefined): Record<string, string> {
  const style = (element as HTMLElement | undefined)?.style;
  return {
    left: style?.left ?? '',
    top: style?.top ?? '',
    width: style?.width ?? '',
    height: style?.height ?? '',
  };
}

test('show-anchors keeps this page only, draws numbered pins and reports found', () => {
  const { frameId } = start();
  showAnchors([
    { id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') },
    {
      id: 'c2',
      number: 2,
      resolved: true,
      anchor: quoteAnchor('gone', { dom: { path: '#gone' } }),
    },
    { id: 'c3', number: 3, anchor: quoteAnchor('beta gamma', { page: 'other.html' }) },
  ]);
  expect(sent('anchors-placed')).toEqual([
    {
      pinwall: 1,
      type: 'anchors-placed',
      results: [
        { id: 'c1', found: true },
        { id: 'c2', found: false },
      ],
      frameId,
    },
  ]);
  const pins = pinButtons();
  expect(pins.map((pin) => pin.getAttribute('data-pin-id'))).toEqual(['c1', 'c2']);
  expect(pins.map((pin) => pin.textContent)).toEqual(['1', '2']);
  expect(pins.map((pin) => pin.hasAttribute('data-resolved'))).toEqual([false, true]);
  expect(pins.map((pin) => pin.getAttribute('aria-label'))).toEqual(['Comment 1', 'Comment 2']);
  expect(pins.map((pin) => [pin.localName, pin.getAttribute('type'), pin.tabIndex])).toEqual([
    ['button', 'button', -1],
    ['button', 'button', -1],
  ]);

  // No anchor of this page: an empty answer, and no pins.
  showAnchors([{ id: 'c3', number: 3, anchor: quoteAnchor('beta', { page: 'other.html' }) }]);
  expect(sent('anchors-placed').at(-1)).toMatchObject({ results: [] });
  expect(pinButtons()).toEqual([]);
});

test('pins never touch the page DOM', () => {
  const before = document.body.innerHTML;
  start();
  setMode('comment');
  showAnchors([
    { id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') },
    { id: 'c2', number: 2, anchor: elementAt('#l') },
  ]);
  el('#l').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  expect(document.body.innerHTML).toBe(before);
  const host = overlayHost();
  expect(host.parentNode).toBe(document.documentElement);
  expect(document.querySelectorAll('pinwall-overlay')).toHaveLength(1);
  const expected: [string, string][] = [
    ['position', 'absolute'],
    ['width', '0px'],
    ['height', '0px'],
    ['pointer-events', 'none'],
    ['z-index', '2147483647'],
  ];
  for (const [name, value] of expected) {
    expect([name, host.style.getPropertyValue(name)]).toEqual([name, value]);
    expect([name, host.style.getPropertyPriority(name)]).toEqual([name, 'important']);
  }
});

test('page CSS cannot reach the overlay', () => {
  const style = document.createElement('style');
  style.textContent = '* { display: none !important } pinwall-overlay { position: static }';
  document.head.append(style);
  start();
  showAnchors([{ id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') }]);
  const host = overlayHost();
  expect(host.shadowRoot?.querySelectorAll('[data-pin-id]')).toHaveLength(1);
  expect(host.style.getPropertyValue('display')).toBe('block');
  expect(host.style.getPropertyPriority('display')).toBe('important');
  expect(getComputedStyle(host).display).toBe('block');
  expect(getComputedStyle(host).position).toBe('absolute');
});

test('pins come back after the page rewrites its DOM', async () => {
  start();
  showAnchors([{ id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') }]);
  const host = overlayHost();
  document.documentElement.innerHTML = '<body><p>Alpha beta gamma</p></body>';
  expect(host.isConnected).toBe(false);
  window.dispatchEvent(new Event('resize'));
  await nextFrame();
  expect(host.isConnected).toBe(true);
  expect(host.parentNode).toBe(document.documentElement);
  expect(pinButtons().map((pin) => pin.getAttribute('data-pin-id'))).toEqual(['c1']);
});

test('clicking a pin posts pin-clicked', () => {
  start();
  showAnchors([{ id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') }]);
  const pageClick = vi.fn();
  document.addEventListener('click', pageClick);
  onTestFinished(() => document.removeEventListener('click', pageClick));
  pinOf('c1').click();
  setMode('comment');
  pinOf('c1').click();
  expect(sent('pin-clicked')).toEqual([
    { pinwall: 1, type: 'pin-clicked', id: 'c1' },
    { pinwall: 1, type: 'pin-clicked', id: 'c1' },
  ]);
  expect(sent('anchor-picked')).toEqual([]);
  expect(pageClick).not.toHaveBeenCalled();
});

test('focus-anchor scrolls to the anchor', () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const scrollIntoView = vi.fn();
  define(Element.prototype, 'scrollIntoView', scrollIntoView);
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  stubLayout({ scrollWidth: 1000, scrollHeight: 4000, clientWidth: 800 });
  start();
  showAnchors([
    { id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') },
    { id: 'c2', number: 2, anchor: pointAt(0.5, 0.5) },
  ]);

  send({ pinwall: 1, type: 'focus-anchor', id: 'c1' });
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollIntoView.mock.contexts[0]).toBe(el('#p1'));
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  expect(pinOf('c1').hasAttribute('data-focus')).toBe(true);

  send({ pinwall: 1, type: 'focus-anchor', id: 'nope' });
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(scrollTo).not.toHaveBeenCalled();
  expect(pinOf('c1').hasAttribute('data-focus')).toBe(true);
  vi.advanceTimersByTime(1500);
  expect(pinOf('c1').hasAttribute('data-focus')).toBe(false);

  // A point is scrolled to the middle of the viewport, without motion when the reader asks so.
  define(window, 'matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
  send({ pinwall: 1, type: 'focus-anchor', id: 'c2' });
  expect(scrollTo).toHaveBeenCalledWith({
    left: 100,
    top: 2000 - innerHeight / 2,
    behavior: 'auto',
  });
  expect(pinOf('c2').hasAttribute('data-focus')).toBe(true);
});

test('unfound anchors are retried after load', () => {
  const { frameId } = start();
  showAnchors([
    { id: 'c1', number: 1, anchor: quoteAnchor('beta gamma') },
    { id: 'c2', number: 2, anchor: quoteAnchor('epsilon zeta') },
  ]);
  expect(sent('anchors-placed')).toHaveLength(1);
  const late = document.createElement('p');
  late.textContent = 'Epsilon? epsilon zeta, late';
  document.body.append(late);
  window.dispatchEvent(new Event('load'));
  expect(sent('anchors-placed')).toEqual([
    expect.anything(),
    {
      pinwall: 1,
      type: 'anchors-placed',
      results: [
        { id: 'c1', found: true },
        { id: 'c2', found: true },
      ],
      frameId,
    },
  ]);
  window.dispatchEvent(new Event('load'));
  expect(sent('anchors-placed')).toHaveLength(2);
  expect(pinButtons()).toHaveLength(2);
});

test('unfound anchors are retried once, 2 s after show-anchors, posting only changes', () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  start();
  showAnchors([{ id: 'c2', number: 2, anchor: quoteAnchor('epsilon zeta') }]);
  vi.advanceTimersByTime(2000);
  expect(sent('anchors-placed')).toHaveLength(1);

  showAnchors([{ id: 'c2', number: 2, anchor: quoteAnchor('epsilon zeta') }]);
  expect(sent('anchors-placed')).toHaveLength(2);
  vi.advanceTimersByTime(1999);
  const late = document.createElement('p');
  late.textContent = 'epsilon zeta';
  document.body.append(late);
  vi.advanceTimersByTime(1);
  expect(sent('anchors-placed').at(-1)).toMatchObject({ results: [{ id: 'c2', found: true }] });
  expect(sent('anchors-placed')).toHaveLength(3);
});

test('pins sit 12 px above-left of their anchors, in the overlay host coordinates', () => {
  start();
  const host = overlayHost();
  stubLayout({
    scrollWidth: 1000,
    scrollHeight: 3000,
    scrollY: 300,
    rects: [
      // The page offsets <html>: the host's own origin is at document (8, 16).
      [host, { left: 8, top: -284 }],
      [el('#l'), { left: 100, top: 200, width: 50, height: 20 }],
    ],
    rangeRects: (range) =>
      range.toString() === 'beta gamma'
        ? [
            { left: 40, top: 100, width: 30, height: 16 },
            { left: 0, top: 116, width: 45, height: 16 },
          ]
        : [],
  });
  showAnchors([
    { id: 'text', number: 1, anchor: quoteAnchor('beta gamma') },
    { id: 'element', number: 2, anchor: elementAt('#l') },
    { id: 'point', number: 3, anchor: pointAt(0.5, 0.1) },
    { id: 'corner', number: 4, anchor: pointAt(0, 0) },
  ]);
  // Pin box = anchor - 12 - 11 (half the 22 px pin) - host origin, kept inside the document.
  expect(['text', 'element', 'point', 'corner'].map((id) => boxOf(pinOf(id)))).toEqual([
    { left: '9px', top: '361px', width: '', height: '' },
    { left: '69px', top: '461px', width: '', height: '' },
    { left: '469px', top: '261px', width: '', height: '' },
    { left: '-8px', top: '-16px', width: '', height: '' },
  ]);
  const shadow = shadowOf(host);
  expect(Array.from(shadow.querySelectorAll('.mark'), boxOf)).toEqual([
    { left: '32px', top: '384px', width: '30px', height: '16px' },
    { left: '-8px', top: '400px', width: '45px', height: '16px' },
  ]);
  expect(Array.from(shadow.querySelectorAll('.outline'), boxOf)).toEqual([
    { left: '92px', top: '484px', width: '50px', height: '20px' },
  ]);
});

test('comment mode outlines what a click would pick', () => {
  start();
  stubLayout({ rects: [[el('#l'), { left: 100, top: 200, width: 50, height: 20 }]] });
  const hover = shadowOf(overlayHost()).querySelector('.hover');
  const move = (target: EventTarget) =>
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));

  move(el('#l'));
  expect(hover?.hasAttribute('data-on')).toBe(false);
  setMode('comment');
  move(el('#l'));
  expect(hover?.hasAttribute('data-on')).toBe(true);
  expect(boxOf(hover ?? undefined)).toEqual({
    left: '100px',
    top: '200px',
    width: '50px',
    height: '20px',
  });
  move(document.body);
  expect(hover?.hasAttribute('data-on')).toBe(false);
  move(el('#l'));
  setMode('browse');
  expect(hover?.hasAttribute('data-on')).toBe(false);
});
