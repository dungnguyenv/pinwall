import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type { Config } from '../config/types.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import {
  assertBufferMatches,
  assertRange,
  assertSha256,
  assertSize,
  BlobDigest,
  type BlobStore,
  discard,
  isSha256,
} from './blob-store.ts';

export type S3StorageConfig = Extract<Config['storage'], { kind: 's3' }>;

function errorName(error: unknown): string | undefined {
  return (error as { name?: string } | undefined)?.name;
}

/** Blobs as objects at `<prefix>blobs/<sha256>` in one bucket. */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;

  /** `tmpDir` holds streamed uploads while they are verified; it is created when needed. */
  constructor(
    cfg: S3StorageConfig,
    private readonly tmpDir: string = tmpdir(),
  ) {
    const clientConfig: S3ClientConfig = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      // Many S3-compatible servers reject the checksum headers newer SDKs add by default.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    if (cfg.endpoint !== undefined) clientConfig.endpoint = cfg.endpoint;
    if (cfg.accessKeyId !== undefined && cfg.secretAccessKey !== undefined) {
      clientConfig.credentials = {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      };
    }
    this.client = new S3Client(clientConfig);
    this.bucket = cfg.bucket;
    this.keyPrefix = `${cfg.prefix}blobs/`;
  }

  private keyOf(sha256: string): string {
    return this.keyPrefix + sha256;
  }

  async put(sha256: string, body: Buffer | Readable, size: number): Promise<void> {
    assertSha256(sha256);
    assertSize(size);
    if (await this.has(sha256)) {
      discard(body);
      return;
    }

    if (Buffer.isBuffer(body)) {
      assertBufferMatches(sha256, size, body);
      await this.upload(sha256, body, size);
      return;
    }

    // A stream is spooled to disk and verified first, so a wrong hash never reaches the bucket
    // and the upload can state its exact length.
    await mkdir(this.tmpDir, { recursive: true });
    const dir = await mkdtemp(join(this.tmpDir, 'pinwall-blob-'));
    try {
      const file = join(dir, randomBytes(8).toString('hex'));
      const digest = new BlobDigest(size);
      await pipeline(body, digest, createWriteStream(file));
      digest.assertMatches(sha256);
      const spooled = createReadStream(file);
      try {
        await this.upload(sha256, spooled, size);
      } finally {
        spooled.destroy();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async upload(sha256: string, body: Buffer | Readable, size: number): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.keyOf(sha256),
        Body: body,
        ContentLength: size,
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async get(sha256: string, range?: { start: number; end: number }): Promise<Readable> {
    assertSha256(sha256);
    if (range) assertRange(range);
    let body: unknown;
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.keyOf(sha256),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      body = out.Body;
    } catch (error) {
      if (errorName(error) === 'NoSuchKey') throw notFound('Blob not found.', { sha256 });
      if (errorName(error) === 'InvalidRange') {
        throw badRequest('Range starts past the end of the blob.', { ...range });
      }
      throw error;
    }
    if (!(body instanceof Readable)) throw new Error('The S3 response has no readable body.');
    return body;
  }

  async has(sha256: string): Promise<boolean> {
    assertSha256(sha256);
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyOf(sha256) }),
      );
      return true;
    } catch (error) {
      // A HEAD response has no body, so S3 reports a missing key as `NotFound`.
      if (errorName(error) === 'NotFound' || errorName(error) === 'NoSuchKey') return false;
      throw error;
    }
  }

  async delete(sha256: string): Promise<void> {
    assertSha256(sha256);
    // S3 answers success whether or not the key existed.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyOf(sha256) }),
    );
  }

  async *list(): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.keyPrefix,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );
      for (const object of page.Contents ?? []) {
        const sha256 = object.Key?.slice(this.keyPrefix.length);
        if (sha256 !== undefined && isSha256(sha256)) yield sha256;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async check(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}
