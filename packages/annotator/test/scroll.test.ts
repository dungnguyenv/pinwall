import { expect, test, vi } from 'vitest';
import { scrollFraction, scrollToFraction } from '../src/scroll.ts';
import { el, rangeOf } from './helpers/dom.ts';
import { stubLayout } from './helpers/layout.ts';
import {
  bootOptions,
  click,
  nextFrame,
  send,
  sent,
  setMode,
  start,
  useRuntime,
} from './helpers/runtime.ts';

useRuntime();

/** `window.scrollTo`, recorded (jsdom has no scrolling of its own). */
function spyScrollTo() {
  return vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
}

/** A scroll of the viewport, as browsers fire it at the document. */
function scroll(): void {
  document.dispatchEvent(new Event('scroll', { bubbles: true }));
}

/** A frame inside the page: booted with it as parent, this window is no longer the top frame. */
function nestedParent(): Window {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  if (!frame.contentWindow) throw new Error('no frame window');
  return frame.contentWindow;
}

test('picks carry the pick point', async () => {
  const { frameId } = start();
  setMode('comment');
  click(el('#l'), { clientX: 40, clientY: 60 });
  expect(sent('anchor-picked')).toEqual([
    {
      pinwall: 1,
      type: 'anchor-picked',
      anchor: expect.objectContaining({ kind: 'element', dom: { path: '#l' } }),
      frameId,
      client: { x: 40, y: 60 },
    },
  ]);

  await new Promise((resolve) => setTimeout(resolve, 0));
  document.getSelection()?.addRange(rangeOf('beta gamma'));
  el('#p1').dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 200, clientY: 90 }),
  );
  expect(sent('anchor-picked')[1]).toMatchObject({
    anchor: { kind: 'text', quote: { exact: 'beta gamma' } },
    client: { x: 200, y: 90 },
  });
});

test('a pick point the protocol cannot carry is left out, not the pick', () => {
  start();
  setMode('comment');
  click(document.body, { clientX: 250_000, clientY: 10 });
  expect(sent('anchor-picked')).toHaveLength(1);
  expect(sent('anchor-picked')[0]).toMatchObject({ anchor: { kind: 'point' } });
  expect(sent('anchor-picked')[0]).not.toHaveProperty('client');
});

test('the top content frame reports scrolling once per animation frame', async () => {
  stubLayout({ scrollHeight: 4000, clientHeight: 1000, scrollY: 1500 });
  const { frameId } = start();
  scroll();
  scroll();
  scroll();
  expect(sent('scrolled')).toEqual([]);
  await nextFrame();
  expect(sent('scrolled')).toEqual([{ pinwall: 1, type: 'scrolled', frameId, x: 0, y: 0.5 }]);

  // Scrolling inside an element of the page is not the frame scrolling.
  el('#main').dispatchEvent(new Event('scroll'));
  await nextFrame();
  expect(sent('scrolled')).toHaveLength(1);

  window.scrollY = 3000;
  scroll();
  await nextFrame();
  expect(sent('scrolled').at(-1)).toMatchObject({ x: 0, y: 1 });
});

test('scroll-to scrolls the top content frame', () => {
  const scrollTo = spyScrollTo();
  stubLayout({ scrollHeight: 4000, clientHeight: 1000 });
  start();
  send({ pinwall: 1, type: 'scroll-to', x: 0, y: 0.25 });
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 750, behavior: 'instant' });
  // From anyone but the viewer, or malformed: ignored.
  send({ pinwall: 1, type: 'scroll-to', x: 0, y: 0.5 }, nestedParent());
  send({ pinwall: 1, type: 'scroll-to', x: 0, y: 2 });
  expect(scrollTo).toHaveBeenCalledTimes(1);
});

test('nested frames neither report scrolling nor obey scroll-to', async () => {
  const scrollTo = spyScrollTo();
  stubLayout({ scrollHeight: 4000, clientHeight: 1000, scrollY: 1500 });
  start({ ...bootOptions, parent: nestedParent() });
  scroll();
  await nextFrame();
  send({ pinwall: 1, type: 'scroll-to', x: 0, y: 0.25 });
  expect(sent('ready')).toHaveLength(1);
  expect(sent('scrolled')).toEqual([]);
  expect(scrollTo).not.toHaveBeenCalled();
});

test('no scroll is reported after destroy', async () => {
  const annotator = start();
  scroll();
  annotator.destroy();
  await nextFrame();
  scroll();
  await nextFrame();
  expect(sent('scrolled')).toEqual([]);
});

test('scroll fractions are clamped, rounded and safe on pages that cannot scroll', () => {
  stubLayout({
    scrollWidth: 1300,
    clientWidth: 1000,
    scrollHeight: 3000,
    clientHeight: 1000,
    scrollX: 100,
    scrollY: 2500,
  });
  expect(scrollFraction(window)).toEqual({ x: 0.3333, y: 1 });

  const scrollTo = spyScrollTo();
  scrollToFraction(window, { x: 1, y: 0.5 });
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 300, top: 1000, behavior: 'instant' });
});

test('a page shorter than its viewport is at 0 and scrolls nowhere', () => {
  stubLayout({ scrollWidth: 800, clientWidth: 1000, scrollHeight: 0, clientHeight: 0 });
  expect(scrollFraction(window)).toEqual({ x: 0, y: 0 });
  const scrollTo = spyScrollTo();
  scrollToFraction(window, { x: 1, y: 1 });
  expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 0, behavior: 'instant' });
});
