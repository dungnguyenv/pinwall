import { z } from 'zod';

/**
 * Output schemas of the MCP tools. The SDK publishes each one as the tool's `outputSchema` and
 * checks every `structuredContent` against it before answering.
 */

/** `whoami`: the caller, how they connected, and what this Pinwall accepts. */
export const WhoamiOut = z.object({
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    role: z.enum(['admin', 'member']),
  }),
  via: z.enum(['oauth', 'api_token']),
  pinwall_url: z.string(),
  isolation: z.enum(['single-domain', 'content-domain']),
  limits: z.object({
    max_upload_bytes: z.number().int(),
    max_inline_bytes: z.number().int(),
    max_file_bytes: z.number().int(),
    max_version_bytes: z.number().int(),
    max_files: z.number().int(),
  }),
  upload_url_ttl_seconds: z.number().int(),
  authoring_notes: z.array(z.string()),
});
export type WhoamiOut = z.infer<typeof WhoamiOut>;

/** A project as every project tool shows it. The instructions travel only where they are asked for. */
export const ProjectOut = z.object({
  id: z.string(),
  name: z.string(),
  is_default: z.boolean(),
  archived: z.boolean(),
  has_instructions: z.boolean(),
});
export type ProjectOut = z.infer<typeof ProjectOut>;

/** An artifact in a list: its current version, open comment threads and review page. */
export const ArtifactOut = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['html', 'markdown']),
  project_id: z.string(),
  tags: z.array(z.string()),
  /** `null` only while an artifact has no committed version. */
  current_version: z.object({ id: z.string(), number: z.number().int() }).nullable(),
  /** The newest version number given out; deleted versions leave gaps. */
  latest_number: z.number().int(),
  open_thread_count: z.number().int(),
  /** Epoch milliseconds. */
  updated_at: z.number().int(),
  /** The review page, which follows the newest version. */
  review_url: z.string(),
});
export type ArtifactOut = z.infer<typeof ArtifactOut>;

/** One version of an artifact, with the links to review it and to fetch its raw files. */
export const VersionOut = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string().nullable(),
  entry_path: z.string(),
  file_count: z.number().int(),
  total_bytes: z.number().int(),
  message: z.string().nullable(),
  source: z.enum(['mcp', 'inline', 'api', 'web', 'restore']),
  /** Epoch milliseconds. */
  created_at: z.number().int(),
  is_current: z.boolean(),
  review_url: z.string(),
  raw_url: z.string(),
});
export type VersionOut = z.infer<typeof VersionOut>;

/** `list_projects`. */
export const ListProjectsOut = z.object({
  projects: z.array(ProjectOut.extend({ artifact_count: z.number().int() })),
  next_cursor: z.string().nullable(),
});
export type ListProjectsOut = z.infer<typeof ListProjectsOut>;

/** `get_project` and `create_project`. */
export const ProjectDetailOut = z.object({
  project: ProjectOut.extend({ instructions: z.string() }),
});
export type ProjectDetailOut = z.infer<typeof ProjectDetailOut>;

/** `list_artifacts`. */
export const ListArtifactsOut = z.object({
  artifacts: z.array(ArtifactOut),
  next_cursor: z.string().nullable(),
});
export type ListArtifactsOut = z.infer<typeof ListArtifactsOut>;

/** `search_artifacts`. */
export const SearchArtifactsOut = z.object({ artifacts: z.array(ArtifactOut) });
export type SearchArtifactsOut = z.infer<typeof SearchArtifactsOut>;

/** `get_artifact`: the artifact and its newest versions, the newest first. */
export const GetArtifactOut = z.object({
  artifact: ArtifactOut.extend({ raw_url: z.string() }),
  versions: z.array(VersionOut),
});
export type GetArtifactOut = z.infer<typeof GetArtifactOut>;
