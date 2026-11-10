import type { UserRow } from '../db/schema.ts';

export type Role = 'admin' | 'member';

/**
 * The role Pinwall acts on: an admin's override wins, else the owner is an admin and an IdP user
 * has the role the IdP gave. `null` means the IdP admitted no role.
 */
export function effectiveRole(
  u: Pick<UserRow, 'kind' | 'idp_role' | 'role_override'>,
): Role | 'blocked' | null {
  return u.role_override ?? (u.kind === 'owner' ? 'admin' : u.idp_role);
}

/** Whether the user may use Pinwall at all: a role, not blocked, and not disabled. */
export function hasAccess(u: UserRow): boolean {
  const role = effectiveRole(u);
  return (role === 'admin' || role === 'member') && u.disabled_at === null;
}
