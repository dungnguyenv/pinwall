import type { UserRow } from '../db/schema.ts';

export type Role = 'admin' | 'member';

/**
 * The role Pinwall acts on. The owner is always an admin, whatever `role_override` holds: it is
 * the break-glass account, and nobody can demote or block it. For an IdP user an admin's
 * override wins over the role the IdP gave; `null` means the IdP admitted no role.
 */
export function effectiveRole(
  u: Pick<UserRow, 'kind' | 'idp_role' | 'role_override'>,
): Role | 'blocked' | null {
  if (u.kind === 'owner') return 'admin';
  return u.role_override ?? u.idp_role;
}

/** Whether the user may use Pinwall at all: a role, not blocked, and not disabled. */
export function hasAccess(u: UserRow): boolean {
  const role = effectiveRole(u);
  return (role === 'admin' || role === 'member') && u.disabled_at === null;
}
