import { CreatePublishSessionRequest } from '@pinwall/shared';
import { z } from 'zod';
import { messageOf } from '../../api/publish.ts';
import { enforceRateLimit, RATE_RULES } from '../../auth/rate-limits.ts';
import type { VersionRow } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { scopeForUser } from '../../domain/spaces.ts';
import { filesAt, readText, versionFor } from '../../domain/version-files.ts';
import { checkTarget, type PublishTarget, versionConflict } from '../../domain/versions.ts';
import { t } from '../../lib/i18n.ts';
import { applyEdits, type EditOp, type FileEdit, parseEdits } from '../../publish/edits.ts';
import { ingestEdit } from '../../publish/ingest.ts';
import { toPublishResult } from '../../publish/sessions.ts';
import { DESCRIPTIONS, FIELDS } from '../descriptions.ts';
import { flatten, oneLine } from '../format.ts';
import { runTool } from '../results.ts';
import type { ToolModule } from '../server.ts';
import { WRITES } from './publish.ts';

/** `edit_artifact` takes this many operations at most, in one call. */
const EDITS_MAX = 100;

/** One operation: a flat object for every `op`, as some clients handle `oneOf` badly. */
const EditIn = z.object({
  op: z
    .enum(['replace', 'write', 'delete'])
    .describe(
      'replace: put new_string in place of old_string. write: create or overwrite a text file ' +
        'with content. delete: remove the file.',
    ),
  path: z.string().min(1).max(2048).describe('A file path as get_artifact lists it.'),
  old_string: z
    .string()
    .optional()
    .describe(
      'replace: the exact text to replace, as read_file shows it without the line numbers. It ' +
        'must occur once, unless replace_all is true.',
    ),
  new_string: z.string().optional().describe('replace: the text to put in its place.'),
  replace_all: z.boolean().optional().describe('replace: replace every occurrence. Default false.'),
  content: z.string().optional().describe('write: the whole text of the file.'),
});

const EditArtifactIn = z.object({
  artifact_id: z.string().min(1).max(100).describe(FIELDS.artifactId),
  expected_version_id: z
    .string()
    .min(1)
    .max(100)
    .describe(
      'The id of the current version, from list_artifacts, get_artifact or your last publish. ' +
        'The edit is refused when a newer version exists.',
    ),
  message: CreatePublishSessionRequest.shape.message.describe(
    'A short note on what this version changes; the history shows it.',
  ),
  edits: z
    .array(EditIn)
    .min(1)
    .max(EDITS_MAX)
    .describe(
      'The operations, applied in order: each one sees the text the earlier ones left. If one ' +
        'fails, nothing is changed.',
    ),
});

/**
 * The edit tool: a new version of an artifact made on the server from its current one, for an
 * agent without the source on disk. It publishes through the services every publish uses, so
 * permissions, the `publish` allowance, the quota, path and size checks and the optimistic
 * version check are the same as for `publish_inline`.
 */
export const editTools: ToolModule = (server, ctx) => {
  const { deps, auth } = ctx;
  const { config } = deps;
  const { user } = auth;

  server.registerTool(
    'edit_artifact',
    {
      ...DESCRIPTIONS.edit_artifact,
      inputSchema: EditArtifactIn,
      annotations: WRITES,
    },
    runTool(ctx, async (a: z.output<typeof EditArtifactIn>) => {
      await enforceRateLimit(ctx.c, RATE_RULES.publish, user.id);
      const ops = parseEdits(a.edits, config.limits.maxInlineBytes);
      const target: PublishTarget = {
        kind: 'new_version',
        artifactId: a.artifact_id,
        expectedVersionId: a.expected_version_id,
      };
      const scope = scopeForUser(deps, user);
      // A caller who may not publish here, or a stale version, is refused before any file is read.
      await checkTarget(deps, scope, target);
      const { version } = await versionFor(deps, scope, a.artifact_id);
      if (version.id !== a.expected_version_id) throw versionConflict(version);

      const base = await baseTexts(deps, version, ops);
      const { texts, summary } = applyEdits(
        ops,
        (path) => base.get(path) ?? null,
        version.entry_path,
        config.limits,
      );
      const changed = new Map<string, Buffer | null>();
      for (const [path, text] of texts) {
        changed.set(path, text === null ? null : Buffer.from(text, 'utf8'));
      }
      const outcome = await ingestEdit(
        deps,
        { artifactId: a.artifact_id, expectedVersionId: a.expected_version_id, changed },
        {
          actor: user,
          source: 'mcp',
          message: messageOf(a.message),
          serverEdits: summary.map((edit) => edit.path),
        },
      );

      const result = toPublishResult(config, outcome);
      return [
        t('mcp.edit.done', {
          review_url: result.review_url,
          number: result.version_number,
          version_id: result.version_id,
          artifact_id: result.artifact_id,
        }),
        ...summary.map(describeEdit),
        ...result.warnings.map((w) => t('mcp.publish.warning', { message: oneLine(w.message) })),
      ].join('\n');
    }),
  );
};

/**
 * What `applyEdits` reads from `version`, by path: the text of each file the operations first
 * touch with `replace` (`readText`: text files only, up to its size limit), and `''` for each
 * one they first delete, which needs to exist but is not read. A path they first write is not
 * looked up. Null: the version has no such file.
 */
async function baseTexts(
  deps: AppDeps,
  version: VersionRow,
  ops: readonly EditOp[],
): Promise<Map<string, string | null>> {
  const first = new Map<string, EditOp['op']>();
  for (const op of ops) if (!first.has(op.path)) first.set(op.path, op.op);
  const wanted = [...first].filter(([, op]) => op !== 'write').map(([path]) => path);
  const files = await filesAt(deps, version, wanted);
  const texts = new Map<string, string | null>();
  for (const path of wanted) {
    const row = files.get(path);
    if (row === undefined) texts.set(path, null);
    else texts.set(path, first.get(path) === 'replace' ? await readText(deps, row) : '');
  }
  return texts;
}

/** One line of the result for one path. */
function describeEdit(edit: FileEdit): string {
  // A path is the publisher's: one line, whatever it holds.
  const path = flatten(edit.path);
  switch (edit.result) {
    case 'deleted':
      return t('mcp.edit.deleted', { path });
    case 'written':
      return t('mcp.edit.written', { path });
    case 'replaced': {
      const [from, to] = edit.lines ?? [1, 1];
      return t('mcp.edit.replaced', { path, count: edit.count, from, to });
    }
  }
}
