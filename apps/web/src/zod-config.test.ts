import { expect, test, vi } from 'vitest';

/**
 * zod probes whether the page allows `eval` with `new Function("")` when it
 * builds its object schemas. Under a Content-Security-Policy without
 * 'unsafe-eval' the browser reports each probe as a violation, though zod
 * catches the error. This watches for it. (zod is a dependency, so Node
 * caches it across `vi.resetModules()`: this file must hold only one test that
 * imports it.)
 */
test('zod is set to jitless before the schemas are built, so it never probes eval', async () => {
  const calls: string[][] = [];
  vi.stubGlobal(
    'Function',
    new Proxy(Function, {
      construct(target, args, newTarget) {
        calls.push(args.map(String));
        return Reflect.construct(target, args, newTarget);
      },
    }),
  );
  // The watcher sees a construction.
  new Function('return 1');
  expect(calls).toEqual([['return 1']]);
  calls.length = 0;

  await import('./zod-config.ts');
  const shared = await import('@pinwall/shared');
  vi.unstubAllGlobals();

  expect(calls).toEqual([]);
  // Jitless is slower, not different: the schemas still validate.
  expect(shared.PublishResult.safeParse({}).success).toBe(false);
});
