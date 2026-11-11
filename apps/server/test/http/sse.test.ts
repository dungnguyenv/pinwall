import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AppEnv } from '../../src/app.ts';
import { type LiveStreamOptions, liveStream, SSE_HEARTBEAT_MS } from '../../src/http/sse.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { readSse } from '../helpers/review.ts';

const RETRY = 'retry: 5000\n\n';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  vi.useRealTimers();
  await ctx.close();
});

/** A bare app whose one route opens a live stream with `o`. */
function streamApp(o: LiveStreamOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set('deps', ctx.deps);
    await next();
  });
  app.get('/stream', (c) => liveStream(c, o));
  return app;
}

async function open(o: LiveStreamOptions) {
  const s = readSse(await streamApp(o).request('/stream'));
  expect(await s.next()).toBe(RETRY);
  return s;
}

const options = (stillAllowed: () => Promise<boolean>): LiveStreamOptions => ({
  topic: 'artifact:art_1',
  forward: () => 'send',
  stillAllowed,
});

test('access is checked once as a stream opens, so access lost while it opened ends it', async () => {
  const stillAllowed = vi.fn(async () => false);
  const s = await open(options(stillAllowed));
  expect(await s.done()).toBe(true);
  expect(stillAllowed).toHaveBeenCalledTimes(1);
  expect(ctx.deps.liveStreams.size).toBe(0);
});

test('a heartbeat during a check gets a check of its own once that one ends', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const answers: ((allowed: boolean) => void)[] = [];
  const stillAllowed = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        answers.push(resolve);
      }),
  );
  const s = await open(options(stillAllowed));
  // The opening check is still running when the heartbeat comes: no second one at the same time.
  expect(stillAllowed).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);
  expect(stillAllowed).toHaveBeenCalledTimes(1);
  answers[0]?.(true);
  // ... but one right after, which sees access gone.
  await vi.waitFor(() => expect(stillAllowed).toHaveBeenCalledTimes(2));
  answers[1]?.(false);
  expect(await s.next()).toBe(': ping\n\n');
  expect(await s.done()).toBe(true);
});
