import type { UserRow } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { decryptString, deriveKey, encryptString } from '../../lib/crypto.ts';
import { newId } from '../../lib/ids.ts';
import { effectiveRole } from '../roles.ts';
import type { OidcIdentity } from './identity.ts';
import { accessPolicy, mapIdpRole } from './policy.ts';

/** The HKDF purpose of the key that seals IdP refresh tokens at rest. */
export const IDP_REFRESH_TOKEN_PURPOSE = 'idp-refresh-token';

function refreshTokenKey(deps: AppDeps): Buffer {
  const { secretKey } = deps.config;
  if (secretKey === null) {
    throw new Error('No secret key to seal IdP refresh tokens with: createDeps sets one');
  }
  return deriveKey(secretKey, IDP_REFRESH_TOKEN_PURPOSE);
}

/** The refresh token encrypted for the `idp_refresh_token` column. */
export function sealRefreshToken(deps: AppDeps, token: string): string {
  return encryptString(refreshTokenKey(deps), token);
}

/**
 * The refresh token in a sealed column value, or null when it cannot be decrypted: the secret
 * key changed, or the value is damaged. The error is logged without the value or the cause.
 */
export function openRefreshToken(deps: AppDeps, sealed: string): string | null {
  try {
    return decryptString(refreshTokenKey(deps), sealed);
  } catch {
    deps.logger.error('A stored IdP refresh token could not be decrypted');
    return null;
  }
}

export interface OidcUpsertResult {
  user: UserRow;
  /** This sign-in created the row. */
  created: boolean;
  /** The user's effective role, with the IdP's answer, is admin or member. */
  admitted: boolean;
  /** The user had been disabled as removed at the IdP, and this sign-in lifted that. */
  reenabled: boolean;
}

type IdentityColumns = Pick<
  UserRow,
  'email' | 'email_verified' | 'name' | 'avatar_url' | 'idp_role' | 'idp_checked_at'
>;
type SignInChanges = IdentityColumns &
  Partial<Pick<UserRow, 'idp_refresh_token' | 'disabled_at' | 'disabled_reason'>>;

/** What the IdP says about the user, as column values, checked as of now. */
function identityColumns(deps: AppDeps, identity: OidcIdentity): IdentityColumns {
  return {
    email: identity.email,
    email_verified: identity.emailVerified ? 1 : 0,
    name: identity.name,
    avatar_url: identity.avatarUrl,
    idp_role: mapIdpRole(accessPolicy(deps.config), identity),
    idp_checked_at: deps.clock.now(),
  };
}

/**
 * Records a sign-in of `identity` at `issuer`: creates the user on first sign-in, keyed by issuer
 * and subject only (never linked by email), then updates the identity fields and the check time.
 * An admitted user keeps `refreshToken` sealed, or the stored one when the IdP sent none; a
 * denied one keeps none. An admitted user who was disabled as removed at the IdP is enabled
 * again. `role_override` is read, never written.
 */
export async function upsertOidcUser(
  deps: AppDeps,
  p: { issuer: string; identity: OidcIdentity; refreshToken: string | null },
): Promise<OidcUpsertResult> {
  const { db } = deps.db;
  const candidateId = newId('usr');
  // A bare row first, so two first sign-ins racing end on the same row, whoever wins.
  await db
    .insertInto('users')
    .values({
      id: candidateId,
      kind: 'oidc',
      oidc_issuer: p.issuer,
      oidc_subject: p.identity.subject,
      email_verified: 0,
      created_at: deps.clock.now(),
    })
    .onConflict((oc) => oc.columns(['oidc_issuer', 'oidc_subject']).doNothing())
    .execute();
  const row = await db
    .selectFrom('users')
    .selectAll()
    .where('oidc_issuer', '=', p.issuer)
    .where('oidc_subject', '=', p.identity.subject)
    .executeTakeFirstOrThrow();

  const identity = identityColumns(deps, p.identity);
  const role = effectiveRole({ ...row, idp_role: identity.idp_role });
  const admitted = role === 'admin' || role === 'member';
  const reenabled = admitted && row.disabled_reason === 'idp_removed';

  const changes: SignInChanges = { ...identity };
  // Without a new token the stored one stays as it is, rather than written back from `row`.
  if (!admitted) changes.idp_refresh_token = null;
  else if (p.refreshToken !== null) {
    changes.idp_refresh_token = sealRefreshToken(deps, p.refreshToken);
  }
  if (reenabled) {
    changes.disabled_at = null;
    changes.disabled_reason = null;
  }
  await db.updateTable('users').set(changes).where('id', '=', row.id).execute();

  return {
    user: { ...row, ...changes },
    created: row.id === candidateId,
    admitted,
    reenabled,
  };
}

/** Writes what the IdP now says about the user and the check time; returns the updated row. */
export async function applyIdentity(
  deps: AppDeps,
  userId: string,
  identity: OidcIdentity,
): Promise<UserRow> {
  await deps.db.db
    .updateTable('users')
    .set(identityColumns(deps, identity))
    .where('id', '=', userId)
    .execute();
  return deps.db.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
}
