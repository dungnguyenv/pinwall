import type { ViewerToPageMessage } from '@pinwall/shared/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { nestedWindow } from '../../test/annotator-sim.ts';
import { isWithinFrame, MAX_FRAME_DEPTH, postTo } from './windows.ts';

function frame(): HTMLIFrameElement {
  const el = document.createElement('iframe');
  el.setAttribute('src', 'http://localhost:8080/c/tok/');
  document.body.append(el);
  return el;
}

/** A stand-in window `hops` frames below `root`. */
function below(root: Window, hops: number): Window {
  let win: unknown = root;
  for (let i = 0; i < hops; i++) win = { parent: win };
  return win as Window;
}

afterEach(() => {
  document.body.replaceChildren();
});

test('isWithinFrame accepts the frame and its descendants only', () => {
  const outer = frame();
  const sibling = frame();
  const root = outer.contentWindow;
  const nested = nestedWindow(outer);

  expect(isWithinFrame(root, root)).toBe(true);
  expect(isWithinFrame(nested, root)).toBe(true);
  expect(isWithinFrame(window, root)).toBe(false);
  expect(isWithinFrame(sibling.contentWindow, root)).toBe(false);
  expect(isWithinFrame(nestedWindow(sibling), root)).toBe(false);
  expect(isWithinFrame(null, root)).toBe(false);
  expect(isWithinFrame(nested, null)).toBe(false);

  const selfParent: { parent?: unknown } = {};
  selfParent.parent = selfParent;
  expect(isWithinFrame(selfParent as Window, root)).toBe(false);
});

test('isWithinFrame stops after MAX_FRAME_DEPTH hops', () => {
  const root = frame().contentWindow as Window;
  expect(isWithinFrame(below(root, MAX_FRAME_DEPTH), root)).toBe(true);
  expect(isWithinFrame(below(root, MAX_FRAME_DEPTH + 1), root)).toBe(false);
});

test('isWithinFrame treats an unreadable parent and a port as outside', () => {
  const root = frame().contentWindow as Window;
  const locked = Object.defineProperty({}, 'parent', {
    get() {
      throw new DOMException('Blocked a frame', 'SecurityError');
    },
  });
  expect(isWithinFrame(locked as Window, root)).toBe(false);
  expect(isWithinFrame(new MessageChannel().port1, root)).toBe(false);
});

test('postTo sends only what the protocol allows, to any origin', () => {
  const win = frame().contentWindow as Window;
  const post = vi.spyOn(win, 'postMessage').mockImplementation(() => {});
  const anchor = {
    page: '',
    kind: 'point' as const,
    position: { x: 0.5, y: 0.5 },
    viewport: { width: 800 },
  };
  const careless = {
    pinwall: 1,
    type: 'show-anchors',
    anchors: [{ id: 'p1', number: 1, resolved: false, anchor, body: 'Secret', author: 'Ada' }],
  } as unknown as ViewerToPageMessage;

  postTo(win, careless);
  postTo(win, { pinwall: 1, type: 'set-mode', mode: 'loud' } as unknown as ViewerToPageMessage);
  postTo(null, { pinwall: 1, type: 'set-mode', mode: 'comment' });

  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(
    {
      pinwall: 1,
      type: 'show-anchors',
      anchors: [{ id: 'p1', number: 1, resolved: false, anchor }],
    },
    '*',
  );
});

test('postTo survives a window that refuses the message', () => {
  const win = frame().contentWindow as Window;
  vi.spyOn(win, 'postMessage').mockImplementation(() => {
    throw new DOMException('Gone', 'InvalidStateError');
  });
  expect(() => postTo(win, { pinwall: 1, type: 'set-mode', mode: 'comment' })).not.toThrow();
});
