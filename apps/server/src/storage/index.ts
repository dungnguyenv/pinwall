import type { Config } from '../config/types.ts';
import type { BlobStore } from './blob-store.ts';
import { LocalBlobStore } from './local.ts';
import { S3BlobStore } from './s3.ts';

export type { BlobStore } from './blob-store.ts';
export { LocalBlobStore } from './local.ts';
export { S3BlobStore } from './s3.ts';

/**
 * The store selected by configuration. `tmpDir` is where an S3 store spools streamed uploads
 * while it verifies them (the local store keeps its own `tmp` inside its directory); it defaults
 * to the system temp directory.
 */
export function createBlobStore(cfg: Config['storage'], tmpDir?: string): BlobStore {
  return cfg.kind === 'local' ? new LocalBlobStore(cfg.dir) : new S3BlobStore(cfg, tmpDir);
}
