import { useEffect, useLayoutEffect, useRef } from 'react';
import { isApplePlatform } from '../ui/kbd.tsx';

/**
 * One keyboard shortcut. `keys` names modifiers first, then one key: a
 * character as typed ('c', '?', '['), or a key name ('escape', 'enter').
 * 'mod' is ⌘ on Apple platforms and Ctrl elsewhere.
 */
export interface Shortcut {
  keys: string[];
  run(e: KeyboardEvent): void;
  /** False turns the shortcut off for now; the key then does what it would anyway. */
  enabled?: boolean;
}

const MODIFIERS = new Set(['mod', 'shift', 'alt', 'ctrl', 'meta']);
/** Inputs that take a click, not text. */
const BUTTON_INPUTS = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'image']);

/**
 * Whether a key pressed in `t` is typing: a text field, a select, or editable
 * content. Buttons, checkboxes and radios are not.
 */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t instanceof HTMLInputElement) return !BUTTON_INPUTS.has(t.type);
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Whether `e` is the shortcut `keys`. A letter or a key name is matched with
 * exactly the modifiers named. Any other character is matched as typed,
 * whatever Shift the layout needed for it ('?' is Shift+/ on US layouts), but
 * never with Ctrl, ⌘ or Alt unless they are named.
 */
export function matchesKeys(e: KeyboardEvent, keys: string[]): boolean {
  const names = keys.map((k) => k.toLowerCase());
  const key = names.find((k) => !MODIFIERS.has(k));
  if (key === undefined) return false;
  const named = new Set(names.filter((k) => MODIFIERS.has(k)));
  const apple = isApplePlatform();
  const wantCtrl = named.has('ctrl') || (named.has('mod') && !apple);
  const wantMeta = named.has('meta') || (named.has('mod') && apple);
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta || e.altKey !== named.has('alt')) {
    return false;
  }
  const pressed = e.key.toLowerCase();
  // A letter or a named key ('escape'): Shift is part of the shortcut.
  if (/^[a-z]$/.test(key) || key.length > 1) {
    return pressed === key && e.shiftKey === named.has('shift');
  }
  // Any other character: the character itself, however it was typed.
  return e.key === key;
}

/** Keys pressed inside a dialog or a menu belong to it. */
function inLayer(t: EventTarget | null): boolean {
  return (
    t instanceof Element &&
    t.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null
  );
}

/**
 * Runs the first enabled shortcut in `list` that a key press on the page
 * matches, and keeps the key from doing anything else. Skips presses while
 * typing, inside a dialog or menu, held-down repeats, presses another handler
 * already took, and presses with Ctrl, ⌘ or Alt that no shortcut names. The
 * list may change on every render.
 */
export function useShortcuts(list: Shortcut[]): void {
  const latest = useRef(list);
  useLayoutEffect(() => {
    latest.current = list;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing) return;
      if (isTypingTarget(e.target) || inLayer(e.target)) return;
      const shortcut = latest.current.find((s) => s.enabled !== false && matchesKeys(e, s.keys));
      if (shortcut === undefined) return;
      e.preventDefault();
      shortcut.run(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
