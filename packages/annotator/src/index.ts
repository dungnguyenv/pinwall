/**
 * The entry of the annotator bundle (`__pinwall/annotator.js`), which Pinwall adds to every HTML
 * page of a review grant. It boots at once, before the page's own scripts run.
 */
import { boot } from './boot.ts';
import { guard } from './guard.ts';
import { querySelector } from './pristine.ts';

/** The URL this script was loaded from. */
function scriptSrc(): string | null {
  const current = document.currentScript as HTMLScriptElement | null;
  if (current?.src) return current.src;
  const tag = querySelector(document, 'script[data-pinwall-annotator]') as HTMLScriptElement | null;
  return tag?.src || null;
}

guard(() => boot(window, { scriptSrc: scriptSrc() }))();
