import { createHash } from 'node:crypto';
import { type Readable, Transform, type TransformCallback } from 'node:stream';
import { badRequest } from '../lib/errors.ts';

/**
 * Content-addressed storage for file bytes. A blob's key is the lowercase hex SHA-256 of its
 * content, so the same bytes are stored once however many versions reference them.
 */
export interface BlobStore {
  /**
   * Stores `body` under `sha256`. Idempotent: when the blob already exists the call is a no-op
   * and `body` is discarded. Otherwise exactly `size` bytes hashing to `sha256` must arrive;
   * anything else rejects with `bad_request` and nothing is stored.
   */
  put(sha256: string, body: Buffer | Readable, size: number): Promise<void>;
  /**
   * Writes `body` to the store's temporary space, hashing and counting it as it goes, without
   * storing it yet: the result names its SHA-256 and size, so a caller can record the blob before
   * its bytes get that name. `store()` then keeps them under the SHA-256 (nothing when the blob
   * exists already) and `discard()` drops them; the caller must call one of them, and `discard`
   * after `store` does nothing. Only the stream's own buffers are held in memory. When `body`
   * fails, the call rejects with its error and leaves nothing behind.
   */
  spool(body: Readable): Promise<SpooledBlob>;
  /**
   * Streams the blob, or the bytes `start` to `end` inclusive. Rejects with `not_found` when the
   * blob is absent and `bad_request` when the range is inverted or starts past the end. The
   * caller must read the stream to its end or destroy it.
   */
  get(sha256: string, range?: { start: number; end: number }): Promise<Readable>;
  has(sha256: string): Promise<boolean>;
  /** Removes the blob; no error when it is absent. */
  delete(sha256: string): Promise<void>;
  /** Every stored key, in no particular order. */
  list(): AsyncIterable<string>;
  /** Readiness probe: resolves when the store is usable and throws when it is not. */
  check(): Promise<void>;
  /**
   * Removes what a `put` that never finished (its process stopped in the middle) left in the
   * store's temporary space: whatever nothing has written to since `before`, in ms since the
   * epoch. A put in progress keeps writing to its file, so it is left alone. Returns how many
   * leftovers it removed.
   */
  removeStaleTemp(before: number): Promise<number>;
}

/** A body `BlobStore.spool` wrote to temporary space: hashed, counted, not stored yet. */
export interface SpooledBlob {
  readonly sha256: string;
  readonly size: number;
  /** Stores the bytes under `sha256`, unless the blob exists already, and frees the space. */
  store(): Promise<void>;
  /** Frees the space without storing anything. */
  discard(): Promise<void>;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

/** Keys become file names and object keys, so a malformed one must never get that far. */
export function assertSha256(value: string): void {
  if (!isSha256(value)) throw badRequest('A blob key is 64 lowercase hex characters (a SHA-256).');
}

export function assertSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw badRequest('A blob size is a non-negative integer number of bytes.');
  }
}

export function assertRange(range: { start: number; end: number }): void {
  const { start, end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw badRequest('A byte range needs 0 <= start <= end.', { start, end });
  }
}

/**
 * Passes bytes through while hashing and counting them, so a stream is verified as it is
 * written. It fails as soon as more than `size` bytes arrive, instead of letting an endless
 * body fill the disk before the check.
 */
export class BlobDigest extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;

  constructor(private readonly size: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.size) {
      done(badRequest('Blob is larger than its declared size.', { declared_size: this.size }));
      return;
    }
    this.hash.update(chunk);
    done(null, chunk);
  }

  /** Call once the stream has ended: throws unless the bytes seen are exactly `size` and hash to `sha256`. */
  assertMatches(sha256: string): void {
    if (this.bytes !== this.size) {
      throw badRequest('Blob is smaller than its declared size.', {
        declared_size: this.size,
        received_size: this.bytes,
      });
    }
    if (this.hash.digest('hex') !== sha256) {
      throw badRequest('Blob content does not match its sha256.', { sha256 });
    }
  }
}

/** Passes bytes through while hashing and counting them, for a body whose hash is not known yet. */
export class BlobHash extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    done(null, chunk);
  }

  /** Call once, after the stream has ended: the SHA-256 and the size of what passed. */
  result(): { sha256: string; size: number } {
    return { sha256: this.hash.digest('hex'), size: this.bytes };
  }
}

/** The same check for a body already in memory. */
export function assertBufferMatches(sha256: string, size: number, body: Buffer): void {
  if (body.length !== size) {
    throw badRequest('Blob size does not match its declared size.', {
      declared_size: size,
      received_size: body.length,
    });
  }
  if (createHash('sha256').update(body).digest('hex') !== sha256) {
    throw badRequest('Blob content does not match its sha256.', { sha256 });
  }
}

/** Releases a body the store decided not to read. */
export function discard(body: Buffer | Readable): void {
  if (!Buffer.isBuffer(body)) body.destroy();
}
