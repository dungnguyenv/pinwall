import type { UserRow } from '../db/schema.ts';

export type Role = 'admin' | 'member';

/**
 * The role Pinwall acts on. The owner is always an admin, whatever `role_override` holds: it is
 * the break-glass account, and nobody can demote or block it. For an IdP user, `blocked` always
 * applies. An `admin` or `member` override replaces the IdP's role only while the IdP admits the
 * person (`idp_role` is not null): once the IdP drops them they have no role, as if no admin had
 * set one, and the stored override applies again if the IdP admits them later. `null` means no
 * role.
 */
export function effectiveRole(
  u: Pick<UserRow, 'kind' | 'idp_role' | 'role_override'>,
): Role | 'blocked' | null {
  if (u.kind === 'owner') return 'admin';
  if (u.role_override === 'blocked') return 'blocked';
  if (u.idp_role === null) return null;
  return u.role_override ?? u.idp_role;
}

/** Whether the user may use Pinwall at all: a role, not blocked, and not disabled. */
export function hasAccess(u: UserRow): boolean {
  const role = effectiveRole(u);
  return (role === 'admin' || role === 'member') && u.disabled_at === null;
}
