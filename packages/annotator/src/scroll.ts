/**
 * How far a window is scrolled, as fractions of its scroll range, and scrolling it to such
 * fractions: two versions of a page of different lengths can be kept at the same place this way.
 */
import { finite, fraction } from './geometry.ts';

/** How far `win` can scroll each way, in CSS pixels, never below 0. */
function scrollRange(win: Window): { x: number; y: number } {
  const doc = win.document;
  // The element whose scroll is the viewport's: `<body>` in quirks mode, else the root.
  const root = doc.scrollingElement ?? doc.documentElement;
  return {
    x: Math.max(0, finite(root?.scrollWidth) - finite(root?.clientWidth)),
    y: Math.max(0, finite(root?.scrollHeight) - finite(root?.clientHeight)),
  };
}

/** `win`'s scroll offset as fractions (0..1, 4 decimals) of its scroll range; 0 where it has none. */
export function scrollFraction(win: Window): { x: number; y: number } {
  const range = scrollRange(win);
  return {
    x: fraction(finite(win.scrollX) / Math.max(1, range.x)),
    y: fraction(finite(win.scrollY) / Math.max(1, range.y)),
  };
}

/** Scrolls `win` at once to fractions `f` of its scroll range. */
export function scrollToFraction(win: Window, f: { x: number; y: number }): void {
  const range = scrollRange(win);
  win.scrollTo({ left: f.x * range.x, top: f.y * range.y, behavior: 'instant' });
}
