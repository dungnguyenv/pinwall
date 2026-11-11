/**
 * The annotator runs inside pages it does not control: nothing it does may throw into them, log
 * to their console or leave an unhandled rejection behind.
 */

/** `fn` wrapped so that a throw, or a rejection of a promise it returns, goes nowhere. */
export function guard<A extends unknown[]>(fn: (...a: A) => unknown): (...a: A) => void {
  return (...args: A) => {
    try {
      const result = fn(...args);
      if (result !== null && typeof result === 'object' && 'then' in result) {
        const then = (result as PromiseLike<unknown>).then;
        if (typeof then === 'function') then.call(result, undefined, () => undefined);
      }
    } catch {
      // Swallowed: the page must never see the annotator fail.
    }
  };
}
