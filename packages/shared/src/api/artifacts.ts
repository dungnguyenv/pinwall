import { z } from 'zod';
import { page, Timestamp } from './common.ts';
import { PublishWarning, wellFormed } from './publish.ts';

/** One version as listed: what it holds, where it came from, and whether it is the current one. */
export const VersionSummary = z.object({
  id: z.string(),
  number: z.number().int(),
  /** The entry page's title, when it has one. */
  title: z.string().nullable(),
  entry_path: z.string(),
  theme_color: z.string().nullable(),
  has_thumbnail: z.boolean(),
  file_count: z.number().int(),
  total_bytes: z.number().int(),
  message: z.string().nullable(),
  source: z.enum(['mcp', 'inline', 'api', 'web', 'restore']),
  /** For a restored version, the version it was copied from. */
  restored_from_version_id: z.string().nullable(),
  warnings: z.array(PublishWarning),
  created_by: z.string().nullable(),
  created_at: Timestamp,
  is_current: z.boolean(),
});
export type VersionSummary = z.infer<typeof VersionSummary>;

export const VersionList = page(VersionSummary);
export type VersionList = z.infer<typeof VersionList>;

/** A file of a version. `content_type` is what the file is served as. */
export const VersionFile = z.object({
  path: z.string(),
  size: z.number().int(),
  content_type: z.string(),
  sha256: z.string(),
});
export type VersionFile = z.infer<typeof VersionFile>;

export const VersionFileList = page(VersionFile);
export type VersionFileList = z.infer<typeof VersionFileList>;

/** An artifact with its current version. The links live on the app origin and never change. */
export const ArtifactSummary = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  kind: z.enum(['html', 'markdown']),
  /** Normalized, sorted. */
  tags: z.array(z.string()),
  current_version: VersionSummary.nullable(),
  /** The newest number given out; deleted versions leave gaps. */
  latest_number: z.number().int(),
  /** Comment threads not resolved yet. */
  open_thread_count: z.number().int(),
  /** Share links that still open: neither revoked nor expired. */
  share_link_count: z.number().int(),
  created_by: z.string().nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
  links: z.object({
    /** The review page; it follows the newest version. */
    review: z.string(),
    /** The raw files of the newest version. */
    raw: z.string(),
  }),
  /** Whether the caller may rename, retag or delete the artifact. Sent only in `personal` mode. */
  can_manage: z.boolean().optional(),
});
export type ArtifactSummary = z.infer<typeof ArtifactSummary>;

export const ArtifactList = page(ArtifactSummary);
export type ArtifactList = z.infer<typeof ArtifactList>;

/** Only the fields given change; `tags` replaces the whole set. */
export const UpdateArtifactRequest = z.object({
  name: wellFormed(z.string().trim().min(1).max(200)).optional(),
  project_id: z.string().optional(),
  tags: z.array(wellFormed(z.string())).max(20).optional(),
});
export type UpdateArtifactRequest = z.infer<typeof UpdateArtifactRequest>;

/** Restores on top of the version the caller saw, so a newer one is not overwritten unseen. */
export const RestoreRequest = z.object({ expected_version_id: z.string() });
export type RestoreRequest = z.infer<typeof RestoreRequest>;
