import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { migrateToLatest } from '../../src/db/migrate.ts';
import { DbLeaseManager } from '../../src/infra/leases.ts';
import { InProcessScheduler } from '../../src/infra/scheduler.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { dialects, withDb } from '../helpers/db.ts';

const T = 1_762_000_000_000;
const INTERVAL = 20;

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A promise settled from outside, for jobs that must stay running until the test says so. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe.each(dialects)('InProcessScheduler on %s', (dialect) => {
  async function setup() {
    const h = await withDb(dialect);
    onTestFinished(() => h.close());
    await migrateToLatest(h);
    const leases = new DbLeaseManager(h, new FixedClock(T));
    const logger = { error: vi.fn() };
    const scheduler = (holder: string) => {
      const created = new InProcessScheduler(leases, logger, holder);
      // Cleanups run last-registered first, so this stops before the database closes.
      onTestFinished(() => created.stop());
      return created;
    };
    return { leases, logger, scheduler };
  }

  test('runs the job on every interval', async () => {
    const { scheduler } = await setup();
    const runs = vi.fn(async () => {});

    scheduler('a').every('tick', INTERVAL, runs);

    await waitFor(() => runs.mock.calls.length >= 3, 'three runs');
  });

  test('logs failures without stopping', async () => {
    const { logger, scheduler } = await setup();
    const boom = new Error('boom');
    let calls = 0;

    scheduler('a').every('flaky', INTERVAL, async () => {
      calls += 1;
      if (calls === 1) throw boom;
    });

    await waitFor(() => calls >= 3, 'the job to run again after failing');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'flaky', err: boom }),
      expect.stringContaining('flaky'),
    );
  });

  test('a job never overlaps itself', async () => {
    const { scheduler } = await setup();
    let active = 0;
    let peak = 0;
    let runs = 0;

    scheduler('a').every('slow', INTERVAL, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, INTERVAL * 3));
      active -= 1;
      runs += 1;
    });

    await waitFor(() => runs >= 2, 'two runs');
    expect(peak).toBe(1);
  });

  test('stop waits for a running job', async () => {
    const { scheduler } = await setup();
    const release = deferred();
    let started = false;
    let finished = false;
    const instance = scheduler('a');
    instance.every('long', INTERVAL, async () => {
      started = true;
      await release.promise;
      finished = true;
    });
    await waitFor(() => started, 'the job to start');

    let stopped = false;
    const stopping = instance.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 3));
    expect(stopped).toBe(false);

    release.resolve();
    await stopping;
    expect(finished).toBe(true);
  });

  test('stop ends the schedule and releases the leases', async () => {
    const { leases, scheduler } = await setup();
    const runs = vi.fn(async () => {});
    const instance = scheduler('a');
    instance.every('hourly', INTERVAL, runs);
    await waitFor(() => runs.mock.calls.length >= 1, 'a run');
    expect(await leases.isHeld('job:hourly')).toBe(true);

    await instance.stop();
    const seen = runs.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 4));

    expect(runs.mock.calls.length).toBe(seen);
    expect(await leases.isHeld('job:hourly')).toBe(false);
  });

  test('a second scheduler sharing the lease does not run the job concurrently', async () => {
    const { scheduler } = await setup();
    const release = deferred();
    let active = 0;
    let peak = 0;
    const runsBy = { a: 0, b: 0 };
    const job = (who: 'a' | 'b') => async () => {
      active += 1;
      peak = Math.max(peak, active);
      runsBy[who] += 1;
      await release.promise;
      active -= 1;
    };
    const first = scheduler('a');
    const second = scheduler('b');

    first.every('shared', INTERVAL, job('a'));
    second.every('shared', INTERVAL, job('b'));
    await waitFor(() => runsBy.a + runsBy.b >= 1, 'a run');
    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 5));

    expect(runsBy.a + runsBy.b).toBe(1);
    expect(peak).toBe(1);

    release.resolve();
    await first.stop();
    await second.stop();
  });

  test('another scheduler takes the job over once the first one stops', async () => {
    const { scheduler } = await setup();
    const runsBy = { a: 0, b: 0 };
    const first = scheduler('a');
    const second = scheduler('b');
    first.every('shared', INTERVAL, async () => {
      runsBy.a += 1;
    });
    second.every('shared', INTERVAL, async () => {
      runsBy.b += 1;
    });
    await waitFor(() => runsBy.a + runsBy.b >= 2, 'the first runs');
    const leader = runsBy.a > 0 ? first : second;
    const follower = runsBy.a > 0 ? 'b' : 'a';
    expect(runsBy[follower]).toBe(0);

    await leader.stop();

    await waitFor(() => runsBy[follower] >= 1, 'the other scheduler to take over');
  });

  test('every rejects a duplicate name, a bad interval and a stopped scheduler', async () => {
    const { scheduler } = await setup();
    const instance = scheduler('a');
    instance.every('once', INTERVAL, async () => {});

    expect(() => instance.every('once', INTERVAL, async () => {})).toThrow(/already scheduled/);
    expect(() => instance.every('zero', 0, async () => {})).toThrow(/interval/i);
    expect(() => instance.every('nan', Number.NaN, async () => {})).toThrow(/interval/i);

    await instance.stop();
    expect(() => instance.every('late', INTERVAL, async () => {})).toThrow(/stopped/);
  });
});
