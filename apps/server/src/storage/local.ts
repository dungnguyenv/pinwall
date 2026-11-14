import { randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { badRequest, notFound } from '../lib/errors.ts';
import {
  assertRange,
  assertSha256,
  assertSize,
  BlobDigest,
  BlobHash,
  type BlobStore,
  discard,
  isSha256,
  type SpooledBlob,
} from './blob-store.ts';

const SHARD = /^[0-9a-f]{2}$/;

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Blobs as files under `<dir>/<sha[0:2]>/<sha[2:4]>/<sha>`; uploads pass through `<dir>/tmp`. */
export class LocalBlobStore implements BlobStore {
  private readonly tmpDir: string;

  constructor(private readonly dir: string) {
    this.tmpDir = join(dir, 'tmp');
  }

  private pathOf(sha256: string): string {
    return join(this.dir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  async put(sha256: string, body: Buffer | Readable, size: number): Promise<void> {
    assertSha256(sha256);
    assertSize(size);
    if (await this.has(sha256)) {
      discard(body);
      return;
    }

    // Write beside the final location's file system, verify, then rename: readers never see a
    // partial blob and a wrong hash never gets a name.
    await mkdir(this.tmpDir, { recursive: true });
    const tmp = join(this.tmpDir, randomBytes(16).toString('hex'));
    try {
      const digest = new BlobDigest(size);
      const source = Buffer.isBuffer(body) ? Readable.from([body], { objectMode: false }) : body;
      // `flush` fsyncs the file before it closes, so a crash cannot leave a renamed empty file.
      await pipeline(source, digest, createWriteStream(tmp, { flags: 'wx', flush: true }));
      digest.assertMatches(sha256);
      const target = this.pathOf(sha256);
      await mkdir(dirname(target), { recursive: true });
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async spool(body: Readable): Promise<SpooledBlob> {
    await mkdir(this.tmpDir, { recursive: true });
    const tmp = join(this.tmpDir, randomBytes(16).toString('hex'));
    const hashing = new BlobHash();
    try {
      await pipeline(body, hashing, createWriteStream(tmp, { flags: 'wx', flush: true }));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    const { sha256, size } = hashing.result();
    const discard = () => rm(tmp, { force: true });
    return {
      sha256,
      size,
      // Renamed on the same file system, as `put` does: the bytes are written once.
      store: async () => {
        try {
          if (await this.has(sha256)) return;
          const target = this.pathOf(sha256);
          await mkdir(dirname(target), { recursive: true });
          await rename(tmp, target);
        } finally {
          await discard();
        }
      },
      discard,
    };
  }

  async get(sha256: string, range?: { start: number; end: number }): Promise<Readable> {
    assertSha256(sha256);
    if (range) assertRange(range);
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(this.pathOf(sha256), 'r');
    } catch (error) {
      if (isMissing(error)) throw notFound('Blob not found.', { sha256 });
      throw error;
    }
    try {
      if (range && range.start >= (await file.stat()).size) {
        throw badRequest('Range starts past the end of the blob.', { ...range });
      }
      // `end` is inclusive for Node's read streams too; the stream closes the handle when done.
      return file.createReadStream(range ? { start: range.start, end: range.end } : {});
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async has(sha256: string): Promise<boolean> {
    assertSha256(sha256);
    try {
      return (await stat(this.pathOf(sha256))).isFile();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async delete(sha256: string): Promise<void> {
    assertSha256(sha256);
    try {
      await unlink(this.pathOf(sha256));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async *list(): AsyncIterable<string> {
    for (const first of await this.names(this.dir, (name) => SHARD.test(name))) {
      const firstDir = join(this.dir, first);
      for (const second of await this.names(firstDir, (name) => SHARD.test(name))) {
        const prefix = first + second;
        const found = await this.names(
          join(firstDir, second),
          (name) => isSha256(name) && name.startsWith(prefix),
        );
        yield* found;
      }
    }
  }

  async check(): Promise<void> {
    await mkdir(this.tmpDir, { recursive: true });
    await access(this.tmpDir, constants.R_OK | constants.W_OK);
  }

  async removeStaleTemp(before: number): Promise<number> {
    let removed = 0;
    for (const name of await this.names(this.tmpDir, () => true)) {
      const path = join(this.tmpDir, name);
      try {
        if ((await lstat(path)).mtimeMs >= before) continue;
      } catch (error) {
        // Renamed into place, or removed, since the listing.
        if (isMissing(error)) continue;
        throw error;
      }
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  /** Entries of `dir` that pass `keep`; none when the directory does not exist (yet). */
  private async names(dir: string, keep: (name: string) => boolean): Promise<string[]> {
    try {
      return (await readdir(dir)).filter(keep);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
}
