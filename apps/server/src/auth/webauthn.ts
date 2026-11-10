import { isIP } from 'node:net';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Config } from '../config/types.ts';
import type { PasskeyRow } from '../db/schema.ts';
import type { AppDeps } from '../deps.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import { newSecret } from '../lib/ids.ts';
import { findPasskeyByCredentialId, recordPasskeyUse } from './passkeys.ts';

export const RP_NAME = 'Pinwall';
/** How long a begun ceremony can be finished; also the timeout the browser is given. */
export const CEREMONY_TTL_MS = 300_000;
/** COSE algorithms offered and accepted: EdDSA, ES256, RS256. */
export const SUPPORTED_ALGORITHM_IDS = [-8, -7, -257];

/** RP ID and expected origin, from the public origin only (never from the request). */
export function relyingParty(config: Config): { rpID: string; origin: string } {
  return { rpID: new URL(config.publicOrigin).hostname, origin: config.publicOrigin };
}

/**
 * Browsers offer WebAuthn only in a secure context and never for an IP address as RP ID: so
 * https with a hostname, or plain http on localhost and its subdomains.
 */
export function passkeysAvailable(config: Config): boolean {
  const hostname = new URL(config.publicOrigin).hostname;
  if (isIP(hostname.replace(/^\[(.*)\]$/, '$1')) !== 0) return false;
  return config.publicHttps || hostname === 'localhost' || hostname.endsWith('.localhost');
}

/** `setup` creates the owner's first passkey; `add` adds one for a signed-in user. */
export type RegistrationPurpose = 'setup' | 'add';

/** A verified new passkey, ready to store. `publicKey` is the COSE key in base64url. */
export interface PasskeyRegistration {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

type Ceremony =
  | { type: 'registration'; purpose: RegistrationPurpose; challenge: string; userId: string }
  | { type: 'authentication'; challenge: string };

const ceremonyKey = (ceremonyId: string) => `webauthn:${ceremonyId}`;

function assertAvailable(config: Config): void {
  if (!passkeysAvailable(config)) throw badRequest(t('auth.passkeysUnavailable'));
}

async function startCeremony(deps: AppDeps, ceremony: Ceremony): Promise<string> {
  const ceremonyId = newSecret();
  await deps.oneTime.put(ceremonyKey(ceremonyId), ceremony, CEREMONY_TTL_MS);
  return ceremonyId;
}

/**
 * Every failure gives the caller the same error. The reason is logged, so an operator can tell
 * a wrong origin from an expired ceremony.
 */
function passkeyFailed(deps: AppDeps, reason: string, err?: unknown): AppError {
  deps.logger.info({ reason, ...(err === undefined ? {} : { err }) }, 'A passkey was not accepted');
  return new AppError('invalid_credentials', 401, t('auth.passkeyFailed'));
}

export async function beginRegistration(
  deps: AppDeps,
  p: {
    purpose: RegistrationPurpose;
    userId: string;
    userName: string;
    displayName: string;
    exclude: { credentialId: string; transports: string[] }[];
  },
): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  assertAvailable(deps.config);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: relyingParty(deps.config).rpID,
    userID: new TextEncoder().encode(p.userId),
    userName: p.userName,
    userDisplayName: p.displayName,
    timeout: CEREMONY_TTL_MS,
    attestationType: 'none',
    excludeCredentials: p.exclude.map((c) => ({ id: c.credentialId, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
  });
  const ceremonyId = await startCeremony(deps, {
    type: 'registration',
    purpose: p.purpose,
    challenge: options.challenge,
    userId: p.userId,
  });
  return { ceremonyId, options };
}

/**
 * Verifies a new passkey; storing it is the caller's job. `userId` is the signed-in user and is
 * required for `add`, where it must be the user the ceremony began for.
 */
export async function finishRegistration(
  deps: AppDeps,
  p: {
    purpose: RegistrationPurpose;
    ceremonyId: string;
    response: RegistrationResponseJSON;
    userId?: string;
  },
): Promise<PasskeyRegistration> {
  // Taken before verifying, so a ceremony finishes once whatever the outcome.
  const ceremony = await deps.oneTime.take<Ceremony>(ceremonyKey(p.ceremonyId));
  if (ceremony?.type !== 'registration' || ceremony.purpose !== p.purpose) {
    throw passkeyFailed(deps, 'No registration ceremony of this purpose is open');
  }
  if ((ceremony.purpose === 'add' || p.userId !== undefined) && p.userId !== ceremony.userId) {
    throw passkeyFailed(deps, 'The registration ceremony was begun for another user');
  }

  const { rpID, origin } = relyingParty(deps.config);
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: p.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
  } catch (err) {
    throw passkeyFailed(deps, 'The registration response was rejected', err);
  }
  if (!verification.verified) {
    throw passkeyFailed(deps, 'The attestation did not verify');
  }

  const { credential } = verification.registrationInfo;
  // Transports are whatever the browser reported; keep only strings.
  const transports: unknown = credential.transports;
  return {
    userId: ceremony.userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: Array.isArray(transports)
      ? transports.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

/** Discoverable passkeys only: no `allowCredentials`, the authenticator offers what it holds. */
export async function beginAuthentication(
  deps: AppDeps,
): Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  assertAvailable(deps.config);
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(deps.config).rpID,
    userVerification: 'required',
    timeout: CEREMONY_TTL_MS,
  });
  const ceremonyId = await startCeremony(deps, {
    type: 'authentication',
    challenge: options.challenge,
  });
  return { ceremonyId, options };
}

/** Verifies an assertion against the stored passkey and records the use (counter, time). */
export async function finishAuthentication(
  deps: AppDeps,
  p: { ceremonyId: string; response: AuthenticationResponseJSON },
): Promise<{ passkey: PasskeyRow; newCounter: number }> {
  // Taken before verifying, so a ceremony finishes once whatever the outcome.
  const ceremony = await deps.oneTime.take<Ceremony>(ceremonyKey(p.ceremonyId));
  if (ceremony?.type !== 'authentication') {
    throw passkeyFailed(deps, 'No authentication ceremony is open');
  }

  // The response comes from the browser: guard the fields read before the library checks it.
  const credentialId: unknown = p.response?.id;
  const passkey =
    typeof credentialId === 'string'
      ? await findPasskeyByCredentialId(deps.db.db, credentialId)
      : undefined;
  if (!passkey) {
    throw passkeyFailed(deps, 'The credential is not a stored passkey');
  }
  const userHandle: unknown = p.response.response?.userHandle;
  if (
    typeof userHandle !== 'string' ||
    Buffer.from(userHandle, 'base64url').toString('utf8') !== passkey.user_id
  ) {
    throw passkeyFailed(deps, 'The user handle does not name the passkey owner');
  }

  const { rpID, origin } = relyingParty(deps.config);
  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: p.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, 'base64url'),
        counter: passkey.counter,
      },
      requireUserVerification: true,
    });
  } catch (err) {
    throw passkeyFailed(deps, 'The assertion was rejected', err);
  }
  if (!verification.verified) {
    throw passkeyFailed(deps, 'The assertion signature did not verify');
  }

  const newCounter = verification.authenticationInfo.newCounter;
  const now = deps.clock.now();
  await recordPasskeyUse(deps.db.db, passkey.id, newCounter, now);
  return { passkey: { ...passkey, counter: newCounter, last_used_at: now }, newCounter };
}
