import type { UserRow } from '../../src/db/schema.ts';
import type { PublishTarget } from '../../src/domain/versions.ts';
import { ingestFiles, type PublishOutcome } from '../../src/publish/ingest.ts';
import type { TestContext } from './context.ts';

/**
 * Publishes `files` (path → content) as `actor` through `ingestFiles`, source `api`, no message:
 * by default as a new artifact in the default project, with no name or tags.
 */
export function publishFiles(
  ctx: TestContext,
  actor: UserRow,
  files: Record<string, string | Buffer>,
  target: PublishTarget = { kind: 'new_artifact', projectId: null, name: null, tags: [] },
): Promise<PublishOutcome> {
  const set = Object.entries(files).map(([path, content]) => ({
    path,
    data: Buffer.isBuffer(content) ? content : Buffer.from(content),
  }));
  return ingestFiles(ctx.deps, target, set, { actor, source: 'api', message: null });
}
