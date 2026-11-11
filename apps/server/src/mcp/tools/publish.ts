import {
  CreatePublishSessionRequest,
  InlinePublishRequest,
  PublishTargetInput,
} from '@pinwall/shared';
import { z } from 'zod';
import { messageOf, toPublishTarget } from '../../api/publish.ts';
import { enforceRateLimit } from '../../auth/rate-limits.ts';
import type { PublishTarget } from '../../domain/versions.ts';
import { badRequest } from '../../lib/errors.ts';
import { t } from '../../lib/i18n.ts';
import { ingestInline } from '../../publish/ingest.ts';
import {
  createPublishSession,
  PUBLISH_SESSION_RATE,
  toPublishResult,
} from '../../publish/sessions.ts';
import { DESCRIPTIONS, FIELDS, fillDescription } from '../descriptions.ts';
import { formatBytes, oneLine } from '../format.ts';
import { runTool } from '../results.ts';
import { CreatePublishSessionOut, PublishInlineOut } from '../schemas.ts';
import type { ToolModule } from '../server.ts';

/** The fields of a new artifact, with the checks the REST publish applies to them. */
const NEW_ARTIFACT_FIELDS = PublishTargetInput.options[1].shape;

/** Where a publish goes, the same arguments in both publish tools. */
const TargetIn = z.object({
  artifact_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(`${FIELDS.artifactId} Set it, with expected_version_id, to publish a new version.`),
  expected_version_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'The id of the current version of the artifact, from get_artifact or your last publish. ' +
        'Needed with artifact_id; the publish is refused when a newer version exists.',
    ),
  project_id: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      `The project a new artifact goes in. ${FIELDS.projectId} Default: the default project.`,
    ),
  name: NEW_ARTIFACT_FIELDS.name.describe(
    'The name of a new artifact. Default: the title of the entry page.',
  ),
  tags: NEW_ARTIFACT_FIELDS.tags.describe('Tags for a new artifact, at most 20.'),
});
export type TargetArgs = z.output<typeof TargetIn>;

const messageField = CreatePublishSessionRequest.shape.message.describe(
  'A short note on what this version changes; the history shows it.',
);

const CreatePublishSessionIn = TargetIn.extend({
  message: messageField,
  directory: CreatePublishSessionRequest.shape.directory.describe(
    'The folder to publish, as the shell will see it (default ./site), so the command can be run as given.',
  ),
  file: CreatePublishSessionRequest.shape.file.describe(
    'The single file to publish, as the shell will see it (default ./index.html).',
  ),
});

const PublishInlineIn = TargetIn.extend({
  message: messageField,
  files: InlinePublishRequest.shape.files.describe(
    'The files to publish: a path relative to the site root and the text of the file. One of them is index.html or index.md.',
  ),
});

const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/**
 * The publish target the arguments name: a new version on top of `expected_version_id`, or a new
 * artifact. The two kinds of field never mix, and a version without the id it replaces is
 * refused, so an agent that forgets one cannot publish something it did not mean to.
 */
export function targetFromArgs(a: TargetArgs): PublishTarget {
  const { artifact_id, expected_version_id, project_id, name, tags } = a;
  const newArtifact = project_id !== undefined || name !== undefined || tags !== undefined;
  if (artifact_id === undefined) {
    // An expected version with nothing to replace would silently start a new artifact.
    if (expected_version_id !== undefined) throw badRequest(t('mcp.publish.mixedTarget'));
    return toPublishTarget({
      ...(project_id === undefined ? {} : { project_id }),
      ...(name === undefined ? {} : { name }),
      ...(tags === undefined ? {} : { tags }),
    });
  }
  if (newArtifact) throw badRequest(t('mcp.publish.mixedTarget'));
  if (expected_version_id === undefined) throw badRequest(t('mcp.publish.needExpected'));
  return toPublishTarget({ artifact_id, expected_version_id });
}

/**
 * The publish tools: a one-time upload URL with the shell command that uses it, and an inline
 * publish of text files for clients that cannot run commands. Both go through the services the
 * REST API uses, so permissions, the shared `PUBLISH_SESSION_RATE`, path and size checks and the
 * optimistic version check are the same as for an HTTP publish.
 */
export const publishTools: ToolModule = (server, ctx) => {
  const { deps, auth } = ctx;
  const { config } = deps;
  const { user } = auth;
  const ttlMs = config.ttl.uploadSessionMs;
  // A whole number of minutes, never more than the URL lives; `expires_in_seconds` is exact.
  const minutes = Math.max(1, Math.floor(ttlMs / 60_000));

  server.registerTool(
    'create_publish_session',
    {
      title: DESCRIPTIONS.create_publish_session.title,
      description: fillDescription(DESCRIPTIONS.create_publish_session.description, {
        minutes,
      }),
      inputSchema: CreatePublishSessionIn,
      outputSchema: CreatePublishSessionOut,
      annotations: WRITES,
    },
    runTool(ctx, async (a: z.output<typeof CreatePublishSessionIn>) => {
      await enforceRateLimit(ctx.c, PUBLISH_SESSION_RATE, user.id);
      const target = targetFromArgs(a);
      const session = await createPublishSession(deps, user, {
        target,
        message: messageOf(a.message),
        source: 'mcp',
        directory: a.directory,
        file: a.file,
      });
      const structured = {
        ...session,
        expires_in_seconds: Math.floor(ttlMs / 1000),
        target: {
          kind: target.kind,
          artifact_id: target.kind === 'new_version' ? target.artifactId : null,
        },
      };
      const text = t('mcp.publish.session', {
        minutes,
        url: session.upload_url,
        archive: session.commands.archive,
        single: session.commands.single_file,
      });
      return { text, structured };
    }),
  );

  server.registerTool(
    'publish_inline',
    {
      title: DESCRIPTIONS.publish_inline.title,
      description: fillDescription(DESCRIPTIONS.publish_inline.description, {
        max: formatBytes(config.limits.maxInlineBytes),
      }),
      inputSchema: PublishInlineIn,
      outputSchema: PublishInlineOut,
      annotations: WRITES,
    },
    runTool(ctx, async (a: z.output<typeof PublishInlineIn>) => {
      await enforceRateLimit(ctx.c, PUBLISH_SESSION_RATE, user.id);
      const target = targetFromArgs(a);
      const outcome = await ingestInline(deps, target, a.files, {
        actor: user,
        source: 'inline',
        message: messageOf(a.message),
      });
      const result = toPublishResult(config, outcome);
      const lines = [
        t('mcp.publish.done', {
          review_url: result.review_url,
          number: result.version_number,
          version_id: result.version_id,
          artifact_id: result.artifact_id,
        }),
        ...result.warnings.map((w) => t('mcp.publish.warning', { message: oneLine(w.message) })),
      ];
      return { text: lines.join('\n'), structured: result };
    }),
  );
};
