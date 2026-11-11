import type { Config } from '../../config/types.ts';
import type { Role } from '../roles.ts';
import type { OidcIdentity } from './identity.ts';

/** Who the IdP may let in, and as what. Emails and domains are lowercase. */
export interface AccessPolicy {
  adminGroups: string[];
  memberGroups: string[];
  adminEmails: string[];
  memberEmails: string[];
  memberDomains: string[];
}

export function accessPolicy(config: Config): AccessPolicy {
  return {
    adminGroups: config.oidc?.adminGroups ?? [],
    memberGroups: config.oidc?.memberGroups ?? [],
    adminEmails: config.access.adminEmails,
    memberEmails: config.access.memberEmails,
    memberDomains: config.access.memberDomains,
  };
}

const includesIgnoringCase = (list: string[], value: string) =>
  list.some((entry) => entry.toLowerCase() === value);

/**
 * The role the IdP identity earns, or null when it is not admitted. Admin rules come first.
 * With no member group, email or domain configured, everyone the IdP signs in is a member.
 * Group names match exactly, with case; email rules count only for a verified email, and
 * emails and domains match whole, ignoring case.
 */
export function mapIdpRole(
  policy: AccessPolicy,
  id: Pick<OidcIdentity, 'email' | 'emailVerified' | 'groups'>,
): Role | null {
  const email = id.emailVerified && id.email ? id.email.toLowerCase() : null;
  const domain = email === null ? null : email.slice(email.lastIndexOf('@') + 1);
  const inGroup = (groups: string[]) => id.groups.some((group) => groups.includes(group));

  if (
    inGroup(policy.adminGroups) ||
    (email !== null && includesIgnoringCase(policy.adminEmails, email))
  ) {
    return 'admin';
  }
  if (
    policy.memberGroups.length === 0 &&
    policy.memberEmails.length === 0 &&
    policy.memberDomains.length === 0
  ) {
    return 'member';
  }
  if (
    inGroup(policy.memberGroups) ||
    (email !== null && includesIgnoringCase(policy.memberEmails, email)) ||
    (domain !== null && includesIgnoringCase(policy.memberDomains, domain))
  ) {
    return 'member';
  }
  return null;
}
