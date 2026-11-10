import { describe, expect, test } from 'vitest';
import { InMemoryOneTimeStore } from '../../src/infra/one-time-store.ts';
import { FixedClock } from '../../src/lib/clock.ts';

const T = 1_762_000_000_000;

function setup() {
  const clock = new FixedClock(T);
  return { clock, store: new InMemoryOneTimeStore(clock) };
}

describe('InMemoryOneTimeStore', () => {
  test('take returns the value once', async () => {
    const { store } = setup();
    await store.put('code', { user: 'usr_1' }, 60_000);

    expect(await store.take('code')).toEqual({ user: 'usr_1' });
    expect(await store.take('code')).toBeNull();
  });

  test('take of an unknown key is null', async () => {
    expect(await setup().store.take('nope')).toBeNull();
  });

  test('take after expiry is null', async () => {
    const { clock, store } = setup();
    await store.put('code', 'value', 1_000);

    clock.advance(999);
    expect(await store.peek('code')).toBe('value');
    clock.advance(1);
    expect(await store.take('code')).toBeNull();
  });

  test('peek does not consume', async () => {
    const { store } = setup();
    await store.put('code', 42, 1_000);

    expect(await store.peek('code')).toBe(42);
    expect(await store.peek('code')).toBe(42);
    expect(await store.take('code')).toBe(42);
    expect(await store.peek('code')).toBeNull();
  });

  test('delete removes a value that was never taken', async () => {
    const { store } = setup();
    await store.put('code', 'value', 1_000);

    await store.delete('code');
    await store.delete('code');

    expect(await store.take('code')).toBeNull();
  });

  test('put again replaces the value and restarts the lifetime', async () => {
    const { clock, store } = setup();
    await store.put('code', 'old', 1_000);
    clock.advance(900);
    await store.put('code', 'new', 1_000);
    clock.advance(900);

    expect(await store.take('code')).toBe('new');
  });

  test('keys are independent', async () => {
    const { store } = setup();
    await store.put('a', 1, 1_000);
    await store.put('b', 2, 1_000);

    expect(await store.take('a')).toBe(1);
    expect(await store.take('b')).toBe(2);
  });

  test('entries that expire without being taken are dropped as the store is used', async () => {
    const { clock, store } = setup();
    for (let i = 0; i < 100; i++) await store.put(`abandoned-${i}`, i, 1_000);
    expect(store.size).toBe(100);

    clock.advance(10 * 60_000);
    await store.put('fresh', 'value', 1_000);

    expect(store.size).toBe(1);
  });
});
