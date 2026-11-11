/**
 * Events a test treats as the user's own. jsdom cannot make a trusted input event, so the runtime
 * tests stand `isUserEvent` in for the platform's `isTrusted` (see `pristine.test.ts` for the real
 * one, and the Playwright checks for real input). No imports: `vi.mock` factories load this file.
 */
const userEvents = new WeakSet<Event>();

/** Marks `event` as the user's own and returns it. */
export function asUser<E extends Event>(event: E): E {
  userEvents.add(event);
  return event;
}

export function isUserEvent(event: Event): boolean {
  return userEvents.has(event);
}
