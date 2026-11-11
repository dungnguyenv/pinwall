import { z } from 'zod';
import { UserRef, VersionRef } from './comments.ts';
import { page, Timestamp } from './common.ts';
import { ContentGrant } from './content.ts';

/** Shortest share-link password, counted after normalization. */
export const SHARE_PASSWORD_MIN_LENGTH = 8;

/** The text of a share-link password as sent: its length is checked once it is normalized. */
const SharePassword = z.string().min(1).max(1024);

/**
 * A share link as its artifact's members see it; the token itself is shown only once, when the
 * link is made. `version` null means the link follows the current version. `status` is
 * `revoked` once revoked, else `expired` after `expires_at`, else `active`.
 */
export const ShareLink = z.object({
  id: z.string(),
  artifact_id: z.string(),
  version: VersionRef.nullable(),
  has_password: z.boolean(),
  allow_comments: z.boolean(),
  expires_at: Timestamp.nullable(),
  created_by: UserRef.nullable(),
  created_at: Timestamp,
  last_used_at: Timestamp.nullable(),
  revoked_at: Timestamp.nullable(),
  status: z.enum(['active', 'expired', 'revoked']),
});
export type ShareLink = z.infer<typeof ShareLink>;

export const ShareLinkList = page(ShareLink);
export type ShareLinkList = z.infer<typeof ShareLinkList>;

/** `include_revoked` reads `true`/`false` (or `1`/`0`, `yes`/`no`, `on`/`off`). */
export const ShareLinkQuery = z.object({
  include_revoked: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(1000).optional(),
});
export type ShareLinkQuery = z.infer<typeof ShareLinkQuery>;

/**
 * A new share link. Without `version_id` (or with null) it follows the current version; without
 * `password` anyone with the link can open it; without `expires_at` it lasts until revoked.
 */
export const CreateShareLinkRequest = z.object({
  version_id: z.string().nullable().optional(),
  password: SharePassword.nullable().optional(),
  expires_at: Timestamp.nullable().optional(),
  allow_comments: z.boolean().default(false),
});
export type CreateShareLinkRequest = z.infer<typeof CreateShareLinkRequest>;

/** A new share link with its token and URL, shown only this once. */
export const CreatedShareLink = z.object({ link: ShareLink, token: z.string(), url: z.string() });
export type CreatedShareLink = z.infer<typeof CreatedShareLink>;

/** What a share-link viewer is shown: the artifact, the version, and a grant to its content. */
export const ShareInfo = z.object({
  artifact_name: z.string(),
  kind: z.enum(['html', 'markdown']),
  version_number: z.number().int(),
  follows_current: z.boolean(),
  allow_comments: z.boolean(),
  expires_at: Timestamp.nullable(),
  content: ContentGrant,
});
export type ShareInfo = z.infer<typeof ShareInfo>;

export const UnlockRequest = z.object({ password: SharePassword });
export type UnlockRequest = z.infer<typeof UnlockRequest>;
