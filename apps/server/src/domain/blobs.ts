import type { AppDeps } from '../deps.ts';

/**
 * Held by a backup (M9) while it copies the database and then the blobs. Garbage collection
 * deletes nothing meanwhile: a blob the copied database still references may already be
 * unreferenced in the live one.
 */
export const BACKUP_LEASE = 'maintenance:backup';

/**
 * What keeps blobs safe from garbage collection between staging and commit. Staging and
 * collection of one sha run under its lock, so neither sees the other half done; an upload pins
 * every sha it stages until its version is committed (or it gives up), and collection skips a
 * pinned sha even when no version references it yet.
 *
 * In-process for v1's single instance; a multi-instance build swaps in a shared implementation.
 */
export interface BlobRegistry {
  /** Runs `fn` once no other `withLock` call for `sha256` is running; callers queue in order. */
  withLock<T>(sha256: string, fn: () => Promise<T>): Promise<T>;
  /** Pins `sha256` for `owner`; pinning it again changes nothing. */
  pin(owner: string, sha256: string): void;
  /** Drops every pin `owner` holds; returns the shas it had pinned. */
  unpinAll(owner: string): string[];
  /** Whether any owner pins `sha256`. */
  isPinned(sha256: string): boolean;
}

export class InProcessBlobRegistry implements BlobRegistry {
  /** Per sha, a promise that settles when the last queued `withLock` call is done. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pinsByOwner = new Map<string, Set<string>>();
  /** How many owners pin each sha; a sha is absent once nobody does. */
  private readonly owners = new Map<string, number>();

  async withLock<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sha256) ?? Promise.resolve();
    let unlock = () => {};
    const done = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => done);
    this.queues.set(sha256, tail);
    await previous;
    try {
      return await fn();
    } finally {
      unlock();
      if (this.queues.get(sha256) === tail) this.queues.delete(sha256);
    }
  }

  pin(owner: string, sha256: string): void {
    let pinned = this.pinsByOwner.get(owner);
    if (pinned === undefined) {
      pinned = new Set();
      this.pinsByOwner.set(owner, pinned);
    }
    if (pinned.has(sha256)) return;
    pinned.add(sha256);
    this.owners.set(sha256, (this.owners.get(sha256) ?? 0) + 1);
  }

  unpinAll(owner: string): string[] {
    const pinned = this.pinsByOwner.get(owner);
    if (pinned === undefined) return [];
    this.pinsByOwner.delete(owner);
    for (const sha256 of pinned) {
      const left = (this.owners.get(sha256) ?? 1) - 1;
      if (left > 0) this.owners.set(sha256, left);
      else this.owners.delete(sha256);
    }
    return [...pinned];
  }

  isPinned(sha256: string): boolean {
    return this.owners.has(sha256);
  }
}

const registries = new WeakMap<AppDeps, BlobRegistry>();

/** The registry of `deps`, created on first use: one per `AppDeps`, so one per process. */
export function blobRegistry(deps: AppDeps): BlobRegistry {
  let registry = registries.get(deps);
  if (registry === undefined) {
    registry = new InProcessBlobRegistry();
    registries.set(deps, registry);
  }
  return registry;
}

type Outcome = 'kept' | 'deferred' | 'deleted';

/**
 * Deletes each of `sha256s` that no version references and no upload pins, bytes and `blobs`
 * row. While a backup holds `BACKUP_LEASE` such blobs are deferred instead: their rows stay, so
 * `sweepBlobs` finds them later. Referenced and pinned blobs are in neither list. Rejects with
 * the first storage or database failure; the rows of blobs not yet deleted stay for the sweep.
 *
 * Call it outside any transaction (on SQLite the transaction would hold the only connection),
 * and after the deletion that unreferenced the blobs has committed.
 */
export async function collectBlobs(
  deps: AppDeps,
  sha256s: Iterable<string>,
): Promise<{ deleted: string[]; deferred: string[] }> {
  const registry = blobRegistry(deps);
  const deleted: string[] = [];
  const deferred: string[] = [];
  for (const sha256 of new Set(sha256s)) {
    const outcome = await registry.withLock(sha256, () => collectOne(deps, registry, sha256));
    if (outcome === 'deleted') deleted.push(sha256);
    else if (outcome === 'deferred') deferred.push(sha256);
  }
  return { deleted, deferred };
}

/** One sha, under its lock. */
async function collectOne(deps: AppDeps, registry: BlobRegistry, sha256: string): Promise<Outcome> {
  if (registry.isPinned(sha256) || (await isReferenced(deps, sha256))) return 'kept';
  // Asked only now, after the reference check: a backup that starts later copies a database in
  // which nothing references this blob.
  if (await deps.leases.isHeld(BACKUP_LEASE)) return 'deferred';
  // The bytes go first. If deleting them fails, or the process stops before the row goes, the
  // row is still there for the next sweep; the other order would leave bytes nothing points to.
  await deps.blobs.delete(sha256);
  await deps.db.db.deleteFrom('blobs').where('sha256', '=', sha256).execute();
  return 'deleted';
}

async function isReferenced(deps: AppDeps, sha256: string): Promise<boolean> {
  const row = await deps.db.db
    .selectFrom('version_files')
    .select('sha256')
    .where('sha256', '=', sha256)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Collects up to `batch` blobs whose rows no version references, oldest first: what an aborted
 * upload deferred during a backup, or what a crash left behind. Returns how many it deleted; 0
 * while a backup holds `BACKUP_LEASE`. Blobs pinned by uploads in progress are left alone.
 */
export async function sweepBlobs(deps: AppDeps, batch = 500): Promise<number> {
  if (!Number.isSafeInteger(batch) || batch < 1) {
    throw new RangeError(`sweep batch must be a positive integer, got ${batch}`);
  }
  if (await deps.leases.isHeld(BACKUP_LEASE)) return 0;
  // `not exists` is answered by version_files_sha256_idx.
  const rows = await deps.db.db
    .selectFrom('blobs')
    .select('sha256')
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('version_files')
            .select('version_files.sha256')
            .whereRef('version_files.sha256', '=', 'blobs.sha256'),
        ),
      ),
    )
    .orderBy('created_at')
    .orderBy('sha256')
    .limit(batch)
    .execute();
  const { deleted } = await collectBlobs(
    deps,
    rows.map((row) => row.sha256),
  );
  return deleted.length;
}
