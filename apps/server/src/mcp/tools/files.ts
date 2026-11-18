import { z } from 'zod';
import { enforceRateLimit, RATE_RULES } from '../../auth/rate-limits.ts';
import { scopeForUser } from '../../domain/spaces.ts';
import { fileOf, readText, versionFor } from '../../domain/version-files.ts';
import { badRequest } from '../../lib/errors.ts';
import { t } from '../../lib/i18n.ts';
import { DESCRIPTIONS, FIELDS } from '../descriptions.ts';
import { flatten } from '../format.ts';
import { runTool } from '../results.ts';
import type { ToolModule } from '../server.ts';
import { findLines, splitLines, windowLines } from '../text-window.ts';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** `read_file` shows at most this many lines in one call. */
const LINES_MAX = 2000;

const ReadFileIn = z.object({
  artifact_id: z.string().min(1).max(100).describe(FIELDS.artifactId),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'A version number, as get_artifact lists them (3 for v3). Default: the current version.',
    ),
  path: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe('A file path as get_artifact lists it. Default: the entry page.'),
  offset: z.number().int().min(1).default(1).describe('The first line to return, from 1.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LINES_MAX)
    .default(300)
    .describe(`Most lines to return, at most ${LINES_MAX}.`),
  find: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Text to look for, ignoring case. Returns each line that contains it with 3 lines around ' +
        'it (at most 30 matches) instead of a range; offset and limit are ignored.',
    ),
});

/**
 * The file tools: read the text of one file of an artifact version. They read through the same
 * services as `/api/v1`, so a caller sees what the API shows them; a viewer may read.
 */
export const fileTools: ToolModule = (server, ctx) => {
  const { deps, auth } = ctx;

  server.registerTool(
    'read_file',
    {
      ...DESCRIPTIONS.read_file,
      inputSchema: ReadFileIn,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof ReadFileIn>) => {
      await enforceRateLimit(ctx.c, RATE_RULES.mcpRead, auth.user.id);
      const { version } = await versionFor(
        deps,
        scopeForUser(deps, auth.user),
        a.artifact_id,
        a.version,
      );
      const file = await fileOf(deps, version, a.path);
      const lines = splitLines(await readText(deps, file));

      const header = t('mcp.read.header', {
        // A path is the publisher's: one line, whatever it holds.
        path: flatten(file.path),
        number: version.number,
        version_id: version.id,
        total: lines.length,
      });
      return [header, t('mcp.read.notice'), ...bodyOf(a, lines)].join('\n');
    }),
  );
};

/** What follows the notice: the matches of `find`, or a window of lines and where to go on. */
function bodyOf(a: z.output<typeof ReadFileIn>, lines: string[]): string[] {
  if (a.find !== undefined) {
    const found = findLines(lines, a.find);
    if (found.matches === 0) return [t('mcp.read.noMatch')];
    return [
      found.body,
      t(found.truncated ? 'mcp.read.matchesMore' : 'mcp.read.matches', { count: found.matches }),
    ];
  }
  if (lines.length === 0) return [t('mcp.read.empty')];
  if (a.offset > lines.length) {
    throw badRequest(t('mcp.read.pastEnd', { total: lines.length, offset: a.offset }), {
      field: 'offset',
    });
  }
  const { body, next } = windowLines(lines, a.offset, a.limit);
  return [body, ...(next === null ? [] : [t('mcp.read.more', { next })])];
}
