import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Config } from '../../src/config/types.ts';
import { contentTypeOf } from '../../src/content/mime.ts';
import { collectBlobs } from '../../src/domain/blobs.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { IngestBudget } from '../../src/publish/limits.ts';
import { BlobStager } from '../../src/publish/stage.ts';
import type { BlobStore } from '../../src/storage/blob-store.ts';
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

  test('a streamed file reaches the store while it still arrives, never whole in memory', async () => {
    const CHUNK = 64 * 1024;
    const CHUNKS = 64;
    const total = CHUNK * CHUNKS;
    let produced = 0;
    const whole = createHash('sha256');
    function* chunks(): Generator<Buffer> {
      for (let i = 0; i < CHUNKS; i++) {
        const chunk = Buffer.alloc(CHUNK, i % 251);
        whole.update(chunk);
        produced += chunk.length;
        yield chunk;
      }
    }
    // How much of the file had arrived when its first byte reached the store, either way.
    let arrivedAtFirstStore: number | null = null;
    const real = ctx.deps.blobs;
    async function* watched(body: Readable): AsyncGenerator<Buffer> {
      for await (const chunk of body) {
        arrivedAtFirstStore ??= produced;
        yield chunk as Buffer;
      }
    }
    const blobs: BlobStore = Object.assign(Object.create(real) as BlobStore, {
      put: (sha256: string, body: Buffer | Readable, size: number) => {
        arrivedAtFirstStore ??= produced;
        return real.put(sha256, body, size);
      },
      spool: (body: Readable) => real.spool(Readable.from(watched(body), { objectMode: false })),
    });
    const s = new BlobStager(
      { ...ctx.deps, blobs },
      new IngestBudget({ ...ctx.deps.config.limits, maxFileBytes: total }),
    );

    const file = await s.stage('big.bin', Readable.from(chunks(), { objectMode: false }), null);
    const key = whole.digest('hex');
    expect(file).toEqual({
      path: 'big.bin',
      sha256: key,
      size: total,
      contentType: 'application/octet-stream',
    });
    expect(arrivedAtFirstStore).not.toBeNull();
    expect(arrivedAtFirstStore ?? total).toBeLessThan(total / 4);
    expect(await blobState(ctx.deps, key)).toEqual(KEPT);
    expect(await blobRows()).toEqual([{ sha256: key, size: total, created_at: T }]);
  });

  test('a streamed HTML file is labeled with the charset its first bytes declare', async () => {
    const parts = [
      '<!doctype html><meta char',
      'set="windows-1252">',
      `<p>${'é'.repeat(4000)}</p>`,
    ];
    const whole = Buffer.from(parts.join(''), 'latin1');
    const file = await stager().stage(
      'index.html',
      Readable.from(
        parts.map((part) => Buffer.from(part, 'latin1')),
        { objectMode: false },
      ),
      null,
    );
    expect(file.contentType).toBe(contentTypeOf('index.html', whole));
    expect(file.contentType).not.toBe(contentTypeOf('index.html', Buffer.from('<p>')));
  });

  test('a stream the budget refuses leaves nothing stored and nothing in temporary space', async () => {
    const body = Readable.from([Buffer.from('hel'), Buffer.from('lo'), Buffer.from('!')]);
    await expect(stager({ maxFileBytes: 4 }).stage('a.txt', body, null)).rejects.toMatchObject({
      status: 413,
    });
    expect(body.destroyed).toBe(true);
    expect(await blobRows()).toEqual([]);
    const { storage } = ctx.deps.config;
    if (storage.kind === 'local') {
      expect(await readdir(join(storage.dir, 'tmp')).catch(() => [])).toEqual([]);
    }
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
