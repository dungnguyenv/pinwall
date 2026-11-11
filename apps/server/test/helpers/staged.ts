import type { VersionMetadata } from '../../src/content/metadata.ts';
import { IngestBudget } from '../../src/publish/limits.ts';
import { BlobStager, type StagedFile } from '../../src/publish/stage.ts';
import type { TestContext } from './context.ts';

/**
 * Stores `files` as blobs, as an upload would before its commit, and returns them in the given
 * order. The pins are dropped at once, so nothing but a version keeps the blobs afterwards.
 */
export async function stageFiles(
  ctx: TestContext,
  files: Record<string, string | Buffer>,
): Promise<StagedFile[]> {
  const stager = new BlobStager(ctx.deps, new IngestBudget(ctx.deps.config.limits));
  const staged: StagedFile[] = [];
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    staged.push(await stager.stage(path, bytes, bytes.length));
  }
  stager.release();
  return staged;
}

/** Metadata of a version that shows nothing: no title, color, thumbnail, text or warnings. */
export function emptyMeta(over: Partial<VersionMetadata> = {}): VersionMetadata {
  return { title: null, themeColor: null, thumbnailPath: null, text: '', warnings: [], ...over };
}
