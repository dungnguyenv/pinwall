/*
 * The API shapes the web app uses, in one place. Everything comes from
 * `@pinwall/shared`, the same zod schemas the server validates with.
 *
 * When a screen needs a DTO that a parallel milestone adds to the shared
 * package but this branch does not have yet, define it here under the name
 * that milestone's plan gives it. The merge then turns that definition into a
 * re-export, and no other file changes.
 */
import { Label, page, Timestamp } from '@pinwall/shared';
import { z } from 'zod';

export {
  CeremonyOptions,
  ErrorBody,
  Label,
  Me,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasskeyAuthenticationResponse,
  PasskeyRegistrationResponse,
  PasskeySignInRequest,
  PublicConfig,
  page,
  SetupPasskeyOptionsRequest,
  SetupRequest,
} from '@pinwall/shared';

// --- M4 (projects, artifacts, versions). Replace with re-exports once M4 merges. ---

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  /** What an agent reads before it publishes into the project. */
  instructions: z.string(),
  /** Where publishes without a project go. It cannot be archived. */
  is_default: z.boolean(),
  archived_at: Timestamp.nullable(),
  artifact_count: z.number().int(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Project = z.infer<typeof Project>;

export const ProjectList = page(Project);
export type ProjectList = z.infer<typeof ProjectList>;

export const CreateProjectRequest = z.object({
  name: Label,
  instructions: z.string().max(20_000).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** Only the fields given change. `archived: true` archives, `false` brings the project back. */
export const UpdateProjectRequest = z.object({
  name: Label.optional(),
  instructions: z.string().max(20_000).optional(),
  archived: z.boolean().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const PublishWarning = z.object({
  code: z.literal('root_absolute_url'),
  file: z.string(),
  url: z.string(),
  message: z.string(),
});
export type PublishWarning = z.infer<typeof PublishWarning>;

/**
 * Where a publish goes: a new version on top of the one the publisher saw, or
 * a new artifact (by default in the default project, named after its entry
 * page's title). M4's schema also refuses lone surrogates in the names.
 */
export const PublishTargetInput = z.union([
  z.strictObject({ artifact_id: z.string(), expected_version_id: z.string() }),
  z.strictObject({
    project_id: z.string().nullable().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    tags: z.array(z.string()).max(20).optional(),
  }),
]);
export type PublishTargetInput = z.infer<typeof PublishTargetInput>;

/** The version a publish made, with the links to hand to people. */
export const PublishResult = z.object({
  artifact_id: z.string(),
  version_id: z.string(),
  version_number: z.number().int(),
  kind: z.enum(['html', 'markdown']),
  entry_path: z.string(),
  file_count: z.number().int(),
  total_bytes: z.number().int(),
  review_url: z.string(),
  raw_url: z.string(),
  warnings: z.array(PublishWarning),
});
export type PublishResult = z.infer<typeof PublishResult>;

export const VersionSummary = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string().nullable(),
  entry_path: z.string(),
  theme_color: z.string().nullable(),
  has_thumbnail: z.boolean(),
  file_count: z.number().int(),
  total_bytes: z.number().int(),
  message: z.string().nullable(),
  source: z.enum(['mcp', 'inline', 'api', 'web', 'restore']),
  restored_from_version_id: z.string().nullable(),
  warnings: z.array(PublishWarning),
  created_by: z.string().nullable(),
  created_at: Timestamp,
  is_current: z.boolean(),
});
export type VersionSummary = z.infer<typeof VersionSummary>;

export const ArtifactSummary = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  kind: z.enum(['html', 'markdown']),
  tags: z.array(z.string()),
  current_version: VersionSummary.nullable(),
  latest_number: z.number().int(),
  created_by: z.string().nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
  links: z.object({ review: z.string(), raw: z.string() }),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;
