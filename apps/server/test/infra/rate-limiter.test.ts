import { describe, expect, test } from 'vitest';
import { InMemoryRateLimiter } from '../../src/infra/rate-limiter.ts';
import { FixedClock } from '../../src/lib/clock.ts';

const T = 1_762_000_000_000;

function setup() {
  const clock = new FixedClock(T);
  return { clock, limiter: new InMemoryRateLimiter(clock) };
}

describe('InMemoryRateLimiter', () => {
  test('consume answers asynchronously, as a shared limiter would', () => {
    const { limiter } = setup();
    expect(limiter.consume('k', 1, 10_000)).toBeInstanceOf(Promise);
  });

  test('allows up to the limit then reports retryAfterMs', async () => {
    const { clock, limiter } = setup();

    for (let i = 0; i < 3; i++) {
      expect(await limiter.consume('ip:1', 3, 10_000)).toEqual({ allowed: true, retryAfterMs: 0 });
    }
    expect(await limiter.consume('ip:1', 3, 10_000)).toEqual({
      allowed: false,
      retryAfterMs: 10_000,
    });

    clock.advance(4_000);
    expect(await limiter.consume('ip:1', 3, 10_000)).toEqual({
      allowed: false,
      retryAfterMs: 6_000,
    });
  });

  test('window resets after windowMs', async () => {
    const { clock, limiter } = setup();
    await limiter.consume('k', 1, 10_000);
    expect((await limiter.consume('k', 1, 10_000)).allowed).toBe(false);

    clock.advance(9_999);
    expect(await limiter.consume('k', 1, 10_000)).toEqual({ allowed: false, retryAfterMs: 1 });
    clock.advance(1);
    expect(await limiter.consume('k', 1, 10_000)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect((await limiter.consume('k', 1, 10_000)).allowed).toBe(false);
  });

  test('keys are independent', async () => {
    const { limiter } = setup();
    expect((await limiter.consume('a', 1, 10_000)).allowed).toBe(true);
    expect((await limiter.consume('a', 1, 10_000)).allowed).toBe(false);

    expect((await limiter.consume('b', 1, 10_000)).allowed).toBe(true);
  });

  test('concurrent attempts on one key never exceed the limit', async () => {
    const { limiter } = setup();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume('k', 3, 10_000)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  test('a rejected attempt does not extend the window', async () => {
    const { clock, limiter } = setup();
    await limiter.consume('k', 1, 10_000);
    clock.advance(5_000);
    await limiter.consume('k', 1, 10_000);
    await limiter.consume('k', 1, 10_000);

    clock.advance(5_000);
    expect((await limiter.consume('k', 1, 10_000)).allowed).toBe(true);
  });

  test('a limit of zero never allows', async () => {
    const { limiter } = setup();
    expect(await limiter.consume('k', 0, 10_000)).toEqual({
      allowed: false,
      retryAfterMs: 10_000,
    });
  });

  test('windows that expire unused are dropped as the limiter is used', async () => {
    const { clock, limiter } = setup();
    for (let i = 0; i < 100; i++) await limiter.consume(`ip:${i}`, 5, 1_000);
    expect(limiter.size).toBe(100);

    clock.advance(10 * 60_000);
    await limiter.consume('ip:new', 5, 1_000);

    expect(limiter.size).toBe(1);
  });
});
