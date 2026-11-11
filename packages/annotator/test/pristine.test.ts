import { JSDOM } from 'jsdom';
import { expect, onTestFinished, test } from 'vitest';
import { isTrusted } from '../src/pristine.ts';

test('isTrusted tells events the browser made from events scripts made', async () => {
  // A page that tries to pass its own events off as the user's.
  Object.defineProperty(Event.prototype, 'isTrusted', { configurable: true, get: () => true });
  onTestFinished(() => {
    Reflect.deleteProperty(Event.prototype, 'isTrusted');
  });
  const synthetic = new MouseEvent('click', { bubbles: true });
  document.body.dispatchEvent(synthetic);
  expect(isTrusted(synthetic)).toBe(false);

  // jsdom fires `load` itself, as browsers fire input events.
  const frame = new JSDOM('<p>x</p>', { url: 'http://localhost:3000/c/tok/' }).window;
  onTestFinished(() => frame.close());
  const load = await new Promise<Event>((resolve) => frame.addEventListener('load', resolve));
  expect(isTrusted(load)).toBe(true);
});
