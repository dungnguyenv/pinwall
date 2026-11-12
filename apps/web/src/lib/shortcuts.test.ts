import { renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { isTypingTarget, matchesKeys, type Shortcut, useShortcuts } from './shortcuts.ts';

const press = (key: string, o: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o });

function onPlatform(platform: string): void {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test('a letter matches alone, and shift+ asks for Shift', () => {
  expect(matchesKeys(press('c'), ['c'])).toBe(true);
  expect(matchesKeys(press('C', { shiftKey: true }), ['c'])).toBe(false);
  expect(matchesKeys(press('C', { shiftKey: true }), ['shift', 'c'])).toBe(true);
  expect(matchesKeys(press('c'), ['shift', 'c'])).toBe(false);
  // Caps Lock gives a capital without Shift.
  expect(matchesKeys(press('C'), ['c'])).toBe(true);
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
    expect(matchesKeys(press('c', { [modifier]: true }), ['c'])).toBe(false);
  }
});

test('a character is matched as typed, whatever the layout needs to type it', () => {
  // Shift+/ on US layouts.
  expect(matchesKeys(press('?', { shiftKey: true }), ['?'])).toBe(true);
  expect(matchesKeys(press('/', { shiftKey: true }), ['?'])).toBe(false);
  expect(matchesKeys(press('?', { shiftKey: true, ctrlKey: true }), ['?'])).toBe(false);
  expect(matchesKeys(press('[', {}), ['['])).toBe(true);
  expect(matchesKeys(press(']', {}), [']'])).toBe(true);
  expect(matchesKeys(press(']', {}), ['['])).toBe(false);
  expect(matchesKeys(press('1'), ['1'])).toBe(true);
  expect(matchesKeys(press('!', { shiftKey: true }), ['1'])).toBe(false);
});

test('named keys match their key values', () => {
  expect(matchesKeys(press('Escape'), ['escape'])).toBe(true);
  expect(matchesKeys(press('Escape', { shiftKey: true }), ['escape'])).toBe(false);
  expect(matchesKeys(press('Enter'), ['escape'])).toBe(false);
  for (const key of ['f', 'j', 'k']) expect(matchesKeys(press(key), [key])).toBe(true);
});

test('mod is Meta on Apple platforms and Ctrl elsewhere', () => {
  onPlatform('MacIntel');
  expect(matchesKeys(press('Enter', { metaKey: true }), ['mod', 'enter'])).toBe(true);
  expect(matchesKeys(press('Enter', { ctrlKey: true }), ['mod', 'enter'])).toBe(false);
  expect(matchesKeys(press('Enter'), ['mod', 'enter'])).toBe(false);

  onPlatform('Win32');
  expect(matchesKeys(press('Enter', { ctrlKey: true }), ['mod', 'enter'])).toBe(true);
  expect(matchesKeys(press('Enter', { metaKey: true }), ['mod', 'enter'])).toBe(false);
});

test('typing targets are text fields, selects and editable content', () => {
  const el = (html: string) => {
    document.body.innerHTML = html;
    return document.body.firstElementChild;
  };
  expect(isTypingTarget(el('<input type="text">'))).toBe(true);
  expect(isTypingTarget(el('<input>'))).toBe(true);
  expect(isTypingTarget(el('<input type="number">'))).toBe(true);
  expect(isTypingTarget(el('<input type="search">'))).toBe(true);
  expect(isTypingTarget(el('<textarea></textarea>'))).toBe(true);
  expect(isTypingTarget(el('<select></select>'))).toBe(true);
  expect(isTypingTarget(el('<div contenteditable="true"></div>'))).toBe(true);
  expect(isTypingTarget(el('<div contenteditable></div>'))).toBe(true);
  const inside = el('<div contenteditable="true"><p><b>x</b></p></div>')?.querySelector('b');
  expect(isTypingTarget(inside ?? null)).toBe(true);

  expect(isTypingTarget(el('<input type="button">'))).toBe(false);
  expect(isTypingTarget(el('<input type="checkbox">'))).toBe(false);
  expect(isTypingTarget(el('<input type="radio">'))).toBe(false);
  expect(isTypingTarget(el('<div contenteditable="false"></div>'))).toBe(false);
  expect(isTypingTarget(el('<button>Go</button>'))).toBe(false);
  expect(isTypingTarget(el('<div></div>'))).toBe(false);
  expect(isTypingTarget(null)).toBe(false);
  expect(isTypingTarget(window)).toBe(false);
});

test('useShortcuts runs the first match once, and leaves typing, repeats and other modifiers alone', () => {
  const comment = vi.fn();
  const panel = vi.fn();
  const off = vi.fn();
  const list: Shortcut[] = [
    { keys: ['c'], run: comment },
    { keys: ['shift', 'c'], run: panel },
    { keys: ['f'], run: off, enabled: false },
  ];
  const { unmount } = renderHook(() => useShortcuts(list));

  const c = press('c');
  window.dispatchEvent(c);
  expect(comment).toHaveBeenCalledTimes(1);
  expect(c.defaultPrevented).toBe(true);

  window.dispatchEvent(press('C', { shiftKey: true }));
  expect(panel).toHaveBeenCalledTimes(1);
  expect(comment).toHaveBeenCalledTimes(1);

  window.dispatchEvent(press('c', { repeat: true }));
  window.dispatchEvent(press('c', { ctrlKey: true }));
  window.dispatchEvent(press('c', { metaKey: true }));
  window.dispatchEvent(press('c', { altKey: true }));
  window.dispatchEvent(press('f'));
  expect(comment).toHaveBeenCalledTimes(1);
  expect(off).not.toHaveBeenCalled();

  document.body.innerHTML = '<input aria-label="Width"><div role="dialog"><button>x</button></div>';
  document.querySelector('input')?.dispatchEvent(press('c'));
  // Keys pressed inside a dialog or a menu belong to it.
  document.querySelector('[role="dialog"] button')?.dispatchEvent(press('c'));
  expect(comment).toHaveBeenCalledTimes(1);

  // A key some other handler already took is left alone.
  const taken = press('c');
  taken.preventDefault();
  window.dispatchEvent(taken);
  expect(comment).toHaveBeenCalledTimes(1);

  unmount();
  window.dispatchEvent(press('c'));
  expect(comment).toHaveBeenCalledTimes(1);
});

test('useShortcuts always calls the latest handlers', () => {
  const first = vi.fn();
  const second = vi.fn();
  const { rerender } = renderHook(({ run }) => useShortcuts([{ keys: ['j'], run }]), {
    initialProps: { run: first },
  });
  rerender({ run: second });
  window.dispatchEvent(press('j'));
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});
