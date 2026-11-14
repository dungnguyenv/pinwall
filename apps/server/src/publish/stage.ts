import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { PRESCAN_BYTES } from '../content/html-charset.ts';
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
   * Stores `body`, counting it against the budget as it goes (`declaredSize` is what an archive
   * header claims, if anything). A stream is never held whole: it goes through the store's
   * temporary space (`BlobStore.spool`) while it is hashed, and only its first bytes are kept, to
   * label an HTML file with its charset. Rejects with the budget's 413 as soon as a limit is
   * crossed; a stream is then abandoned, destroyed, and nothing is stored.
   */
  async stage(
    path: string,
    body: Readable | Buffer,
    declaredSize: number | null,
  ): Promise<StagedFile> {
    this.assertActive();
    this.budget.startFile(path, declaredSize);
    if (Buffer.isBuffer(body)) {
      this.budget.onFileBytes(body.length);
      const sha256 = createHash('sha256').update(body).digest('hex');
      await this.keep(sha256, body.length, () => this.deps.blobs.put(sha256, body, body.length));
      return this.add({ path, sha256, size: body.length, contentType: contentTypeOf(path, body) });
    }

    const head: Buffer[] = [];
    const spooled = await this.deps.blobs.spool(
      Readable.from(this.counted(body, head), { objectMode: false }),
    );
    try {
      await this.keep(spooled.sha256, spooled.size, () => spooled.store());
    } finally {
      // Nothing left to free once stored; otherwise the bytes never get a name.
      await spooled.discard();
    }
    return this.add({
      path,
      sha256: spooled.sha256,
      size: spooled.size,
      contentType: contentTypeOf(path, Buffer.concat(head)),
    });
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

  /**
   * Pins blob `sha256` and records its row, then has `store` put its bytes in place, all under the
   * blob's lock. The row goes first, so stored bytes always have a row the sweep can find.
   */
  private async keep(sha256: string, size: number, store: () => Promise<void>): Promise<void> {
    await this.registry.withLock(sha256, async () => {
      // An abort that ran while this file was read must not miss its pin.
      this.assertActive();
      this.registry.pin(this.owner, sha256);
      await this.deps.db.db
        .insertInto('blobs')
        .values({ sha256, size, created_at: this.deps.clock.now() })
        .onConflict((conflict) => conflict.column('sha256').doNothing())
        .execute();
      await store();
    });
  }

  private add(file: StagedFile): StagedFile {
    this.files.push(file);
    return file;
  }

  /**
   * The bytes of `body`, each counted against the budget, with copies of its first
   * `PRESCAN_BYTES` put in `head`. Leaving early (a limit crossed, the store failing) destroys
   * `body`.
   */
  private async *counted(body: Readable, head: Buffer[]): AsyncGenerator<Buffer> {
    let kept = 0;
    for await (const chunk of body) {
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.budget.onFileBytes(bytes.length);
      if (kept < PRESCAN_BYTES) {
        const part = Buffer.from(bytes.subarray(0, PRESCAN_BYTES - kept));
        head.push(part);
        kept += part.length;
      }
      yield bytes;
    }
  }
}
