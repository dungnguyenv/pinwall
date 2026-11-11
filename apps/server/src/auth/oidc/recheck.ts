import { type Configuration, fetchUserInfo, refreshTokenGrant } from 'openid-client';
import type { Config } from '../../config/types.ts';
import type { UserRow } from '../../db/schema.ts';
import type { AppDeps } from '../../deps.ts';
import { revokeAllCredentials } from '../revoke.ts';
import { effectiveRole } from '../roles.ts';
import { classifyOidcError, type OidcRuntime, oidcErrorCode, oidcRuntime } from './client.ts';
import { identityFromClaims, profileClaimsIn, readClaim } from './identity.ts';
import { accessPolicy, mapIdpRole } from './policy.ts';
import { applyIdentity, openRefreshToken, sealRefreshToken } from './users.ts';

/** How long one re-check holds its user's lease: well beyond its two IdP request timeouts. */
export const RECHECK_LEASE_TTL_MS = 60_000;

/**
 * - `ok`: the IdP still admits the user (or an admin's role override keeps them in);
 * - `removed`: the IdP's fresh claims no longer earn a role, so they were disabled and every
 *   credential was revoked;
 * - `sign_in_required`: the IdP refused the refresh token, or its answer would remove the person
 *   but left out a claim the role rules read. Neither shows the person was removed: a lost
 *   rotation answer, a token lifetime policy or an IdP logout end refresh tokens too, and a
 *   refresh answer may carry fewer claims than a sign-in. Their browser sessions ended and the
 *   refresh token was dropped; API tokens and OAuth grants stay, and the gate refuses them once
 *   the check is due, until the person signs in again;
 * - `transient`: the IdP could not answer, or another process is checking: nothing changed;
 * - `no_refresh_token`: nothing to ask the IdP with;
 * - `skipped`: not a user to re-check (owner, blocked, disabled, missing, another issuer).
 */
export type RecheckOutcome =
  | 'ok'
  | 'removed'
  | 'sign_in_required'
  | 'transient'
  | 'no_refresh_token'
  | 'skipped';

export interface RecheckResult {
  outcome: RecheckOutcome;
  /** The user as the check left them; undefined when there is no such user. */
  user: UserRow | undefined;
}

type CheckableUser = UserRow & { oidc_issuer: string; oidc_subject: string };

/** A re-check answer that is not an openid-client error, named by a fixed code for the log. */
class RecheckClaimsError extends Error {
  override readonly name = 'RecheckClaimsError';

  constructor(readonly code: 'ID_TOKEN_SUBJECT_MISMATCH' | 'NO_CLAIMS' | 'ROLE_CLAIMS_ABSENT') {
    super(`The IdP's answer cannot be used: ${code}`);
  }
}

const leaseName = (userId: string) => `idp-recheck:${userId}`;

const loadUser = (deps: AppDeps, userId: string) =>
  deps.db.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();

/** An IdP user who may still use Pinwall: not blocked by an admin, not disabled. */
const isCheckable = (user: UserRow | undefined): user is CheckableUser =>
  user !== undefined &&
  user.kind === 'oidc' &&
  user.oidc_issuer !== null &&
  user.oidc_subject !== null &&
  user.disabled_at === null &&
  user.role_override !== 'blocked';

const setRefreshToken = (deps: AppDeps, userId: string, sealed: string | null) =>
  deps.db.db
    .updateTable('users')
    .set({ idp_refresh_token: sealed })
    .where('id', '=', userId)
    .execute();

/** Logs a failed check by its class and fixed code only: the error may hold a token. */
function transient(deps: AppDeps, user: UserRow, error: unknown): RecheckResult {
  deps.logger.warn(
    { user_id: user.id, class: classifyOidcError(error), code: oidcErrorCode(error) },
    'idp re-check failed',
  );
  return { outcome: 'transient', user };
}

/**
 * Asks the IdP whether the user still gets in: a refresh-token grant, then the claims of the new
 * ID token overlaid with userinfo. Only claims that no longer earn a role (with no admin
 * override) disable the user; a refused refresh token (`invalid_grant`), or an answer that
 * would remove them but lacks a claim the role rules read, asks them to sign in again; every
 * other failure is transient. Concurrent calls for one user share one check, and a
 * DB lease keeps other processes from checking the same user at the same time, so a rotated
 * refresh token is never spent twice.
 */
export function recheckUser(deps: AppDeps, userId: string): Promise<RecheckResult> {
  if (deps.config.oidc === null) return Promise.resolve({ outcome: 'skipped', user: undefined });
  const runtime = oidcRuntime(deps);
  const running = runtime.inflight.get(userId);
  if (running) return running as Promise<RecheckResult>;
  const check = runRecheck(deps, runtime, userId).finally(() => {
    if (runtime.inflight.get(userId) === check) runtime.inflight.delete(userId);
  });
  runtime.inflight.set(userId, check);
  return check;
}

async function runRecheck(
  deps: AppDeps,
  runtime: OidcRuntime,
  userId: string,
): Promise<RecheckResult> {
  const found = await loadUser(deps, userId);
  if (!isCheckable(found)) return { outcome: 'skipped', user: found };
  if (found.idp_refresh_token === null) return { outcome: 'no_refresh_token', user: found };

  let configuration: Configuration;
  try {
    configuration = await runtime.configuration();
  } catch (error) {
    return transient(deps, found, error);
  }
  // A refresh token goes back only to the issuer that granted it.
  const { issuer } = configuration.serverMetadata();
  if (found.oidc_issuer !== issuer) return { outcome: 'skipped', user: found };

  const lease = leaseName(userId);
  if (!(await deps.leases.acquire(lease, runtime.holder, RECHECK_LEASE_TTL_MS))) {
    return { outcome: 'transient', user: found };
  }
  try {
    // Read again under the lease: a check that just ended elsewhere may have rotated the token.
    const user = await loadUser(deps, userId);
    if (!isCheckable(user) || user.oidc_issuer !== issuer) return { outcome: 'skipped', user };
    return await checkWithIdp(deps, configuration, user);
  } finally {
    await deps.leases.release(lease, runtime.holder).catch((err: unknown) => {
      // The lease runs out by itself; the check's own result stands.
      deps.logger.error({ user_id: userId, err }, 'Could not release an IdP re-check lease');
    });
  }
}

async function checkWithIdp(
  deps: AppDeps,
  configuration: Configuration,
  user: CheckableUser,
): Promise<RecheckResult> {
  const refreshToken =
    user.idp_refresh_token === null ? null : openRefreshToken(deps, user.idp_refresh_token);
  if (refreshToken === null) {
    if (user.idp_refresh_token !== null) await setRefreshToken(deps, user.id, null);
    return { outcome: 'no_refresh_token', user: { ...user, idp_refresh_token: null } };
  }

  let tokens: Awaited<ReturnType<typeof refreshTokenGrant>>;
  try {
    tokens = await refreshTokenGrant(configuration, refreshToken);
  } catch (error) {
    if (classifyOidcError(error) === 'invalid_grant') return requireSignIn(deps, user.id, error);
    return transient(deps, user, error);
  }

  let current: CheckableUser = user;
  if (tokens.refresh_token !== undefined) {
    // Saved before anything else is asked: with rotation the old token is already spent.
    const sealed = sealRefreshToken(deps, tokens.refresh_token);
    await setRefreshToken(deps, user.id, sealed);
    current = { ...user, idp_refresh_token: sealed };
  }

  let claims: Record<string, unknown>;
  try {
    claims = await currentClaims(configuration, tokens, user.oidc_subject);
  } catch (error) {
    return transient(deps, current, error);
  }

  const identity = identityFromClaims(
    { ...claims, sub: user.oidc_subject },
    deps.config.oidc?.rolesClaim,
  );
  // A refresh answer may carry fewer claims than a sign-in (no new ID token, a slimmer userinfo):
  // a role that is missing only for want of a claim the rules read is no proof of removal.
  const idpRole = mapIdpRole(accessPolicy(deps.config), identity);
  if (
    effectiveRole({ ...user, idp_role: idpRole }) === null &&
    lacksRoleClaims(deps.config, claims)
  ) {
    return requireSignIn(deps, user.id, new RecheckClaimsError('ROLE_CLAIMS_ABSENT'));
  }
  const updated = await applyIdentity(deps, user.id, identity, profileClaimsIn(claims));
  const role = effectiveRole(updated);
  if (role === null) return { outcome: 'removed', user: await disableRemovedUser(deps, user.id) };
  // Blocked by an admin while the IdP answered: the admin's decision, not an IdP removal.
  if (role === 'blocked') return { outcome: 'skipped', user: updated };
  return { outcome: 'ok', user: updated };
}

/**
 * What the IdP says about the user now: the refreshed ID token's claims when it sent one,
 * overlaid with userinfo when the IdP has that endpoint. Throws when the answer is about another
 * subject, or holds no claims at all.
 */
async function currentClaims(
  configuration: Configuration,
  tokens: Awaited<ReturnType<typeof refreshTokenGrant>>,
  subject: string,
): Promise<Record<string, unknown>> {
  const idToken = tokens.claims();
  if (idToken !== undefined && idToken.sub !== subject) {
    throw new RecheckClaimsError('ID_TOKEN_SUBJECT_MISMATCH');
  }
  let claims: Record<string, unknown> | undefined = idToken && { ...idToken };
  if (configuration.serverMetadata().userinfo_endpoint !== undefined) {
    // fetchUserInfo checks that the answer is about `subject`.
    const userinfo = await fetchUserInfo(configuration, tokens.access_token, subject);
    claims = { ...claims, ...userinfo };
  }
  if (claims === undefined) throw new RecheckClaimsError('NO_CLAIMS');
  return claims;
}

const isAbsent = (value: unknown) => value === undefined || value === null;

/**
 * Whether `claims` leave out a claim the role rules read: the roles claim when group rules are
 * configured, or the email or its verified flag when email or domain rules are.
 */
function lacksRoleClaims(config: Config, claims: Record<string, unknown>): boolean {
  const policy = accessPolicy(config);
  const rolesClaim = config.oidc?.rolesClaim;
  const groupRules = policy.adminGroups.length > 0 || policy.memberGroups.length > 0;
  if (groupRules && rolesClaim !== undefined && isAbsent(readClaim(claims, rolesClaim))) {
    return true;
  }
  const emailRules =
    policy.adminEmails.length > 0 ||
    policy.memberEmails.length > 0 ||
    policy.memberDomains.length > 0;
  return emailRules && (isAbsent(claims.email) || isAbsent(claims.email_verified));
}

/**
 * Asks the user to sign in again after an IdP answer that cannot decide their access: drops the
 * refresh token and ends their browser sessions, in one transaction. The last good check time
 * stays, so the gate refuses their API tokens and OAuth grants once the check is due; the next
 * admitted sign-in brings them back. Logs the failure by its class and fixed code only.
 */
async function requireSignIn(
  deps: AppDeps,
  userId: string,
  error: unknown,
): Promise<RecheckResult> {
  deps.logger.warn(
    { user_id: userId, class: classifyOidcError(error), code: oidcErrorCode(error) },
    'idp re-check: sign-in required',
  );
  await deps.db.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('users')
      .set({ idp_refresh_token: null })
      .where('id', '=', userId)
      .execute();
    await trx.deleteFrom('sessions').where('user_id', '=', userId).execute();
  });
  return { outcome: 'sign_in_required', user: await loadUser(deps, userId) };
}

/**
 * Disables an IdP user the IdP no longer admits: marks the row first, so every credential is
 * refused from then on even if revoking fails, drops the refresh token, then ends every session,
 * API token and OAuth grant. Returns the updated row. Only `oidc` users can be disabled this way.
 */
export async function disableRemovedUser(deps: AppDeps, userId: string): Promise<UserRow> {
  const result = await deps.db.db
    .updateTable('users')
    .set({ disabled_at: deps.clock.now(), disabled_reason: 'idp_removed', idp_refresh_token: null })
    .where('id', '=', userId)
    .where('kind', '=', 'oidc')
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) throw new Error(`There is no OIDC user ${userId} to disable`);
  await revokeAllCredentials(deps, userId);
  deps.logger.info({ user_id: userId }, 'oidc user removed');
  return deps.db.db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
}
