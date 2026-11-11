import type { Anchor } from '@pinwall/shared/protocol';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { nestedWindow, simFrame } from '../../test/annotator-sim.ts';
import { ContentFrame } from './content-frame.tsx';
import type { FrameBox } from './device.ts';
import { CONTENT_ALLOW, CONTENT_SANDBOX, READY_TIMEOUT_MS } from './sandbox.ts';
import {
  type FrameBridge,
  type FrameBridgeOptions,
  RELOAD_BEFORE_EXPIRY_MS,
  useFrameBridge,
  type ViewerPin,
} from './use-frame-bridge.ts';

const BASE = 'http://localhost:8080/c/tok/';
const BOX: FrameBox = { width: 800, height: 600, scale: 1, framed: true };
const NO_ANNOTATOR =
  "This page blocks Pinwall's comment helper, so comments can only be pinned to a spot on the screen, and they don't move when the page scrolls.";

function textAnchor(page: string): Anchor {
  return {
    page,
    kind: 'text',
    quote: { exact: 'Pricing', prefix: 'Our ', suffix: ' plans' },
    position: { x: 0.1, y: 0.2 },
    viewport: { width: 1280 },
  };
}

function pointAnchor(page: string, x: number, y: number): Anchor {
  return { page, kind: 'point', position: { x, y }, viewport: { width: 800 } };
}

const P1: ViewerPin = { id: 'p1', number: 1, resolved: false, anchor: textAnchor('docs/') };
const P2: ViewerPin = { id: 'p2', number: 2, resolved: true, anchor: textAnchor('a.html') };
const PINS = [P1, P2];

interface HarnessProps extends Partial<FrameBridgeOptions> {
  base?: string;
  box?: FrameBox;
}

/** The bridge the harness rendered last. */
let current: FrameBridge;

function Harness({ base = BASE, box = BOX, pins = PINS, mode = 'browse', ...o }: HarnessProps) {
  const bridge = useFrameBridge(base, { pins, mode, ...o });
  current = bridge;
  return (
    <ContentFrame
      bridge={bridge}
      title="Pricing, v3"
      box={box}
      pins={pins}
      mode={mode}
      onPicked={(p) => o.onPicked?.(p)}
      onPinClicked={(id) => o.onPinClicked?.(id)}
    />
  );
}

function setup(props: HarnessProps = {}) {
  const handlers = { onPicked: vi.fn(), onPinClicked: vi.fn(), onScrolled: vi.fn() };
  const first = { ...handlers, ...props };
  const view = render(<Harness {...first} />);
  const frame = () => screen.getByTitle('Pricing, v3') as HTMLIFrameElement;
  return {
    ...handlers,
    frame,
    /** The annotator of the document the content frame shows now. */
    top: (o?: { page?: string; frameId?: string }) => simFrame(frame().contentWindow as Window, o),
    /** The annotator of a new frame inside the content frame's document. */
    nested: (o?: { page?: string; frameId?: string }) => simFrame(nestedWindow(frame()), o),
    annotator: () => frame().closest('[data-annotator]')?.getAttribute('data-annotator'),
    overlay: () => document.querySelector('[data-point-overlay]'),
    rerender: (next: HarnessProps) => view.rerender(<Harness {...first} {...next} />),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test('the frame is sandboxed exactly and points at the grant', () => {
  setup();
  const f = screen.getByTitle('Pricing, v3') as HTMLIFrameElement;
  expect(f.getAttribute('sandbox')).toBe(CONTENT_SANDBOX);
  expect(f.getAttribute('allow')).toBe(CONTENT_ALLOW);
  expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(f.getAttribute('src')).toBe('http://localhost:8080/c/tok/');
  expect(f.hasAttribute('srcdoc')).toBe(false);
  expect(f.closest('[data-annotator]')).toHaveAttribute('data-annotator', 'waiting');

  expect(screen.getByRole('progressbar', { name: 'Loading the page' })).toBeInTheDocument();
  fireEvent.load(f);
  expect(screen.queryByRole('progressbar')).toBeNull();
});

test('ready gets the mode and anchors in every frame', () => {
  const careless = {
    id: 'p3',
    number: 3,
    resolved: false,
    anchor: pointAnchor('', 0.5, 0.5),
    body: 'Make the button blue',
    author: { name: 'Ada Lovelace' },
  } as ViewerPin;
  const s = setup({ pins: [...PINS, careless] });
  const top = s.top({ page: '' });
  const nested = s.nested({ page: 'docs/' });
  // A third-party embed: it never posts ready, so it never hears from the viewer.
  const embed = s.nested({ page: 'docs/' });

  top.ready();
  nested.ready();

  expect(top.received()).toEqual([
    { pinwall: 1, type: 'set-mode', mode: 'browse' },
    {
      pinwall: 1,
      type: 'show-anchors',
      anchors: [{ id: 'p3', number: 3, resolved: false, anchor: pointAnchor('', 0.5, 0.5) }],
    },
  ]);
  expect(nested.received()).toEqual([
    { pinwall: 1, type: 'set-mode', mode: 'browse' },
    {
      pinwall: 1,
      type: 'show-anchors',
      anchors: [{ id: 'p1', number: 1, resolved: false, anchor: textAnchor('docs/') }],
    },
  ]);
  for (const msg of [...top.received(), ...nested.received()]) {
    const json = JSON.stringify(msg);
    expect(json).not.toContain('body');
    expect(json).not.toContain('Make the button blue');
    expect(json).not.toContain('Ada Lovelace');
  }

  // Mode and pin changes reach the frames that posted ready, each with its own page's anchors.
  s.rerender({ mode: 'comment' });
  expect(top.received().at(-1)).toEqual({ pinwall: 1, type: 'set-mode', mode: 'comment' });
  expect(nested.received().at(-1)).toEqual({ pinwall: 1, type: 'set-mode', mode: 'comment' });
  s.rerender({ mode: 'comment', pins: [{ ...P1, resolved: true }] });
  expect(nested.received().at(-1)).toEqual({
    pinwall: 1,
    type: 'show-anchors',
    anchors: [{ id: 'p1', number: 1, resolved: true, anchor: textAnchor('docs/') }],
  });
  expect(top.received().at(-1)).toEqual({ pinwall: 1, type: 'show-anchors', anchors: [] });

  // The same pins in a new array are not sent again.
  const sent = nested.received().length;
  s.rerender({ mode: 'comment', pins: [{ ...P1, resolved: true }] });
  expect(nested.received()).toHaveLength(sent);

  // Focus goes only to the frame that showed the pin's page and said ready.
  act(() => current.focus('p1'));
  expect(nested.received().at(-1)).toEqual({ pinwall: 1, type: 'focus-anchor', id: 'p1' });
  expect(top.received().some((m) => m.type === 'focus-anchor')).toBe(false);
  expect(embed.received()).toEqual([]);
});

test('messages from outside the content frame are ignored', () => {
  const s = setup();
  const sibling = document.createElement('iframe');
  document.body.append(sibling);
  const ready = { pinwall: 1, type: 'ready', page: '', frameId: 'f1' };

  for (const source of [window, sibling.contentWindow, null]) {
    fireEvent(window, new MessageEvent('message', { data: ready, source }));
  }
  const outsider = simFrame(sibling.contentWindow as Window);
  outsider.ready();
  expect(s.annotator()).toBe('waiting');
  expect(outsider.received()).toEqual([]);

  const top = s.top();
  fireEvent(
    window,
    new MessageEvent('message', { data: { type: 'ready' }, source: s.frame().contentWindow }),
  );
  expect(s.annotator()).toBe('waiting');
  expect(top.received()).toEqual([]);
  sibling.remove();
});

test('placement tracks every frame', () => {
  const s = setup();
  const top = s.top({ page: '' });
  const nested = s.nested({ page: 'docs/' });
  top.ready();
  nested.ready();
  expect(current.placement(P1)).toBe('pending');
  expect(current.placement(P2)).toBe('elsewhere');

  nested.placed([{ id: 'p1', found: true, via: 'quote' }]);
  expect(current.placement(P1)).toBe('placed');
  expect(current.placement(P2)).toBe('elsewhere');

  // The quote was edited away: the annotator still pins it by its DOM path, but not found.
  nested.navigated('docs/');
  expect(current.placement(P1)).toBe('pending');
  nested.placed([{ id: 'p1', found: false, via: 'dom' }]);
  expect(current.placement(P1)).toBe('detached');

  nested.ready();
  expect(current.placement(P1)).toBe('pending');

  // A frame that moves on gets the anchors of its new page.
  nested.navigated('a.html');
  expect(nested.received().at(-1)).toEqual({
    pinwall: 1,
    type: 'show-anchors',
    anchors: [{ id: 'p2', number: 2, resolved: true, anchor: textAnchor('a.html') }],
  });
  expect(current.placement(P1)).toBe('elsewhere');
  expect(current.placement(P2)).toBe('pending');
});

test('picks are accepted only in comment mode and carry the top-frame point', () => {
  const s = setup();
  const top = s.top({ page: '', frameId: 'top' });
  const nested = s.nested({ page: 'docs/', frameId: 'inner' });
  top.ready();
  nested.ready();

  top.picked(textAnchor(''), { x: 40, y: 60 });
  expect(s.onPicked).not.toHaveBeenCalled();

  s.rerender({ mode: 'comment' });
  top.picked(textAnchor(''), { x: 40, y: 60 });
  expect(s.onPicked).toHaveBeenLastCalledWith({
    anchor: textAnchor(''),
    frameId: 'top',
    topFrame: true,
    client: { x: 40, y: 60 },
  });
  nested.picked(textAnchor('docs/'), { x: 5, y: 6 });
  expect(s.onPicked).toHaveBeenLastCalledWith({
    anchor: textAnchor('docs/'),
    frameId: 'inner',
    topFrame: false,
    client: null,
  });

  // A frame that never announced itself cannot pick.
  s.nested({ page: 'docs/' }).picked(textAnchor('docs/'));
  expect(s.onPicked).toHaveBeenCalledTimes(2);
});

test('pin clicks name known pins only', () => {
  const s = setup();
  const top = s.top({ page: '' });
  top.ready();
  top.pinClicked('p1');
  top.pinClicked('nope');
  expect(s.onPinClicked).toHaveBeenCalledTimes(1);
  expect(s.onPinClicked).toHaveBeenCalledWith('p1');
});

test('no ready within 3 s of load means no annotator; a late ready wins', () => {
  vi.useFakeTimers();
  const s = setup();
  fireEvent.load(s.frame());
  act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS - 1));
  expect(s.annotator()).toBe('waiting');
  expect(s.overlay()).toBeNull();

  act(() => vi.advanceTimersByTime(1));
  expect(s.annotator()).toBe('missing');
  expect(s.overlay()).not.toBeNull();

  s.top({ page: '' }).ready();
  expect(s.annotator()).toBe('ready');
  expect(s.overlay()).toBeNull();
});

test('a ready before the load event keeps the annotator', () => {
  vi.useFakeTimers();
  const s = setup();
  s.top({ page: '' }).ready();
  fireEvent.load(s.frame());
  act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS * 2));
  expect(s.annotator()).toBe('ready');
});

test('a late ready answers its own load, not the next page', () => {
  vi.useFakeTimers();
  const s = setup();
  fireEvent.load(s.frame());
  act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS));
  s.top({ page: '' }).ready();
  expect(s.annotator()).toBe('ready');

  // The reviewer follows a link to a page whose own policy blocks the annotator.
  fireEvent.load(s.frame());
  expect(s.annotator()).toBe('waiting');
  act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS));
  expect(s.annotator()).toBe('missing');

  // Again, with the ready arriving after the load but inside the 3 s.
  fireEvent.load(s.frame());
  act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS - 1));
  s.top({ page: '' }).ready();
  expect(s.annotator()).toBe('ready');
  fireEvent.load(s.frame());
  act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS));
  expect(s.annotator()).toBe('missing');
});

test('frames of a page the content frame left no longer count', () => {
  const s = setup();
  const top = s.top({ page: '' });
  const nested = s.nested({ page: 'docs/' });
  top.ready();
  nested.ready();
  nested.placed([{ id: 'p1', found: true }]);
  expect(current.placement(P1)).toBe('placed');

  // The content frame moves to another document: the frames of the old one are gone. A browser
  // answers null for a discarded frame's parent; jsdom keeps the old one, so the test says it.
  const inner = s.frame().contentDocument?.querySelector('iframe') as HTMLIFrameElement;
  const innerWindow = inner.contentWindow as Window;
  inner.remove();
  Object.defineProperty(innerWindow, 'parent', { configurable: true, get: () => null });
  fireEvent.load(s.frame());
  expect(current.placement(P1)).toBe('elsewhere');
  nested.placed([{ id: 'p1', found: true }]);
  expect(current.placement(P1)).toBe('elsewhere');
});

test('focusing a pin on another page loads that page first', () => {
  const s = setup();
  const top = s.top({ page: '' });
  top.ready();

  act(() => current.focus('p1'));
  expect(s.frame()).toHaveAttribute('src', 'http://localhost:8080/c/tok/docs/');
  expect(top.received().some((m) => m.type === 'focus-anchor')).toBe(false);

  const docs = s.top({ page: 'docs/' });
  docs.ready();
  expect(docs.received()).toEqual([
    { pinwall: 1, type: 'set-mode', mode: 'browse' },
    {
      pinwall: 1,
      type: 'show-anchors',
      anchors: [{ id: 'p1', number: 1, resolved: false, anchor: textAnchor('docs/') }],
    },
    { pinwall: 1, type: 'focus-anchor', id: 'p1' },
  ]);

  // A pin on the page a frame shows is focused there at once.
  act(() => current.focus('p1'));
  expect(docs.received().at(-1)).toEqual({ pinwall: 1, type: 'focus-anchor', id: 'p1' });
  expect(s.frame()).toHaveAttribute('src', 'http://localhost:8080/c/tok/docs/');
});

test('navigating encodes each path segment', () => {
  const s = setup();
  act(() => current.navigate('docs/über uns.html'));
  expect(s.frame()).toHaveAttribute('src', 'http://localhost:8080/c/tok/docs/%C3%BCber%20uns.html');
  expect(current.topPage).toBe('docs/über uns.html');
});

test('a new grant resets the bridge', () => {
  const s = setup();
  const top = s.top({ page: '' });
  const nested = s.nested({ page: 'docs/' });
  top.ready();
  nested.ready();
  nested.placed([{ id: 'p1', found: true }]);
  fireEvent.load(s.frame());
  expect(s.annotator()).toBe('ready');
  expect(current.placement(P1)).toBe('placed');

  s.rerender({ base: 'http://localhost:8080/c/tok2/' });
  expect(s.frame()).toHaveAttribute('src', 'http://localhost:8080/c/tok2/');
  expect(s.annotator()).toBe('waiting');
  expect(current.placement(P1)).toBe('elsewhere');
  expect(screen.getByRole('progressbar', { name: 'Loading the page' })).toBeInTheDocument();

  // The old document's messages no longer count.
  nested.placed([{ id: 'p1', found: true }]);
  expect(current.placement(P1)).toBe('elsewhere');
});

test('a renewed grant keeps the frame until the one it loaded nears expiry', () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 12, 9) });
  const now = Date.now();
  const s = setup({ version: 3, expiresAt: now + 600_000 });
  const top = s.top({ page: '' });
  top.ready();
  fireEvent.load(s.frame());
  top.navigated('docs/');

  s.rerender({ base: 'http://localhost:8080/c/tok2/', version: 3, expiresAt: now + 43_200_000 });
  expect(s.frame()).toHaveAttribute('src', BASE);
  expect(s.annotator()).toBe('ready');

  act(() => vi.advanceTimersByTime(600_000 - RELOAD_BEFORE_EXPIRY_MS - 1));
  expect(s.frame()).toHaveAttribute('src', BASE);
  act(() => vi.advanceTimersByTime(1));
  // Reloaded from the new grant, on the page the reviewer was on.
  expect(s.frame()).toHaveAttribute('src', 'http://localhost:8080/c/tok2/docs/');

  // Another version loads at once, from its entry page.
  s.rerender({ base: 'http://localhost:8080/c/tok3/', version: 2, expiresAt: now + 43_200_000 });
  expect(s.frame()).toHaveAttribute('src', 'http://localhost:8080/c/tok3/');
});

test('the point overlay pins comments by position', () => {
  vi.useFakeTimers();
  const point: ViewerPin = {
    id: 'p3',
    number: 3,
    resolved: false,
    anchor: pointAnchor('', 0.5, 0.5),
  };
  const text: ViewerPin = { id: 'p4', number: 4, resolved: false, anchor: textAnchor('') };
  const s = setup({ pins: [point, text, ...PINS], mode: 'comment' });
  fireEvent.load(s.frame());
  act(() => vi.advanceTimersByTime(READY_TIMEOUT_MS));
  expect(s.annotator()).toBe('missing');

  const area = screen.getByRole('button', { name: 'Pin a comment to a spot on the page' });
  expect(area).toHaveAccessibleDescription(NO_ANNOTATOR);
  fireEvent.click(area, { clientX: 200, clientY: 150, detail: 1 });
  expect(s.onPicked).toHaveBeenLastCalledWith({
    anchor: { kind: 'point', page: '', position: { x: 0.25, y: 0.25 }, viewport: { width: 800 } },
    frameId: expect.any(String),
    topFrame: true,
    client: { x: 200, y: 150 },
  });
  // From the keyboard, the comment goes to the middle of what is on screen.
  fireEvent.click(area, { detail: 0 });
  expect(s.onPicked).toHaveBeenLastCalledWith(
    expect.objectContaining({
      anchor: { kind: 'point', page: '', position: { x: 0.5, y: 0.5 }, viewport: { width: 800 } },
      client: { x: 400, y: 300 },
    }),
  );

  const pin = screen.getByRole('button', { name: 'Comment 3' });
  expect(pin.style.left).toBe('400px');
  expect(pin.style.top).toBe('300px');
  fireEvent.click(pin);
  expect(s.onPinClicked).toHaveBeenCalledWith('p3');
  // Text pins cannot be found without the annotator; pins of other pages are elsewhere.
  expect(screen.queryByRole('button', { name: 'Comment 4' })).toBeNull();
  expect(current.placement(point)).toBe('placed');
  expect(current.placement(text)).toBe('detached');
  expect(current.placement(P1)).toBe('elsewhere');

  // A scaled-down frame: positions are measured in the page's own pixels.
  s.rerender({ box: { width: 1904, height: 1504, scale: 0.5, framed: true } });
  fireEvent.click(area, { clientX: 476, clientY: 376, detail: 1 });
  expect(s.onPicked).toHaveBeenLastCalledWith(
    expect.objectContaining({
      anchor: { kind: 'point', page: '', position: { x: 0.5, y: 0.5 }, viewport: { width: 1904 } },
      client: { x: 952, y: 752 },
    }),
  );
  expect(screen.getByRole('button', { name: 'Comment 3' }).style.left).toBe('476px');

  // Browsing: the page takes the clicks, the pins stay.
  s.rerender({ mode: 'browse' });
  expect(screen.queryByRole('button', { name: 'Pin a comment to a spot on the page' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Comment 3' })).toBeInTheDocument();
});

test('scroll messages come only from the top content window', () => {
  const s = setup();
  const top = s.top({ page: '', frameId: 'top' });
  const nested = s.nested({ page: 'docs/' });
  top.ready();
  nested.ready();

  nested.scrolled(0.1, 0.1);
  fireEvent(
    window,
    new MessageEvent('message', {
      data: { pinwall: 1, type: 'scrolled', frameId: 'not-top', x: 0.9, y: 0.9 },
      source: s.frame().contentWindow,
    }),
  );
  expect(s.onScrolled).not.toHaveBeenCalled();
  top.scrolled(0.2, 0.4);
  expect(s.onScrolled).toHaveBeenCalledWith({ x: 0.2, y: 0.4 });

  act(() => current.scrollTo({ x: 0.3, y: 0.6 }));
  expect(top.received().at(-1)).toEqual({ pinwall: 1, type: 'scroll-to', x: 0.3, y: 0.6 });
  expect(nested.received().some((m) => m.type === 'scroll-to')).toBe(false);
});
