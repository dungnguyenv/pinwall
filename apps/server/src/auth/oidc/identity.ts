import { z } from 'zod';

/** Who the IdP says signed in, normalized from ID token or userinfo claims. */
export interface OidcIdentity {
  subject: string;
  /** Trimmed and lowercased; null when absent, not an email address, or over 254 characters. */
  email: string | null;
  /** True only when the IdP sent `true` or the string `"true"`. */
  emailVerified: boolean;
  /** The first non-blank of name, preferred_username, given + family name, email, subject. */
  name: string;
  /** The picture claim when it is an https: URL of at most 2048 characters. */
  avatarUrl: string | null;
  groups: string[];
}

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_CHARS = 200;
const MAX_AVATAR_URL_LENGTH = 2048;

const emailSchema = z.email();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The claim `name`: the key itself first, since IdPs use URLs and URNs with dots as claim names.
 * Otherwise a dotted name walks nested objects, as Keycloak's `realm_access.roles` needs. Only
 * own properties of plain objects are followed.
 */
export function readClaim(claims: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(claims, name)) return claims[name];
  if (!name.includes('.')) return undefined;
  let current: unknown = claims;
  for (const key of name.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Group names from a roles claim: a string is one group, an array gives its non-empty strings,
 * and an object (Zitadel's roles claim) gives its keys. Duplicates are dropped, order is kept.
 */
export function extractGroups(value: unknown): string[] {
  let names: unknown[];
  if (typeof value === 'string') names = [value];
  else if (Array.isArray(value)) names = value;
  else if (isPlainObject(value)) names = Object.keys(value);
  else return [];
  const groups = names.filter((n): n is string => typeof n === 'string' && n.length > 0);
  return [...new Set(groups)];
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEmail(value: unknown): string | null {
  const email = nonBlank(value)?.toLowerCase();
  if (email === undefined || email.length > MAX_EMAIL_LENGTH) return null;
  return emailSchema.safeParse(email).success ? email : null;
}

function avatarUrl(value: unknown): string | null {
  const raw = nonBlank(value);
  if (raw === undefined) return null;
  const url = URL.parse(raw);
  if (url === null || url.protocol !== 'https:') return null;
  return url.href.length <= MAX_AVATAR_URL_LENGTH ? url.href : null;
}

/** Cuts at a code point boundary, so an emoji is never split into a lone surrogate. */
function cut(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/**
 * Normalizes claims into an identity. `rolesClaim` names the claim holding groups; without it
 * the identity has none. Throws when `sub` is not a non-empty string: without a subject there is
 * no stable key for the user.
 */
export function identityFromClaims(
  claims: Record<string, unknown>,
  rolesClaim: string | undefined,
): OidcIdentity {
  const subject = claims.sub;
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new Error('The IdP sent no subject (sub) claim');
  }
  const email = normalizeEmail(claims.email);
  const fullName = [nonBlank(claims.given_name), nonBlank(claims.family_name)]
    .filter((part) => part !== undefined)
    .join(' ');
  const name =
    nonBlank(claims.name) ??
    nonBlank(claims.preferred_username) ??
    nonBlank(fullName) ??
    email ??
    nonBlank(subject) ??
    subject;
  return {
    subject,
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: cut(name, MAX_NAME_CHARS),
    avatarUrl: avatarUrl(claims.picture),
    groups: rolesClaim === undefined ? [] : extractGroups(readClaim(claims, rolesClaim)),
  };
}
