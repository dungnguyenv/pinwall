import { expect, test } from 'vitest';
import type { OidcIdentity } from '../../../src/auth/oidc/identity.ts';
import { type AccessPolicy, accessPolicy, mapIdpRole } from '../../../src/auth/oidc/policy.ts';
import { loadConfig } from '../../../src/config/load.ts';

const policy = (p: Partial<AccessPolicy> = {}): AccessPolicy => ({
  adminGroups: [],
  memberGroups: [],
  adminEmails: [],
  memberEmails: [],
  memberDomains: [],
  ...p,
});
const who = (o: Partial<Pick<OidcIdentity, 'email' | 'emailVerified' | 'groups'>> = {}) => ({
  email: null,
  emailVerified: false,
  groups: [],
  ...o,
});

test('with no member restriction every identity is a member', () => {
  expect(mapIdpRole(policy(), who())).toBe('member');
  expect(mapIdpRole(policy({ adminGroups: ['admins'] }), who({ groups: ['admins'] }))).toBe(
    'admin',
  );
  expect(mapIdpRole(policy({ adminEmails: ['boss@example.com'] }), who())).toBe('member');
});

test('groups map to admin and member, exactly', () => {
  const p = policy({ adminGroups: ['pinwall-admins'], memberGroups: ['pinwall-users'] });
  expect(mapIdpRole(p, who({ groups: ['pinwall-admins'] }))).toBe('admin');
  expect(mapIdpRole(p, who({ groups: ['other', 'pinwall-users'] }))).toBe('member');
  expect(mapIdpRole(p, who({ groups: ['other'] }))).toBeNull();
  expect(mapIdpRole(p, who({ groups: ['Pinwall-Users'] }))).toBeNull();
});

test('verified emails and exact domains', () => {
  const p = policy({
    adminEmails: ['boss@example.com'],
    memberEmails: ['friend@gmail.com'],
    memberDomains: ['example.com'],
  });
  const v = (email: string, emailVerified = true) => mapIdpRole(p, who({ email, emailVerified }));
  expect(v('boss@example.com')).toBe('admin');
  expect(v('ann@example.com')).toBe('member');
  expect(v('friend@gmail.com')).toBe('member');
  expect(v('stranger@gmail.com')).toBeNull();
  expect(v('ann@sub.example.com')).toBeNull();
  expect(v('ann@example.com.evil.net')).toBeNull();
  expect(v('boss@example.com', false)).toBeNull();
});

test('email and domain matches ignore case; the domain is after the last @', () => {
  const p = policy({ adminEmails: ['boss@example.com'], memberDomains: ['example.com'] });
  expect(mapIdpRole(p, who({ email: 'Boss@Example.COM', emailVerified: true }))).toBe('admin');
  expect(mapIdpRole(p, who({ email: 'ann@EXAMPLE.com', emailVerified: true }))).toBe('member');
  expect(mapIdpRole(p, who({ email: '"a@evil.net"@example.com', emailVerified: true }))).toBe(
    'member',
  );
  expect(mapIdpRole(p, who({ email: 'a@example.com@evil.net', emailVerified: true }))).toBeNull();
});

test('an admin group or email wins over every member rule', () => {
  const p = policy({
    adminGroups: ['admins'],
    adminEmails: ['boss@example.com'],
    memberGroups: ['users'],
  });
  expect(mapIdpRole(p, who({ groups: ['users', 'admins'] }))).toBe('admin');
  expect(mapIdpRole(p, who({ email: 'boss@example.com', emailVerified: true }))).toBe('admin');
});

test('an unverified email never matches, and a missing email matches nothing', () => {
  const p = policy({ memberDomains: ['example.com'] });
  expect(mapIdpRole(p, who({ email: 'ann@example.com', emailVerified: false }))).toBeNull();
  expect(mapIdpRole(p, who({ email: null, emailVerified: true }))).toBeNull();
});

test('accessPolicy reads the configuration', () => {
  const config = loadConfig({
    PINWALL_OIDC_ISSUER: 'https://idp.example',
    PINWALL_OIDC_CLIENT_ID: 'pinwall',
    PINWALL_OIDC_ROLES_CLAIM: 'groups',
    PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins, ops',
    PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-users',
    PINWALL_ADMIN_EMAILS: 'Boss@Example.com',
    PINWALL_MEMBER_EMAILS: 'friend@gmail.com, pal@gmail.com',
    PINWALL_MEMBER_DOMAINS: '@Example.com',
  });
  expect(accessPolicy(config)).toEqual({
    adminGroups: ['pinwall-admins', 'ops'],
    memberGroups: ['pinwall-users'],
    adminEmails: ['boss@example.com'],
    memberEmails: ['friend@gmail.com', 'pal@gmail.com'],
    memberDomains: ['example.com'],
  });
});

test('without OIDC the policy has no groups', () => {
  const config = loadConfig({ PINWALL_MEMBER_DOMAINS: 'example.com' });
  expect(accessPolicy(config)).toEqual(policy({ memberDomains: ['example.com'] }));
});
