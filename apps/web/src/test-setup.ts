import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import { afterAll, afterEach, beforeAll } from 'vitest';
import i18n from './i18n.ts';
import { server } from './test/server.ts';
import { installMatchMedia, resetViewport } from './test/viewport.ts';

// The network is mocked at the boundary. A request no handler takes errors
// (it never reaches the network) and fails the test that sent it, even when
// the UI copes with the error.
const unhandledRequests: string[] = [];
server.events.on('request:unhandled', ({ request }) => {
  unhandledRequests.push(`${request.method} ${request.url}`);
});
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  if (unhandledRequests.length === 0) return;
  const requests = unhandledRequests.splice(0).join(', ');
  throw new Error(`Requests without a handler: ${requests}`);
});
afterAll(() => server.close());

// Every string the UI shows comes from en.json, so a key that is not there
// is a bug: record each one i18next misses and fail the test that asked.
const missingKeys = new Set<string>();
i18n.options.saveMissing = true;
i18n.options.missingKeyHandler = (_lngs, _ns, key) => {
  missingKeys.add(key);
};
afterEach(() => {
  if (missingKeys.size === 0) return;
  const keys = [...missingKeys].join(', ');
  missingKeys.clear();
  throw new Error(`Missing i18n keys: ${keys}`);
});

// jsdom leaves out a few browser APIs that Radix and sonner call. matchMedia
// answers width queries from `setViewport()`; the other stubs do nothing, and
// tests that need a specific behavior replace them locally.
installMatchMedia();

if (typeof window.ResizeObserver !== 'function') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
}

// jsdom has no layout and reports window.scrollTo as not implemented; the
// router's scroll restoration calls it on every navigation.
Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: () => {} });

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = () => {};
}
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {};
}

// sonner keeps its toasts in a module-level store and replays the open ones to
// the next Toaster, so a toast would otherwise carry over into the next test.
afterEach(() => {
  cleanup();
  toast.dismiss();
  resetViewport();
});
