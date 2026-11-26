import type { ArtifactSummary } from '@pinwall/shared';
import { z } from 'zod';
import { toArtifactSummary } from '../../api/artifacts.ts';
import { type SpaceFields, spaceFieldsOf } from '../../api/projects.ts';
import { enforceRateLimit, RATE_RULES } from '../../auth/rate-limits.ts';
import type { ArtifactRow, ProjectRow, VersionRow } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { getArtifact, listArtifacts, SEARCH_MAX_CHARS } from '../../domain/artifacts.ts';
import {
  createProject,
  DEFAULT_PROJECT_ID,
  ensureDefaultProject,
  getProject,
  listProjects,
} from '../../domain/projects.ts';
import { serverEditsOf } from '../../domain/server-edits.ts';
import { defaultProjectFor, type Scope, scopeForUser, seesAll } from '../../domain/spaces.ts';
import {
  getCurrentVersion,
  getVersionsById,
  listVersionFiles,
  listVersions,
} from '../../domain/versions.ts';
import { badRequest } from '../../lib/errors.ts';
import { t } from '../../lib/i18n.ts';
import { DESCRIPTIONS, FIELDS } from '../descriptions.ts';
import { flatten, formatBytes, withMore } from '../format.ts';
import { authoringNotes } from '../notes.ts';
import { runTool } from '../results.ts';
import type { ToolModule } from '../server.ts';
import type { ArtifactOut, ProjectOut, VersionOut } from '../types.ts';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** With `query`, a list is one page of the best matches, and at most this long. */
export const QUERY_MAX_LIMIT = 50;
/** `get_artifact` lists at most this many files of the current version. */
const FILE_LIST_MAX = 50;
/** A version's message is shown cut to this many characters. */
const MESSAGE_MAX_CHARS = 120;
/** A version line names this many of the paths edited on the server, then how many more. */
const EDITED_PATHS_MAX = 5;

const cursorField = z.string().min(1).max(1000).optional().describe(FIELDS.cursor);
const projectIdField = z.string().min(1).max(100).optional().describe(FIELDS.projectId);

const ListProjectsIn = z.object({
  archived: z.boolean().default(false).describe('true lists the archived projects instead.'),
  limit: z.number().int().min(1).max(100).default(50).describe('Most projects to return.'),
  cursor: cursorField,
});

const GetProjectIn = z.object({
  project_id: projectIdField.describe(`${FIELDS.projectId} Leave out for the default project.`),
});

const CreateProjectIn = z.object({
  name: z.string().trim().min(1).max(100).describe('A short name for the project.'),
  instructions: z
    .string()
    .max(20_000)
    .optional()
    .describe('What agents must know before they publish here: language, style, structure.'),
});

const ListArtifactsIn = z.object({
  project_id: projectIdField.describe(`Only artifacts of this project. ${FIELDS.projectId}`),
  tag: z.string().min(1).max(200).optional().describe('Only artifacts with this tag.'),
  query: z
    .string()
    .trim()
    .min(1)
    .max(SEARCH_MAX_CHARS)
    .optional()
    .describe(
      'Words to look for, such as part of a name, a tag or the text of the page. Lists the best ' +
        `matches first, in one list: limit is at most ${QUERY_MAX_LIMIT}, and cursor is not allowed.`,
    ),
  limit: z.number().int().min(1).max(100).default(20).describe('Most artifacts to return.'),
  cursor: cursorField,
});

const GetArtifactIn = z.object({
  artifact_id: z.string().min(1).max(100).describe(FIELDS.artifactId),
  versions_limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(3)
    .describe('How many of the newest versions to list.'),
});

/**
 * `space`: the owner, role and whether everyone sees it, as a personal-mode viewer sees them
 * (`spaceFieldsOf`); none in team mode.
 */
function toProjectOut(row: ProjectRow, space?: SpaceFields): ProjectOut {
  return {
    id: row.id,
    name: row.name,
    is_default: row.is_default === 1,
    archived: row.archived_at !== null,
    // Instructions of nothing but blank space tell an agent nothing.
    has_instructions: row.instructions.trim() !== '',
    ...(space === undefined
      ? {}
      : {
          owner: space.owner,
          ...(space.role === undefined ? {} : { role: space.role }),
          ...(space.everyone_can_view === undefined
            ? {}
            : { everyone_can_view: space.everyone_can_view }),
        }),
  };
}

function toArtifactOut(summary: ArtifactSummary): ArtifactOut {
  const { current_version: current } = summary;
  return {
    id: summary.id,
    name: summary.name,
    kind: summary.kind,
    tags: summary.tags,
    current_version: current === null ? null : { id: current.id, number: current.number },
    open_thread_count: summary.open_thread_count,
    review_url: summary.links.review,
  };
}

function toVersionOut(row: VersionRow, currentVersionId: string | null): VersionOut {
  return {
    id: row.id,
    number: row.number,
    file_count: row.file_count,
    total_bytes: row.total_bytes,
    source: row.source,
    message: row.message,
    created_at: row.created_at,
    is_current: row.id === currentVersionId,
    server_edits: serverEditsOf(row.meta),
  };
}

/**
 * Artifacts with their tags, versions and thread counts loaded together, as the API lists them,
 * and which of them have a current version made with `edit_artifact` (read in one query).
 */
async function artifactsOf(
  deps: AppDeps,
  scope: Scope,
  rows: Parameters<typeof toArtifactSummary>[2],
): Promise<ArtifactOut[]> {
  const artifacts = (await toArtifactSummary(deps, scope, rows)).map(toArtifactOut);
  const current = await getVersionsById(
    deps.db.db,
    artifacts.flatMap((a) => a.current_version?.id ?? []),
  );
  return artifacts.map((a) => {
    const row = a.current_version === null ? undefined : current.get(a.current_version.id);
    return row !== undefined && serverEditsOf(row.meta).length > 0
      ? { ...a, edited_on_server: true }
      : a;
  });
}

/**
 * The project `id`, or the caller's default one (made when missing) when no id is given; 404 for
 * one `scope` does not see.
 */
async function readProject(
  deps: AppDeps,
  scope: Scope,
  id: string | undefined,
): Promise<ProjectRow> {
  if (id === undefined) return defaultProjectFor(deps, scope);
  // The shared default is everyone's only where everyone sees it.
  if (id === DEFAULT_PROJECT_ID && seesAll(scope)) await ensureDefaultProject(deps);
  return getProject(deps.db.db, scope, id);
}

/**
 * What a project says about the caller's place in it: their role, its owner, and whether everyone
 * who signs in sees it; nothing in team mode.
 */
function spaceDetails({ role, owner, everyone_can_view: everyone }: ProjectOut): string[] {
  return [
    ...(role === undefined ? [] : [t('mcp.project.role', { role })]),
    ...(everyone === true ? [t('mcp.project.everyone')] : []),
    ...(owner === undefined || owner === null
      ? []
      : // A person without a name is known by their id. A name is data: the person chose it.
        [t('mcp.project.owner', { owner: flatten(owner.name ?? '').trim() || owner.id })]),
  ];
}

/** The line of `list_projects` for one project. */
function projectLine(p: ProjectOut, artifactCount: number): string {
  const details = [
    t('mcp.project.artifacts', { count: artifactCount }),
    ...(p.is_default ? [t('mcp.project.flagDefault')] : []),
    ...(p.archived ? [t('mcp.project.flagArchived')] : []),
    ...(p.has_instructions ? [t('mcp.project.flagInstructions')] : []),
    ...spaceDetails(p),
  ];
  return t('mcp.project.item', { id: p.id, name: flatten(p.name), details: details.join('; ') });
}

/** What an artifact's lines say about it, between the parentheses. */
function artifactDetails(a: ArtifactOut): string {
  return [
    a.kind,
    a.current_version === null
      ? t('mcp.artifact.unpublished')
      : t('mcp.artifact.version', {
          number: a.current_version.number,
          version_id: a.current_version.id,
        }),
    t('mcp.artifact.openThreads', { count: a.open_thread_count }),
    ...(a.tags.length === 0
      ? []
      : [t('mcp.artifact.tags', { tags: a.tags.map(flatten).join(', ') })]),
    ...(a.edited_on_server === true ? [t('mcp.artifact.editedOnServer')] : []),
  ].join('; ');
}

/** The line of an artifact list: its id first, its review link last. */
function artifactLine(a: ArtifactOut): string {
  return t('mcp.artifact.item', {
    id: a.id,
    name: flatten(a.name),
    details: artifactDetails(a),
    url: a.review_url,
  });
}

/** A version's message as one line of at most `MESSAGE_MAX_CHARS` characters; '' when it says nothing. */
function messageText(message: string | null): string {
  const chars = [...flatten(message ?? '').trim()];
  if (chars.length === 0) return '';
  const shown =
    chars.length > MESSAGE_MAX_CHARS
      ? `${chars.slice(0, MESSAGE_MAX_CHARS - 1).join('')}…`
      : chars.join('');
  return t('mcp.version.message', { message: shown });
}

/**
 * What a version line says about the paths `edit_artifact` changed to make it: the first
 * `EDITED_PATHS_MAX` and how many more; '' for a version that was not made that way.
 */
function editsText(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const shown = paths.slice(0, EDITED_PATHS_MAX).map(flatten).join(', ');
  const more = paths.length - EDITED_PATHS_MAX;
  return t('mcp.version.editedOnServer', {
    // A path is the publisher's: one line, whatever it holds.
    paths: more > 0 ? `${shown} ${t('mcp.version.editedMore', { count: more })}` : shown,
  });
}

/** The line of `get_artifact` for one version: its number and id first. */
function versionLine(v: VersionOut): string {
  return t('mcp.version.item', {
    id: v.id,
    number: v.number,
    current: v.is_current ? t('mcp.version.current') : '',
    count: v.file_count,
    size: formatBytes(v.total_bytes),
    source: v.source,
    created: new Date(v.created_at).toISOString(),
    edits: editsText(v.server_edits),
    message: messageText(v.message),
  });
}

/**
 * What `get_artifact` says about changing an artifact: the files of its current version, up to
 * `FILE_LIST_MAX`, and the ids to name. Publishing on top of it needs the current version's id.
 */
async function changeLines(
  deps: AppDeps,
  artifact: ArtifactRow,
  current: { id: string; number: number },
): Promise<string[]> {
  const [version, files] = await Promise.all([
    getCurrentVersion(deps.db.db, artifact),
    listVersionFiles(deps, current.id, { limit: FILE_LIST_MAX, cursor: null }),
  ]);
  const more = version.file_count - files.items.length;
  return [
    t('mcp.artifact.files', { number: current.number }),
    // A path is the publisher's: one line, whatever it holds.
    ...files.items.map((f) =>
      t('mcp.file.item', { path: flatten(f.path), size: formatBytes(f.size) }),
    ),
    ...(more > 0 ? [t('mcp.artifact.moreFiles', { count: more })] : []),
    t('mcp.artifact.next', { artifact_id: artifact.id, version_id: current.id }),
  ];
}

/**
 * The library tools: read the projects (and the instructions and notes agents publish by), create
 * a project, list and search artifacts, and read one artifact with its versions and files. They
 * read through the same services as `/api/v1`, so a caller sees what the API shows them.
 */
export const libraryTools: ToolModule = (server, ctx) => {
  const { deps, auth } = ctx;
  /** The caller's scope, for each call to pass to the services it reads through. */
  const scope = () => scopeForUser(deps, auth.user);

  server.registerTool(
    'list_projects',
    {
      ...DESCRIPTIONS.list_projects,
      inputSchema: ListProjectsIn,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof ListProjectsIn>) => {
      const viewer = scope();
      // A default project exists from the first publish; a library listed before that shows it.
      if (!a.archived) await defaultProjectFor(deps, viewer);
      const { items, nextCursor } = await listProjects(deps, viewer, {
        archived: a.archived,
        limit: a.limit,
        cursor: a.cursor ?? null,
      });
      const space = await spaceFieldsOf(deps, viewer, items);
      const lines = [
        t('mcp.projects.summary', { count: items.length }),
        ...items.map((row) =>
          projectLine(toProjectOut(row, space?.get(row.id)), row.artifact_count),
        ),
      ];
      return withMore(lines, 'list_projects', nextCursor);
    }),
  );

  server.registerTool(
    'get_project',
    {
      ...DESCRIPTIONS.get_project,
      inputSchema: GetProjectIn,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof GetProjectIn>) => {
      const viewer = scope();
      const row = await readProject(deps, viewer, a.project_id);
      const project = toProjectOut(row, (await spaceFieldsOf(deps, viewer, [row]))?.get(row.id));
      const place = spaceDetails(project);
      const name = flatten(row.name);
      const heading =
        place.length === 0
          ? t('mcp.project.heading', { id: row.id, name })
          : t('mcp.project.headingSpace', { id: row.id, name, details: place.join('; ') });
      const guidance = project.has_instructions
        ? `${t('mcp.project.followInstructions')}\n\n${row.instructions}`
        : t('mcp.project.noInstructions');
      return [
        heading,
        guidance,
        // What `whoami` says too, so that publishing needs no other call first.
        t('mcp.project.notes'),
        ...authoringNotes(deps.config).map((note) => `- ${note}`),
        t('mcp.project.inlineLimit', { size: formatBytes(deps.config.limits.maxInlineBytes) }),
      ].join('\n');
    }),
  );

  server.registerTool(
    'create_project',
    {
      ...DESCRIPTIONS.create_project,
      inputSchema: CreateProjectIn,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    runTool(ctx, async (a: z.output<typeof CreateProjectIn>) => {
      await enforceRateLimit(ctx.c, RATE_RULES.projectCreate, auth.user.id);
      const row = await createProject(deps, auth.user, {
        name: a.name,
        ...(a.instructions === undefined ? {} : { instructions: a.instructions }),
      });
      return t('mcp.project.created', { id: row.id, name: flatten(row.name) });
    }),
  );

  server.registerTool(
    'list_artifacts',
    {
      ...DESCRIPTIONS.list_artifacts,
      inputSchema: ListArtifactsIn,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof ListArtifactsIn>) => {
      const { query } = a;
      if (query !== undefined) {
        // A search has one list of its best matches, not pages.
        if (a.cursor !== undefined)
          throw badRequest(t('mcp.artifacts.queryCursor'), { field: 'cursor' });
        if (a.limit > QUERY_MAX_LIMIT)
          throw badRequest(t('mcp.artifacts.queryLimit', { max: QUERY_MAX_LIMIT }), {
            field: 'limit',
          });
      }
      const viewer = scope();
      const { items, nextCursor } = await listArtifacts(deps, viewer, {
        ...(a.project_id === undefined ? {} : { projectId: a.project_id }),
        ...(a.tag === undefined ? {} : { tag: a.tag }),
        ...(query === undefined ? {} : { q: query }),
        limit: a.limit,
        cursor: a.cursor ?? null,
      });
      const artifacts = (await artifactsOf(deps, viewer, items)).map(artifactLine);
      if (query !== undefined) {
        return [t('mcp.artifacts.found', { count: artifacts.length }), ...artifacts].join('\n');
      }
      const lines = [t('mcp.artifacts.summary', { count: artifacts.length }), ...artifacts];
      return withMore(lines, 'list_artifacts', nextCursor);
    }),
  );

  server.registerTool(
    'get_artifact',
    {
      ...DESCRIPTIONS.get_artifact,
      inputSchema: GetArtifactIn,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof GetArtifactIn>) => {
      const viewer = scope();
      const row = await getArtifact(deps.db.db, viewer, a.artifact_id, deps.clock.now());
      const [summary] = await toArtifactSummary(deps, viewer, [row]);
      if (summary === undefined) throw new Error(`no summary for artifact ${row.id}`);
      const page = await listVersions(deps, viewer, row.id, {
        limit: a.versions_limit,
        cursor: null,
      });
      const artifact = { ...toArtifactOut(summary), raw_url: summary.links.raw };
      const versions = page.items.map((v) => toVersionOut(v, page.currentVersionId));

      const current = artifact.current_version;
      return [
        t('mcp.artifact.heading', {
          id: artifact.id,
          name: flatten(artifact.name),
          details: artifactDetails(artifact),
        }),
        t('mcp.artifact.links', { review: artifact.review_url, raw: artifact.raw_url }),
        t('mcp.artifact.versions'),
        ...versions.map(versionLine),
        ...(page.nextCursor === null ? [] : [t('mcp.artifact.olderVersions')]),
        ...(current === null ? [] : await changeLines(deps, row, current)),
      ].join('\n');
    }),
  );
};
