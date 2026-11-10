import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, onTestFinished, test } from 'vitest';
import { createBlobStore } from '../../src/storage/index.ts';
import { LocalBlobStore } from '../../src/storage/local.ts';
import { runBlobStoreContract } from './contract.ts';

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pinwall-blobs-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

runBlobStoreContract('local', async () => createBlobStore({ kind: 'local', dir: await tempDir() }));

test('createBlobStore builds the local store from config', async () => {
  const store = createBlobStore({ kind: 'local', dir: await tempDir() });
  expect(store).toBeInstanceOf(LocalBlobStore);
});

test('keeps blobs at <dir>/<sha[0:2]>/<sha[2:4]>/<sha>', async () => {
  const dir = await tempDir();
  const store = createBlobStore({ kind: 'local', dir });
  const bytes = Buffer.from('layout');
  const key = sha256(bytes);

  await store.put(key, bytes, bytes.length);

  const info = await stat(join(dir, key.slice(0, 2), key.slice(2, 4), key));
  expect(info.size).toBe(bytes.length);
});

test('leaves nothing in tmp after a rejected or failed put', async () => {
  const dir = await tempDir();
  const store = createBlobStore({ kind: 'local', dir });
  const bytes = Buffer.from('payload');

  await expect(store.put(sha256('other'), bytes, bytes.length)).rejects.toMatchObject({
    code: 'bad_request',
  });
  await expect(store.put(sha256(bytes), Readable.from([bytes]), 1)).rejects.toMatchObject({
    code: 'bad_request',
  });
  const broken = new Readable({
    read() {
      this.destroy(new Error('source failed'));
    },
  });
  await expect(store.put(sha256(bytes), broken, bytes.length)).rejects.toThrow('source failed');

  expect(await readdir(join(dir, 'tmp'))).toEqual([]);
});

test('stops reading a stream that runs past its declared size', async () => {
  const dir = await tempDir();
  const store = createBlobStore({ kind: 'local', dir });
  let produced = 0;
  const endless = new Readable({
    read() {
      produced += 1;
      this.push(Buffer.alloc(64 * 1024));
    },
  });

  await expect(store.put(sha256('x'), endless, 100)).rejects.toMatchObject({
    code: 'bad_request',
  });
  expect(produced).toBeLessThan(50);
});

test('a put of an existing blob does not rewrite the file', async () => {
  const dir = await tempDir();
  const store = createBlobStore({ kind: 'local', dir });
  const bytes = Buffer.from('write once');
  const key = sha256(bytes);
  await store.put(key, bytes, bytes.length);
  const path = join(dir, key.slice(0, 2), key.slice(2, 4), key);
  const before = await stat(path, { bigint: true });

  await store.put(key, bytes, bytes.length);

  const after = await stat(path, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeNs).toBe(before.mtimeNs);
});

test('list ignores tmp and stray files', async () => {
  const dir = await tempDir();
  const store = createBlobStore({ kind: 'local', dir });
  const bytes = Buffer.from('listed');
  const key = sha256(bytes);
  await store.put(key, bytes, bytes.length);
  await writeFile(join(dir, 'tmp', 'half-written'), 'x');
  await writeFile(join(dir, 'notes.txt'), 'x');
  await mkdir(join(dir, key.slice(0, 2), 'not-a-shard'), { recursive: true });

  const found: string[] = [];
  for await (const entry of store.list()) found.push(entry);
  expect(found).toEqual([key]);
});

test('list of a store that has never been written is empty', async () => {
  const store = createBlobStore({ kind: 'local', dir: join(await tempDir(), 'missing') });
  const found: string[] = [];
  for await (const entry of store.list()) found.push(entry);
  expect(found).toEqual([]);
});

test('check fails when the directory cannot be used', async () => {
  const dir = await tempDir();
  const file = join(dir, 'a-file');
  await writeFile(file, 'x');

  await expect(createBlobStore({ kind: 'local', dir: file }).check()).rejects.toThrow();
});
