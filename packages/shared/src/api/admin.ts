import { z } from 'zod';
import { page, Timestamp } from './common.ts';

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
