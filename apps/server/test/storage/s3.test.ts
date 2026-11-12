import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { expect, onTestFinished, test } from 'vitest';
import type { Config } from '../../src/config/types.ts';
import { createBlobStore } from '../../src/storage/index.ts';
import { S3BlobStore } from '../../src/storage/s3.ts';
import { runBlobStoreContract } from './contract.ts';

const endpoint = process.env.PINWALL_TEST_S3_ENDPOINT;
const bucket = process.env.PINWALL_TEST_S3_BUCKET ?? 'pinwall-test';
const accessKeyId = process.env.PINWALL_TEST_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.PINWALL_TEST_S3_SECRET_ACCESS_KEY;

/** A store on its own key prefix, emptied again when the test ends. */
async function freshStore(): Promise<{ store: S3BlobStore; cfg: Config['storage'] }> {
  const cfg: Config['storage'] = {
    kind: 's3',
    bucket,
    region: 'us-east-1',
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(accessKeyId === undefined ? {} : { accessKeyId }),
    ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
    forcePathStyle: true,
    prefix: `test-${randomBytes(6).toString('hex')}/`,
  };
  const store = createBlobStore(cfg);
  if (!(store instanceof S3BlobStore)) throw new Error('expected an S3 store');
  onTestFinished(async () => {
    for await (const key of store.list()) await store.delete(key);
  });
  return { store, cfg };
}

if (endpoint) {
  runBlobStoreContract('S3', async () => (await freshStore()).store);

  test('S3 keys are <prefix>blobs/<sha> and a rejected put leaves nothing in the bucket', async () => {
    const { store, cfg } = await freshStore();
    if (cfg.kind !== 's3') throw new Error('unreachable');
    const bytes = Buffer.from('layout');
    const key = createHash('sha256').update(bytes).digest('hex');

    await store.put(key, bytes, bytes.length);
    await expect(store.put('0'.repeat(64), bytes, bytes.length)).rejects.toMatchObject({
      code: 'bad_request',
    });

    const client = new S3Client({
      region: cfg.region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: accessKeyId ?? '', secretAccessKey: secretAccessKey ?? '' },
    });
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: cfg.prefix }),
    );
    expect(listed.Contents?.map((o) => o.Key)).toEqual([`${cfg.prefix}blobs/${key}`]);
    client.destroy();
  });

  test('check fails when the bucket does not exist', async () => {
    const { cfg } = await freshStore();
    if (cfg.kind !== 's3') throw new Error('unreachable');
    const store = createBlobStore({ ...cfg, bucket: `missing-${randomBytes(6).toString('hex')}` });

    await expect(store.check()).rejects.toThrow();
  });
} else {
  console.info(
    'PINWALL_TEST_S3_ENDPOINT is not set: S3 blob store tests skipped (pnpm test:integration).',
  );
  test.skip('S3 blob store contract needs PINWALL_TEST_S3_ENDPOINT', () => {});
}

test('removeStaleTemp removes only the spool folders an unfinished put left', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'pinwall-s3-spool-'));
  onTestFinished(() => rm(tmp, { recursive: true, force: true }));
  // Never reaches the bucket: the spool is on local disk.
  const store = createBlobStore(
    { kind: 's3', bucket, region: 'us-east-1', forcePathStyle: true, prefix: '' },
    tmp,
  );
  const cutoff = Date.now() - 3_600_000;
  const old = new Date(cutoff - 1000);
  const folder = async (name: string, file: Date) => {
    await mkdir(join(tmp, name));
    await writeFile(join(tmp, name, 'body'), 'partial');
    await utimes(join(tmp, name, 'body'), file, file);
    await utimes(join(tmp, name), old, old);
  };
  // A spool the process stopped in the middle of, last written before the cutoff.
  await folder('pinwall-blob-left', old);
  // One still being written.
  await folder('pinwall-blob-busy', new Date());
  // Not the store's: a backup's spool shares the folder.
  await folder('backup-running', old);

  expect(await store.removeStaleTemp(cutoff)).toBe(1);
  expect((await readdir(tmp)).sort()).toEqual(['backup-running', 'pinwall-blob-busy']);
});
