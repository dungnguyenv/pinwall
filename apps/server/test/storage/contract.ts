import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import type { BlobStore } from '../../src/storage/blob-store.ts';

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function keys(store: BlobStore): Promise<string[]> {
  const found: string[] = [];
  for await (const key of store.list()) found.push(key);
  return found.sort();
}

const CHUNK_BYTES = 1024 * 1024;
const CHUNKS = 20;

/** A deterministic 20 MB body, produced one chunk at a time so nothing holds it whole. */
function* chunksOfTwentyMegabytes(): Generator<Buffer> {
  for (let i = 0; i < CHUNKS; i++) yield Buffer.alloc(CHUNK_BYTES, (i * 7) % 251);
}

/**
 * The behavior every `BlobStore` must have. `make` returns an empty store that no other test
 * shares, and removes whatever it created once the test ends.
 */
export function runBlobStoreContract(name: string, make: () => Promise<BlobStore>): void {
  describe(`${name} blob store contract`, () => {
    test('round-trips bytes', async () => {
      const store = await make();
      const bytes = Buffer.from('<h1>Xin chào</h1>', 'utf8');
      const key = sha256(bytes);

      await store.put(key, bytes, bytes.length);
      expect(await collect(await store.get(key))).toEqual(bytes);

      const streamed = Buffer.from('streamed body');
      await store.put(sha256(streamed), Readable.from([streamed]), streamed.length);
      expect(await collect(await store.get(sha256(streamed)))).toEqual(streamed);
    });

    test('stores an empty blob', async () => {
      const store = await make();
      const key = sha256('');
      await store.put(key, Buffer.alloc(0), 0);
      expect(await store.has(key)).toBe(true);
      expect(await collect(await store.get(key))).toEqual(Buffer.alloc(0));
    });

    test('serves an inclusive byte range', async () => {
      const store = await make();
      const bytes = Buffer.from('0123456789');
      const key = sha256(bytes);
      await store.put(key, bytes, bytes.length);

      expect((await collect(await store.get(key, { start: 2, end: 5 }))).toString()).toBe('2345');
      expect((await collect(await store.get(key, { start: 0, end: 0 }))).toString()).toBe('0');
      expect((await collect(await store.get(key, { start: 8, end: 9 }))).toString()).toBe('89');
    });

    test('rejects a range that starts past the end of the blob', async () => {
      const store = await make();
      const bytes = Buffer.from('0123456789');
      const key = sha256(bytes);
      await store.put(key, bytes, bytes.length);

      await expect(store.get(key, { start: 10, end: 12 })).rejects.toMatchObject({
        code: 'bad_request',
      });
      await expect(store.get(key, { start: 5, end: 2 })).rejects.toMatchObject({
        code: 'bad_request',
      });
    });

    test('has reflects presence', async () => {
      const store = await make();
      const bytes = Buffer.from('present');
      const key = sha256(bytes);

      expect(await store.has(key)).toBe(false);
      await store.put(key, bytes, bytes.length);
      expect(await store.has(key)).toBe(true);
    });

    test('delete is idempotent', async () => {
      const store = await make();
      const bytes = Buffer.from('short lived');
      const key = sha256(bytes);

      await store.delete(key);
      await store.put(key, bytes, bytes.length);
      await store.delete(key);
      await store.delete(key);
      expect(await store.has(key)).toBe(false);
    });

    test('lists stored keys', async () => {
      const store = await make();
      expect(await keys(store)).toEqual([]);

      const bodies = ['one', 'two', 'three'].map((text) => Buffer.from(text));
      for (const body of bodies) await store.put(sha256(body), body, body.length);

      expect(await keys(store)).toEqual(bodies.map(sha256).sort());
    });

    test('get of a missing blob is not_found', async () => {
      const store = await make();
      await expect(store.get(sha256('never stored'))).rejects.toMatchObject({
        name: 'AppError',
        code: 'not_found',
        status: 404,
      });
    });

    test('rejects bytes that do not match the hash', async () => {
      const store = await make();
      const bytes = Buffer.from('actual bytes');
      const claimed = sha256('some other bytes');

      await expect(store.put(claimed, bytes, bytes.length)).rejects.toMatchObject({
        code: 'bad_request',
      });
      await expect(store.put(claimed, Readable.from([bytes]), bytes.length)).rejects.toMatchObject({
        code: 'bad_request',
      });
      expect(await store.has(claimed)).toBe(false);
      expect(await keys(store)).toEqual([]);
    });

    test('rejects bytes that do not match the declared size', async () => {
      const store = await make();
      const bytes = Buffer.from('twelve bytes');
      const key = sha256(bytes);

      for (const wrong of [bytes.length - 1, bytes.length + 1]) {
        await expect(store.put(key, bytes, wrong)).rejects.toMatchObject({ code: 'bad_request' });
        await expect(store.put(key, Readable.from([bytes]), wrong)).rejects.toMatchObject({
          code: 'bad_request',
        });
      }
      expect(await store.has(key)).toBe(false);
      expect(await keys(store)).toEqual([]);
    });

    test('put of an existing blob is a no-op', async () => {
      const store = await make();
      const bytes = Buffer.from('stored once');
      const key = sha256(bytes);

      await store.put(key, bytes, bytes.length);
      await store.put(key, bytes, bytes.length);
      await store.put(key, Readable.from([bytes]), bytes.length);

      expect(await keys(store)).toEqual([key]);
      expect(await collect(await store.get(key))).toEqual(bytes);
    });

    test('concurrent puts of the same blob all succeed', async () => {
      const store = await make();
      const bytes = Buffer.from('raced');
      const key = sha256(bytes);

      await Promise.all(
        Array.from({ length: 5 }, () => store.put(key, Readable.from([bytes]), bytes.length)),
      );

      expect(await keys(store)).toEqual([key]);
      expect(await collect(await store.get(key))).toEqual(bytes);
    });

    test('rejects a key that is not a sha256', async () => {
      const store = await make();
      for (const bad of ['', 'abc', '../../etc/passwd', 'A'.repeat(64), `${'a'.repeat(63)}/`]) {
        await expect(store.put(bad, Buffer.from('x'), 1)).rejects.toMatchObject({
          code: 'bad_request',
        });
        await expect(store.get(bad)).rejects.toMatchObject({ code: 'bad_request' });
        await expect(store.has(bad)).rejects.toMatchObject({ code: 'bad_request' });
        await expect(store.delete(bad)).rejects.toMatchObject({ code: 'bad_request' });
      }
    });

    test('spools a stream under its hash, and stores it only when asked', async () => {
      const store = await make();
      const parts = ['<h1>', 'Xin chào', '</h1>'].map((text) => Buffer.from(text));
      const bytes = Buffer.concat(parts);
      const key = sha256(bytes);

      const spooled = await store.spool(Readable.from(parts));
      expect({ sha256: spooled.sha256, size: spooled.size }).toEqual({
        sha256: key,
        size: bytes.length,
      });
      expect(await store.has(key)).toBe(false);
      await spooled.store();
      expect(await collect(await store.get(key))).toEqual(bytes);
      await spooled.discard();
      expect(await store.has(key)).toBe(true);
    });

    test('spools an empty stream', async () => {
      const store = await make();
      const spooled = await store.spool(Readable.from([]));
      expect({ sha256: spooled.sha256, size: spooled.size }).toEqual({
        sha256: sha256(''),
        size: 0,
      });
      await spooled.store();
      expect(await collect(await store.get(sha256('')))).toEqual(Buffer.alloc(0));
    });

    test('a discarded spool stores nothing and leaves nothing behind', async () => {
      const store = await make();
      const bytes = Buffer.from('never kept');
      const spooled = await store.spool(Readable.from([bytes]));
      await spooled.discard();
      expect(await store.has(sha256(bytes))).toBe(false);
      expect(await keys(store)).toEqual([]);
    });

    test('storing a spool of a blob that exists keeps the one copy', async () => {
      const store = await make();
      const bytes = Buffer.from('stored once');
      const key = sha256(bytes);
      await store.put(key, bytes, bytes.length);

      const spooled = await store.spool(Readable.from([bytes]));
      await spooled.store();
      expect(await keys(store)).toEqual([key]);
      expect(await collect(await store.get(key))).toEqual(bytes);
    });

    test('a spool whose body fails rejects with its error and stores nothing', async () => {
      const store = await make();
      const failure = new Error('the client went away');
      async function* failing(): AsyncGenerator<Buffer> {
        yield Buffer.from('part of it');
        throw failure;
      }
      await expect(store.spool(Readable.from(failing()))).rejects.toBe(failure);
      expect(await keys(store)).toEqual([]);
    });

    test('check passes on a usable store', async () => {
      const store = await make();
      await expect(store.check()).resolves.toBeUndefined();
    });

    test('streams a 20 MB blob without buffering it whole', async () => {
      const store = await make();
      const digest = createHash('sha256');
      for (const chunk of chunksOfTwentyMegabytes()) digest.update(chunk);
      const key = digest.digest('hex');

      await store.put(key, Readable.from(chunksOfTwentyMegabytes()), CHUNK_BYTES * CHUNKS);

      const readBack = createHash('sha256');
      let length = 0;
      for await (const chunk of await store.get(key)) {
        readBack.update(chunk);
        length += chunk.length;
      }
      expect(length).toBe(CHUNK_BYTES * CHUNKS);
      expect(readBack.digest('hex')).toBe(key);
    }, 60_000);
  });
}
