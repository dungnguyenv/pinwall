import { api } from './client.ts';
import {
  CeremonyOptions,
  Me,
  type PasskeySignInRequest,
  type SetupPasskeyOptionsRequest,
  type SetupRequest,
} from './dto.ts';

/*
 * Setup and owner sign-in. These calls happen before there is a session, so
 * a 401 here is an answer for the form (a wrong password, a passkey that did
 * not verify), never a session that ended: none of them redirect on 401.
 */

/** Resolves when the setup link works; rejects with the server's 403 or 409 (`setup_done`). */
export function checkSetupToken(token: string): Promise<void> {
  return api('/auth/setup/check', { method: 'POST', body: { token }, redirectOn401: false });
}

/** Begins registering the owner's first passkey. */
export function setupPasskeyOptions(body: SetupPasskeyOptionsRequest): Promise<CeremonyOptions> {
  return api('/auth/setup/passkey/options', {
    method: 'POST',
    body,
    schema: CeremonyOptions,
    redirectOn401: false,
  });
}

/** Creates the owner account and signs it in. */
export function completeSetup(body: SetupRequest): Promise<Me> {
  return api('/auth/setup', { method: 'POST', body, schema: Me, redirectOn401: false });
}

export function signInWithPassword(password: string): Promise<Me> {
  return api('/auth/password/sign-in', {
    method: 'POST',
    body: { password },
    schema: Me,
    redirectOn401: false,
  });
}

/** Begins a passkey sign-in for any of the owner's passkeys. */
export function passkeySignInOptions(): Promise<CeremonyOptions> {
  return api('/auth/passkey/options', {
    method: 'POST',
    schema: CeremonyOptions,
    redirectOn401: false,
  });
}

export function signInWithPasskey(body: PasskeySignInRequest): Promise<Me> {
  return api('/auth/passkey/sign-in', {
    method: 'POST',
    body,
    schema: Me,
    redirectOn401: false,
  });
}
