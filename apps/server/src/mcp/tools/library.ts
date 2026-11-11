import type { ArtifactSummary } from '@pinwall/shared';
import { z } from 'zod';
import { toArtifactSummary } from '../../api/artifacts.ts';
import type { ProjectRow, VersionRow } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { getArtifact, listArtifacts, SEARCH_MAX_CHARS } from '../../domain/artifacts.ts';
import {
  createProject,
  DEFAULT_PROJECT_ID,
  ensureDefaultProject,
  getProject,
  listProjects,
} from '../../domain/projects.ts';
import { listVersions } from '../../domain/versions.ts';
import { publicUrl } from '../../http/public-url.ts';
import { t } from '../../lib/i18n.ts';
import { DESCRIPTIONS, FIELDS } from '../descriptions.ts';
import { formatBytes, oneLine } from '../format.ts';
import { runTool } from '../results.ts';
import {
  type ArtifactOut,
  GetArtifactOut,
  ListArtifactsOut,
  ListProjectsOut,
  ProjectDetailOut,
  type ProjectOut,
  SearchArtifactsOut,
  type VersionOut,
} from '../schemas.ts';
import type { ToolModule } from '../server.ts';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

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
  limit: z.number().int().min(1).max(100).default(20).describe('Most artifacts to return.'),
  cursor: cursorField,
});

const SearchArtifactsIn = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(SEARCH_MAX_CHARS)
    .describe('Words to look for, such as part of a name, a tag or the text of the page.'),
  project_id: projectIdField.describe(`Only search this project. ${FIELDS.projectId}`),
  limit: z.number().int().min(1).max(50).default(10).describe('Most artifacts to return.'),
});

const GetArtifactIn = z.object({
  artifact_id: z.string().min(1).max(100).describe(FIELDS.artifactId),
  versions_limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('How many of the newest versions to list.'),
});

function toProjectOut(row: ProjectRow): ProjectOut {
  return {
    id: row.id,
    name: row.name,
    is_default: row.is_default === 1,
    archived: row.archived_at !== null,
    // Instructions of nothing but blank space tell an agent nothing.
    has_instructions: row.instructions.trim() !== '',
  };
}

function toArtifactOut(summary: ArtifactSummary): ArtifactOut {
  const { current_version: current } = summary;
  return {
    id: summary.id,
    name: summary.name,
    kind: summary.kind,
    project_id: summary.project_id,
    tags: summary.tags,
    current_version: current === null ? null : { id: current.id, number: current.number },
    latest_number: summary.latest_number,
    open_thread_count: summary.open_thread_count,
    updated_at: summary.updated_at,
    review_url: summary.links.review,
  };
}

function toVersionOut(
  deps: AppDeps,
  artifactId: string,
  row: VersionRow,
  currentVersionId: string | null,
): VersionOut {
  const page = `/a/${artifactId}/v/${row.number}`;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    entry_path: row.entry_path,
    file_count: row.file_count,
    total_bytes: row.total_bytes,
    message: row.message,
    source: row.source,
    created_at: row.created_at,
    is_current: row.id === currentVersionId,
    review_url: publicUrl(deps.config, page),
    raw_url: publicUrl(deps.config, `${page}/raw`),
  };
}

/** Artifacts with their tags, versions and thread counts loaded together, as the API lists them. */
async function artifactsOf(
  deps: AppDeps,
  rows: Parameters<typeof toArtifactSummary>[1],
): Promise<ArtifactOut[]> {
  return (await toArtifactSummary(deps, rows)).map(toArtifactOut);
}

/** The project `id`, or the default one (created when missing) when no id is given. */
async function readProject(deps: AppDeps, id: string | undefined): Promise<ProjectRow> {
  if (id === undefined || id === DEFAULT_PROJECT_ID) return ensureDefaultProject(deps);
  return getProject(deps.db.db, id);
}

/** The line of `list_projects` for one project. */
function projectLine(p: ProjectOut & { artifact_count: number }): string {
  const details = [
    t('mcp.project.artifacts', { count: p.artifact_count }),
    ...(p.is_default ? [t('mcp.project.flagDefault')] : []),
    ...(p.archived ? [t('mcp.project.flagArchived')] : []),
    ...(p.has_instructions ? [t('mcp.project.flagInstructions')] : []),
  ];
  return t('mcp.project.item', { id: p.id, name: oneLine(p.name), details: details.join('; ') });
}

/** What an artifact's lines say about it, between the parentheses. */
function artifactDetails(a: ArtifactOut): string {
  return [
    a.kind,
    a.current_version === null
      ? t('mcp.artifact.unpublished')
      : t('mcp.artifact.version', { number: a.current_version.number }),
    t('mcp.artifact.openThreads', { count: a.open_thread_count }),
    ...(a.tags.length === 0 ? [] : [t('mcp.artifact.tags', { tags: a.tags.join(', ') })]),
  ].join('; ');
}

/** The line of an artifact list: its id first, its review link last. */
function artifactLine(a: ArtifactOut): string {
  return t('mcp.artifact.item', {
    id: a.id,
    name: oneLine(a.name),
    details: artifactDetails(a),
    url: a.review_url,
  });
}

function versionLine(v: VersionOut): string {
  return t('mcp.version.item', {
    id: v.id,
    number: v.number,
    current: v.is_current ? t('mcp.version.current') : '',
    files: v.file_count,
    size: formatBytes(v.total_bytes),
    source: v.source,
    created: new Date(v.created_at).toISOString(),
    review: v.review_url,
    raw: v.raw_url,
  });
}

/** What `get_project` and `create_project` return: the project with its instructions. */
function detailOf(row: ProjectRow): ProjectDetailOut {
  return { project: { ...toProjectOut(row), instructions: row.instructions } };
}

/** Appends the line that says how to get the next page, when there is one. */
function withMore(lines: string[], tool: string, nextCursor: string | null): string {
  return (
    nextCursor === null ? lines : [...lines, t('mcp.list.more', { tool, cursor: nextCursor })]
  ).join('\n');
}

/**
 * The library tools: read the projects (and the instructions agents publish by), create a
 * project, list and search artifacts, and read one artifact with its versions. They read through
 * the same services as `/api/v1`, so a caller sees what the API shows them.
 */
export const libraryTools: ToolModule = (server, ctx) => {
  const { deps, auth } = ctx;

  server.registerTool(
    'list_projects',
    {
      ...DESCRIPTIONS.list_projects,
      inputSchema: ListProjectsIn,
      outputSchema: ListProjectsOut,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof ListProjectsIn>) => {
      // The default project exists from the first publish; a library listed before that shows it.
      if (!a.archived) await ensureDefaultProject(deps);
      const { items, nextCursor } = await listProjects(deps, {
        archived: a.archived,
        limit: a.limit,
        cursor: a.cursor ?? null,
      });
      const projects = items.map((row) => ({
        ...toProjectOut(row),
        artifact_count: row.artifact_count,
      }));
      const lines = [
        t('mcp.projects.summary', { count: projects.length }),
        ...projects.map(projectLine),
      ];
      return {
        text: withMore(lines, 'list_projects', nextCursor),
        structured: { projects, next_cursor: nextCursor },
      };
    }),
  );

  server.registerTool(
    'get_project',
    {
      ...DESCRIPTIONS.get_project,
      inputSchema: GetProjectIn,
      outputSchema: ProjectDetailOut,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof GetProjectIn>) => {
      const row = await readProject(deps, a.project_id);
      const structured = detailOf(row);
      const heading = t('mcp.project.heading', { id: row.id, name: oneLine(row.name) });
      const guidance = structured.project.has_instructions
        ? `${t('mcp.project.followInstructions')}\n\n${row.instructions}`
        : t('mcp.project.noInstructions');
      return { text: `${heading}\n${guidance}`, structured };
    }),
  );

  server.registerTool(
    'create_project',
    {
      ...DESCRIPTIONS.create_project,
      inputSchema: CreateProjectIn,
      outputSchema: ProjectDetailOut,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    runTool(ctx, async (a: z.output<typeof CreateProjectIn>) => {
      const row = await createProject(deps, auth.user, {
        name: a.name,
        ...(a.instructions === undefined ? {} : { instructions: a.instructions }),
      });
      return {
        text: t('mcp.project.created', { id: row.id, name: oneLine(row.name) }),
        structured: detailOf(row),
      };
    }),
  );

  server.registerTool(
    'list_artifacts',
    {
      ...DESCRIPTIONS.list_artifacts,
      inputSchema: ListArtifactsIn,
      outputSchema: ListArtifactsOut,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof ListArtifactsIn>) => {
      const { items, nextCursor } = await listArtifacts(deps, {
        ...(a.project_id === undefined ? {} : { projectId: a.project_id }),
        ...(a.tag === undefined ? {} : { tag: a.tag }),
        limit: a.limit,
        cursor: a.cursor ?? null,
      });
      const artifacts = await artifactsOf(deps, items);
      const lines = [
        t('mcp.artifacts.summary', { count: artifacts.length }),
        ...artifacts.map(artifactLine),
      ];
      return {
        text: withMore(lines, 'list_artifacts', nextCursor),
        structured: { artifacts, next_cursor: nextCursor },
      };
    }),
  );

  server.registerTool(
    'search_artifacts',
    {
      ...DESCRIPTIONS.search_artifacts,
      inputSchema: SearchArtifactsIn,
      outputSchema: SearchArtifactsOut,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof SearchArtifactsIn>) => {
      const { items } = await listArtifacts(deps, {
        q: a.query,
        ...(a.project_id === undefined ? {} : { projectId: a.project_id }),
        limit: a.limit,
        cursor: null,
      });
      const artifacts = await artifactsOf(deps, items);
      const lines = [
        t('mcp.artifacts.found', { count: artifacts.length }),
        ...artifacts.map(artifactLine),
      ];
      return { text: lines.join('\n'), structured: { artifacts } };
    }),
  );

  server.registerTool(
    'get_artifact',
    {
      ...DESCRIPTIONS.get_artifact,
      inputSchema: GetArtifactIn,
      outputSchema: GetArtifactOut,
      annotations: READ_ONLY,
    },
    runTool(ctx, async (a: z.output<typeof GetArtifactIn>) => {
      const row = await getArtifact(deps.db.db, a.artifact_id, deps.clock.now());
      const [summary] = await toArtifactSummary(deps, [row]);
      if (summary === undefined) throw new Error(`no summary for artifact ${row.id}`);
      const page = await listVersions(deps, row.id, { limit: a.versions_limit, cursor: null });
      const artifact = { ...toArtifactOut(summary), raw_url: summary.links.raw };
      const versions = page.items.map((v) => toVersionOut(deps, row.id, v, page.currentVersionId));

      const current = artifact.current_version;
      const lines = [
        t('mcp.artifact.heading', {
          id: artifact.id,
          name: oneLine(artifact.name),
          details: artifactDetails(artifact),
        }),
        t('mcp.artifact.links', { review: artifact.review_url, raw: artifact.raw_url }),
        t('mcp.artifact.versions'),
        ...versions.map(versionLine),
        ...(page.nextCursor === null ? [] : [t('mcp.artifact.olderVersions')]),
        // Publishing on top of this artifact needs the current version's id.
        ...(current === null
          ? []
          : [t('mcp.artifact.next', { artifact_id: artifact.id, version_id: current.id })]),
      ];
      return { text: lines.join('\n'), structured: { artifact, versions } };
    }),
  );
};
