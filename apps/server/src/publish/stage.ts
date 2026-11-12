import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { contentTypeOf } from '../content/mime.ts';
import type { AppDeps } from '../deps.ts';
import { type BlobRegistry, blobRegistry, collectBlobs } from '../domain/blobs.ts';
import { newSecret } from '../lib/ids.ts';
import type { IngestBudget } from './limits.ts';

/** A file of the upload, its bytes stored as a blob. `path` is stored as given. */
export interface StagedFile {
  path: string;
  sha256: string;
  size: number;
  contentType: string;
}

/**
 * Stores the files of one upload as blobs and keeps them pinned until the upload ends: `release`
 * once the version row is committed (from then on the version's references keep the blobs), or
 * `abort` when the upload fails, which removes every blob it added that nothing else needs.
 */
export class BlobStager {
  /** The files staged so far, in order. */
  readonly files: StagedFile[] = [];
  /** Pins are taken in this name; unguessable, so no other upload can drop them. */
  private readonly owner = newSecret();
  private readonly registry: BlobRegistry;
  private ended = false;

  constructor(
    private readonly deps: AppDeps,
    private readonly budget: IngestBudget,
  ) {
    this.registry = blobRegistry(deps);
  }

  /**
   * Reads `body` whole, counting it against the budget (`declaredSize` is what an archive header
   * claims, if anything), and stores it. Rejects with the budget's 413 as soon as a limit is
   * crossed; a stream is then abandoned, destroyed, and nothing is stored.
   */
  async stage(
    path: string,
    body: Readable | Buffer,
    declaredSize: number | null,
  ): Promise<StagedFile> {
    this.assertActive();
    this.budget.startFile(path, declaredSize);
    const bytes = await this.read(body);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.registry.withLock(sha256, async () => {
      // An abort that ran while this file was read must not miss its pin.
      this.assertActive();
      this.registry.pin(this.owner, sha256);
      // The row goes first, so stored bytes always have a row the sweep can find.
      await this.deps.db.db
        .insertInto('blobs')
        .values({ sha256, size: bytes.length, created_at: this.deps.clock.now() })
        .onConflict((conflict) => conflict.column('sha256').doNothing())
        .execute();
      await this.deps.blobs.put(sha256, bytes, bytes.length);
    });
    const file: StagedFile = {
      path,
      sha256,
      size: bytes.length,
      contentType: contentTypeOf(path, bytes),
    };
    this.files.push(file);
    return file;
  }

  /**
   * Ends a failed upload: drops its pins, then collects what it pinned. Blobs a version
   * references or another upload pins stay; during a backup the rest are left to the sweep.
   */
  async abort(): Promise<void> {
    this.ended = true;
    await collectBlobs(this.deps, this.registry.unpinAll(this.owner));
  }

  /** Ends a committed upload: drops its pins, leaving the blobs to the versions that use them. */
  release(): void {
    this.ended = true;
    this.registry.unpinAll(this.owner);
  }

  private assertActive(): void {
    // A pin taken now would never be dropped.
    if (this.ended) throw new Error('BlobStager: the upload was already aborted or released');
  }

  private async read(body: Readable | Buffer): Promise<Buffer> {
    if (Buffer.isBuffer(body)) {
      this.budget.onFileBytes(body.length);
      return body;
    }
    const chunks: Buffer[] = [];
    // Leaving the loop early (a limit crossed) destroys the stream.
    for await (const chunk of body) {
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.budget.onFileBytes(bytes.length);
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
}
