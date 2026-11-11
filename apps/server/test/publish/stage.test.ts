import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Config } from '../../src/config/types.ts';
import { collectBlobs } from '../../src/domain/blobs.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { IngestBudget } from '../../src/publish/limits.ts';
import { BlobStager } from '../../src/publish/stage.ts';
import { blobState, ref, sha } from '../helpers/blobs.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

const T = Date.UTC(2026, 10, 10);
const GONE = { row: false, object: false };
const KEPT = { row: true, object: true };

describe.each(dialects)('BlobStager on %s', (dialect) => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext({ dialect, clock: new FixedClock(T) });
  });
  afterEach(() => ctx.close());

  function stager(limits: Partial<Config['limits']> = {}): BlobStager {
    return new BlobStager(ctx.deps, new IngestBudget({ ...ctx.deps.config.limits, ...limits }));
  }

  const blobRows = () => ctx.deps.db.db.selectFrom('blobs').selectAll().execute();

  test('staging stores each blob once and records its row', async () => {
    const s = stager();
    const a = await s.stage('a.txt', Buffer.from('hello'), 5);
    // The same bytes again, streamed in two chunks.
    const b = await s.stage(
      'docs/b.txt',
      Readable.from([Buffer.from('hel'), Buffer.from('lo')]),
      null,
    );

    expect(a).toEqual({
      path: 'a.txt',
      sha256: sha('hello'),
      size: 5,
      contentType: 'text/plain; charset=utf-8',
    });
    expect(b).toEqual({ ...a, path: 'docs/b.txt' });
    expect(s.files).toEqual([a, b]);
    expect(await blobRows()).toEqual([{ sha256: sha('hello'), size: 5, created_at: T }]);
    expect(await ctx.deps.blobs.has(sha('hello'))).toBe(true);
  });

  test('staging an empty file stores the empty blob', async () => {
    const s = stager();
    const file = await s.stage('empty', Buffer.alloc(0), 0);
    expect(file).toEqual({
      path: 'empty',
      sha256: sha(''),
      size: 0,
      contentType: 'application/octet-stream',
    });
    expect(await blobState(ctx.deps, sha(''))).toEqual(KEPT);
  });

  test('staging counts bytes against the budget', async () => {
    const tooLarge = expect.objectContaining({
      status: 413,
      details: expect.objectContaining({ limit: 'max_file_bytes', max: 4, path: 'a.txt' }),
    });
    await expect(
      stager({ maxFileBytes: 4 }).stage('a.txt', Buffer.from('hello'), null),
    ).rejects.toEqual(tooLarge);
    // A stream is counted chunk by chunk and abandoned as soon as it crosses the limit.
    const body = Readable.from([Buffer.from('hel'), Buffer.from('lo'), Buffer.from('!')]);
    await expect(stager({ maxFileBytes: 4 }).stage('a.txt', body, null)).rejects.toEqual(tooLarge);
    expect(body.destroyed).toBe(true);
    // A declared size over the limit is refused before any byte is read.
    await expect(stager({ maxFileBytes: 4 }).stage('a.txt', Buffer.from('hey'), 5)).rejects.toEqual(
      tooLarge,
    );

    expect(await blobRows()).toEqual([]);
    expect(await ctx.deps.blobs.has(sha('hello'))).toBe(false);
    expect(await ctx.deps.blobs.has(sha('hey'))).toBe(false);
  });

  test('abort removes blobs this upload added and keeps referenced ones', async () => {
    await ref(ctx.deps, sha('A'));
    const s = stager();
    await s.stage('a.txt', Buffer.from('A'), null);
    await s.stage('b.txt', Buffer.from('B'), null);

    await s.abort();
    expect(await blobState(ctx.deps, sha('B'))).toEqual(GONE);
    expect(await blobState(ctx.deps, sha('A'))).toEqual(KEPT);
  });

  test('a blob pinned by another upload survives collection', async () => {
    const s1 = stager();
    const s2 = stager();
    await s1.stage('x.txt', Buffer.from('X'), null);
    await s2.stage('copy-of-x.txt', Buffer.from('X'), null);

    await s1.abort();
    expect(await blobState(ctx.deps, sha('X'))).toEqual(KEPT);
    await s2.abort();
    expect(await blobState(ctx.deps, sha('X'))).toEqual(GONE);
  });

  test('release hands the blobs over to the versions that reference them', async () => {
    const s = stager();
    await s.stage('kept.txt', Buffer.from('K'), null);
    await s.stage('dropped.txt', Buffer.from('D'), null);
    // The commit references one of the two files.
    await ref(ctx.deps, sha('K'));
    s.release();

    expect(await collectBlobs(ctx.deps, [sha('K'), sha('D')])).toEqual({
      deleted: [sha('D')],
      deferred: [],
    });
    expect(await blobState(ctx.deps, sha('K'))).toEqual(KEPT);
  });

  test('a stager refuses work once aborted or released', async () => {
    const aborted = stager();
    await aborted.abort();
    await expect(aborted.stage('a.txt', Buffer.from('A'), null)).rejects.toThrow(
      /aborted or released/,
    );

    const released = stager();
    released.release();
    await expect(released.stage('a.txt', Buffer.from('A'), null)).rejects.toThrow(
      /aborted or released/,
    );
    expect(await blobRows()).toEqual([]);
  });
});
