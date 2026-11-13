import { z } from 'zod';
import { page, Timestamp } from './common.ts';

/**
 * What a person's space holds, for an admin to see how much room they use. In `personal` mode the
 * artifacts, versions and bytes are those in the projects they own (what editors publish there
 * included); in `team` mode, those they published. Projects, share links and the last publish
 * are the person's own in either.
 */
export const AdminUsage = z.object({
  projects: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
  versions: z.number().int().nonnegative(),
  /** The sizes of the versions, each counted in full. */
  bytes: z.number().int().nonnegative(),
  /** Links they made that are neither revoked nor expired. */
  share_links: z.number().int().nonnegative(),
  /** When they last published a version, in either mode; `null` if they never did. */
  last_published_at: Timestamp.nullable(),
});
export type AdminUsage = z.infer<typeof AdminUsage>;

/** A limit an admin sets on one person: whole units, `null` for "use the instance's". */
const QuotaBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
/** The column is a 32-bit integer. */
const QuotaArtifacts = z.number().int().min(0).max(2_147_483_647).nullable();

/** A user as an admin sees them, with the role Pinwall acts on and where it comes from. */
export const AdminUser = z.object({
  id: z.string(),
  kind: z.enum(['owner', 'oidc']),
  /** The name, else the email, else empty; never `null`, so a list can always show something. */
  name: z.string(),
  email: z.string().nullable(),
  email_verified: z.boolean(),
  avatar_url: z.string().nullable(),
  /** The role the identity provider gave; `null` for the owner and for users it gave none. */
  idp_role: z.enum(['admin', 'member']).nullable(),
  /**
   * What an admin set. `admin` or `member` replaces the identity provider's role only while the
   * provider gives one; `blocked` always applies.
   */
  role_override: z.enum(['admin', 'member', 'blocked']).nullable(),
  /** The role Pinwall acts on; `null` when the user has no role and cannot use Pinwall. */
  effective_role: z.enum(['admin', 'member', 'blocked']).nullable(),
  disabled_at: Timestamp.nullable(),
  disabled_reason: z.string().nullable(),
  created_at: Timestamp,
  last_seen_at: Timestamp.nullable(),
  // Optional in the schema, so a 1.0 client's `AdminUser` still parses; the server always sends
  // them, in both modes.
  usage: AdminUsage.optional(),
  /** May this person expose content (`PINWALL_SHARE_LINKS=approved`); admins always may. */
  share_approved: z.boolean().optional(),
  /** Their own bytes limit (0: none); `null` for the instance's. */
  quota_bytes: QuotaBytes.optional(),
  /** Their own artifacts limit (0: none); `null` for the instance's. */
  quota_artifacts: QuotaArtifacts.optional(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AdminUserList = page(AdminUser);
export type AdminUserList = z.infer<typeof AdminUserList>;

/** `null` clears the override, so the identity provider's role applies again. */
export const SetRoleRequest = z.object({
  role_override: z.enum(['admin', 'member', 'blocked']).nullable(),
});
export type SetRoleRequest = z.infer<typeof SetRoleRequest>;

/** What "Revoke now" ended: browser sessions, API tokens and OAuth grants. */
export const RevokeResult = z.object({
  sessions: z.number().int().nonnegative(),
  api_tokens: z.number().int().nonnegative(),
  oauth_grants: z.number().int().nonnegative(),
});
export type RevokeResult = z.infer<typeof RevokeResult>;

/** What an admin changes about one person; a key left out stays as it is. */
export const UpdateAdminUserRequest = z
  .object({
    share_approved: z.boolean().optional(),
    quota_bytes: QuotaBytes.optional(),
    quota_artifacts: QuotaArtifacts.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Send at least one of share_approved, quota_bytes and quota_artifacts',
  });
export type UpdateAdminUserRequest = z.infer<typeof UpdateAdminUserRequest>;

/** Typing the account's email address (its id when it has none) confirms a purge. */
export const PurgeRequest = z.object({ confirm_email: z.string().min(1).max(320) });
export type PurgeRequest = z.infer<typeof PurgeRequest>;

/** What a purge deleted: the projects, and the artifacts in them. */
export const PurgeResult = z.object({
  projects: z.number().int().nonnegative(),
  artifacts: z.number().int().nonnegative(),
});
export type PurgeResult = z.infer<typeof PurgeResult>;
