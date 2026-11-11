import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BACKUP_LEASE,
  blobRegistry,
  collectBlobs,
  InProcessBlobRegistry,
  sweepBlobs,
} from '../../src/domain/blobs.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { IngestBudget } from '../../src/publish/limits.ts';
import { BlobStager } from '../../src/publish/stage.ts';
import { blobState, ref, sha, storeBlob } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const T = Date.UTC(2026, 10, 10);
const GONE = { row: false, object: false };
const KEPT = { row: true, object: true };

/** A promise plus the function that resolves it. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire = () => {};
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

describe('InProcessBlobRegistry', () => {
  test('runs work on one sha one at a time and on different shas side by side', async () => {
    const registry = new InProcessBlobRegistry();
    const log: string[] = [];
    const firstMayEnd = signal();

    const first = registry.withLock('a', async () => {
      log.push('first start');
      await firstMayEnd.promise;
      log.push('first end');
      return 1;
    });
    const second = registry.withLock('a', async () => {
      log.push('second');
      return 2;
    });
    const other = registry.withLock('b', async () => {
      log.push('other');
      return 3;
    });

    expect(await other).toBe(3);
    expect(log).toEqual(['first start', 'other']);
    firstMayEnd.fire();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(log).toEqual(['first start', 'other', 'first end', 'second']);
  });

  test('a failure releases the lock for the next caller', async () => {
    const registry = new InProcessBlobRegistry();
    await expect(
      registry.withLock('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await registry.withLock('a', async () => 'next')).toBe('next');
  });

  test('a sha stays pinned while any owner pins it', () => {
    const registry = new InProcessBlobRegistry();
    registry.pin('up1', 'x');
    registry.pin('up1', 'x');
    registry.pin('up1', 'y');
    registry.pin('up2', 'x');

    expect(registry.unpinAll('up1').sort()).toEqual(['x', 'y']);
    expect(registry.isPinned('x')).toBe(true);
    expect(registry.isPinned('y')).toBe(false);
    expect(registry.unpinAll('up1')).toEqual([]);
    expect(registry.unpinAll('up2')).toEqual(['x']);
    expect(registry.isPinned('x')).toBe(false);
  });
});

describe.each(dialects)('blob garbage collection on %s', (dialect) => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T) });
  });
  afterEach(() => ctx.close());

  const stager = () => new BlobStager(ctx.deps, new IngestBudget(ctx.deps.config.limits));

  test('one registry per deps', () => {
    expect(blobRegistry(ctx.deps)).toBe(blobRegistry(ctx.deps));
    expect(blobRegistry({ ...ctx.deps })).not.toBe(blobRegistry(ctx.deps));
  });

  test('collection deletes unreferenced blobs and skips referenced and pinned ones', async () => {
    const orphan = await storeBlob(ctx.deps, 'orphan');
    const used = await storeBlob(ctx.deps, 'used');
    await ref(ctx.deps, used);
    const upload = stager();
    const { sha256: pinned } = await upload.stage('p.txt', Buffer.from('pinned'), null);

    // A version can hold the same bytes under several paths, so keys may repeat.
    expect(await collectBlobs(ctx.deps, [orphan, used, pinned, orphan])).toEqual({
      deleted: [orphan],
      deferred: [],
    });
    expect(await blobState(ctx.deps, orphan)).toEqual(GONE);
    expect(await blobState(ctx.deps, used)).toEqual(KEPT);
    expect(await blobState(ctx.deps, pinned)).toEqual(KEPT);
  });

  test('collection defers while the backup lease is held', async () => {
    await storeBlob(ctx.deps, 'Y');
    expect(await ctx.deps.leases.acquire(BACKUP_LEASE, 'backup', 60_000)).toBe(true);

    expect(await collectBlobs(ctx.deps, [sha('Y')])).toEqual({ deleted: [], deferred: [sha('Y')] });
    expect(await blobState(ctx.deps, sha('Y'))).toEqual(KEPT);
    expect(await sweepBlobs(ctx.deps)).toBe(0); // still held
    await ctx.deps.leases.release(BACKUP_LEASE, 'backup');
    expect(await sweepBlobs(ctx.deps)).toBe(1);
    expect(await ctx.deps.blobs.has(sha('Y'))).toBe(false);
  });

  test('an aborted upload during a backup leaves its blobs to the sweep', async () => {
    const upload = stager();
    await upload.stage('a.txt', Buffer.from('A'), null);
    await ctx.deps.leases.acquire(BACKUP_LEASE, 'backup', 60_000);

    await upload.abort();
    expect(await blobState(ctx.deps, sha('A'))).toEqual(KEPT);
    await ctx.deps.leases.release(BACKUP_LEASE, 'backup');
    expect(await sweepBlobs(ctx.deps)).toBe(1);
    expect(await blobState(ctx.deps, sha('A'))).toEqual(GONE);
  });

  test('sweep removes unreferenced rows left by a crash and keeps the rest', async () => {
    const orphan = await storeBlob(ctx.deps, 'left by a crash');
    // A crash between the row and the bytes leaves a row alone.
    const rowOnly = sha('row only');
    await ctx.deps.db.db
      .insertInto('blobs')
      .values({ sha256: rowOnly, size: 8, created_at: T })
      .execute();
    const used = await storeBlob(ctx.deps, 'used');
    await ref(ctx.deps, used);
    const upload = stager();
    const { sha256: pinned } = await upload.stage('p.txt', Buffer.from('pinned'), null);

    expect(await sweepBlobs(ctx.deps)).toBe(2);
    expect(await blobState(ctx.deps, orphan)).toEqual(GONE);
    expect(await blobState(ctx.deps, rowOnly)).toEqual(GONE);
    expect(await blobState(ctx.deps, used)).toEqual(KEPT);
    expect(await blobState(ctx.deps, pinned)).toEqual(KEPT);
    expect(await sweepBlobs(ctx.deps)).toBe(0);
  });

  test('sweep takes at most one batch per call', async () => {
    for (const text of ['one', 'two', 'three']) await storeBlob(ctx.deps, text);
    expect(await sweepBlobs(ctx.deps, 2)).toBe(2);
    expect(await sweepBlobs(ctx.deps, 2)).toBe(1);
    expect(await sweepBlobs(ctx.deps, 2)).toBe(0);
  });

  test('deleting a version keeps a blob that an upload in progress has staged', async () => {
    const first = stager();
    await first.stage('index.html', Buffer.from('X'), null);
    const versionId = await ref(ctx.deps, sha('X'));
    first.release();

    // A second upload stages the same bytes while the version is deleted and its blobs collected.
    const upload = stager();
    await upload.stage('copy.html', Buffer.from('X'), null);
    await ctx.deps.db.db.deleteFrom('versions').where('id', '=', versionId).execute();
    expect(await collectBlobs(ctx.deps, [sha('X')])).toEqual({ deleted: [], deferred: [] });
    expect(await sweepBlobs(ctx.deps)).toBe(0);
    expect(await blobState(ctx.deps, sha('X'))).toEqual(KEPT);

    // The upload commits a version referencing the bytes, then lets go of its pins.
    await ref(ctx.deps, sha('X'));
    upload.release();
    expect(await sweepBlobs(ctx.deps)).toBe(0);
    expect(await blobState(ctx.deps, sha('X'))).toEqual(KEPT);
  });

  test('staging waits for a collection of the same blob that is under way', async () => {
    const x = await storeBlob(ctx.deps, 'X');
    // Hold the collection just before it removes the object.
    const deleting = signal();
    const mayDelete = signal();
    const realDelete = ctx.deps.blobs.delete.bind(ctx.deps.blobs);
    vi.spyOn(ctx.deps.blobs, 'delete').mockImplementation(async (key) => {
      deleting.fire();
      await mayDelete.promise;
      await realDelete(key);
    });

    const collecting = collectBlobs(ctx.deps, [x]);
    await deleting.promise;
    let staged = false;
    const staging = stager()
      .stage('x.txt', Buffer.from('X'), null)
      .then((file) => {
        staged = true;
        return file;
      });
    await sleep(50);
    expect(staged).toBe(false);

    mayDelete.fire();
    expect(await collecting).toEqual({ deleted: [x], deferred: [] });
    expect((await staging).sha256).toBe(x);
    // The upload stored the bytes again after the collection, so they are there to commit.
    expect(await blobState(ctx.deps, x)).toEqual(KEPT);
  });
});
