import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type { TFunction } from 'i18next';
import { errorMessage, isApiError } from '../api/client.ts';
import {
  type CeremonyOptions,
  PasskeyAuthenticationResponse,
  PasskeyRegistrationResponse,
  type PublicConfig,
} from '../api/dto.ts';

/**
 * Whether passkeys can work here: the server allows them at its public origin
 * (https or localhost) and this browser has WebAuthn.
 */
export function passkeysUsable(c: PublicConfig): boolean {
  return c.passkeys_available && browserSupportsWebAuthn();
}

/*
 * The server sends standard WebAuthn options JSON; the shared schema checks
 * only the challenge, so the rest is taken as the browser library's type. The
 * browser's answer goes through the shared schema the server validates with,
 * so callers hold exactly the type the API takes.
 */

/** Asks the browser to create a passkey from a ceremony's options. */
export async function createPasskey(
  options: CeremonyOptions['options'],
): Promise<PasskeyRegistrationResponse> {
  const response = await startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  return PasskeyRegistrationResponse.parse(response);
}

/** Asks the browser to sign a ceremony's challenge with one of the owner's passkeys. */
export async function getPasskeyAssertion(
  options: CeremonyOptions['options'],
): Promise<PasskeyAuthenticationResponse> {
  const response = await startAuthentication({
    optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  return PasskeyAuthenticationResponse.parse(response);
}

/**
 * Whether the person closed or dismissed the browser's passkey prompt. Browsers
 * report that, and a timeout, as `NotAllowedError`; a ceremony replaced by a
 * newer one is an `AbortError`. The browser library keeps those names.
 */
export function isPasskeyCancelled(e: unknown): boolean {
  if (!(e instanceof Error || e instanceof DOMException)) return false;
  return e.name === 'NotAllowedError' || e.name === 'AbortError';
}

/**
 * The sentence to show when a passkey ceremony failed: a closed prompt, the
 * server's own message, or a plain line for anything the browser refused.
 */
export function passkeyErrorMessage(e: unknown, t: TFunction, ceremony: 'create' | 'get'): string {
  if (isPasskeyCancelled(e)) return t('web.passkey.cancelled');
  if (isApiError(e)) return errorMessage(e, t);
  return t(ceremony === 'create' ? 'web.passkey.createFailed' : 'web.passkey.getFailed');
}
