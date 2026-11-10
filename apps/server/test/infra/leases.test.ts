import { describe, expect, onTestFinished, test } from 'vitest';
import { migrateToLatest } from '../../src/db/migrate.ts';
import { DbLeaseManager } from '../../src/infra/leases.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { dialects, withDb } from '../helpers/db.ts';

const T = 1_762_000_000_000;

describe.each(dialects)('DbLeaseManager on %s', (dialect) => {
  async function setup() {
    const h = await withDb(dialect);
    onTestFinished(() => h.close());
    await migrateToLatest(h);
    const clock = new FixedClock(T);
    return { clock, leases: new DbLeaseManager(h, clock) };
  }

  test('acquire is exclusive until expiry or release', async () => {
    const { clock, leases } = await setup();

    expect(await leases.acquire('job:gc', 'a', 10_000)).toBe(true);
    expect(await leases.acquire('job:gc', 'b', 10_000)).toBe(false);
    expect(await leases.isHeld('job:gc')).toBe(true);

    clock.advance(10_000);
    expect(await leases.acquire('job:gc', 'b', 10_000)).toBe(false);

    clock.advance(1);
    expect(await leases.acquire('job:gc', 'b', 10_000)).toBe(true);

    await leases.release('job:gc', 'b');
    expect(await leases.acquire('job:gc', 'a', 10_000)).toBe(true);
  });

  test('leases with different names do not interfere', async () => {
    const { leases } = await setup();

    expect(await leases.acquire('one', 'a', 1_000)).toBe(true);
    expect(await leases.acquire('two', 'b', 1_000)).toBe(true);
  });

  test('renew only by the holder', async () => {
    const { clock, leases } = await setup();
    await leases.acquire('job', 'a', 10_000);

    expect(await leases.renew('job', 'b', 10_000)).toBe(false);
    expect(await leases.renew('unknown', 'a', 10_000)).toBe(false);

    clock.advance(8_000);
    expect(await leases.renew('job', 'a', 10_000)).toBe(true);

    // The original term has passed, the renewed one has not.
    clock.advance(5_000);
    expect(await leases.acquire('job', 'b', 10_000)).toBe(false);
    expect(await leases.isHeld('job')).toBe(true);

    clock.advance(5_001);
    expect(await leases.isHeld('job')).toBe(false);
  });

  test('a lease that expired cannot be renewed', async () => {
    const { clock, leases } = await setup();
    await leases.acquire('job', 'a', 1_000);

    clock.advance(1_001);

    expect(await leases.renew('job', 'a', 1_000)).toBe(false);
  });

  test('expired lease can be taken over', async () => {
    const { clock, leases } = await setup();
    await leases.acquire('job', 'a', 1_000);
    clock.advance(5_000);

    expect(await leases.acquire('job', 'b', 1_000)).toBe(true);

    expect(await leases.renew('job', 'a', 1_000)).toBe(false);
    expect(await leases.renew('job', 'b', 1_000)).toBe(true);
    expect(await leases.isHeld('job')).toBe(true);
  });

  test('isHeld false after release', async () => {
    const { leases } = await setup();
    expect(await leases.isHeld('job')).toBe(false);

    await leases.acquire('job', 'a', 10_000);
    expect(await leases.isHeld('job')).toBe(true);

    await leases.release('job', 'a');
    expect(await leases.isHeld('job')).toBe(false);
  });

  test('release by anyone but the holder changes nothing', async () => {
    const { leases } = await setup();
    await leases.acquire('job', 'a', 10_000);

    await leases.release('job', 'b');
    await leases.release('unknown', 'a');

    expect(await leases.isHeld('job')).toBe(true);
    expect(await leases.acquire('job', 'b', 10_000)).toBe(false);
  });

  test('when many holders race for one lease exactly one wins', async () => {
    const { leases } = await setup();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => leases.acquire('job', `holder-${i}`, 10_000)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('when many holders race for an expired lease exactly one takes it over', async () => {
    const { clock, leases } = await setup();
    await leases.acquire('job', 'old', 1_000);
    clock.advance(2_000);

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => leases.acquire('job', `holder-${i}`, 10_000)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
