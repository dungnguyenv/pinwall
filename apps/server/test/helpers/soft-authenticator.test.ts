import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { expect, test } from 'vitest';
import { SoftAuthenticator } from './soft-authenticator.ts';

const ORIGIN = 'http://localhost:8080';
const RP_ID = 'localhost';
/**
 * Passed explicitly: with the library default, simplewebauthn probes Web Crypto for ML-DSA and
 * Node prints an ExperimentalWarning.
 */
const ALGS = [-8, -7, -257];

/** Registers one credential and returns what a relying party would store for it. */
async function registered(a: SoftAuthenticator): Promise<WebAuthnCredential> {
  const options = await generateRegistrationOptions({
    rpName: 'T',
    rpID: RP_ID,
    userName: 'u',
    attestationType: 'none',
    supportedAlgorithmIDs: ALGS,
  });
  const v = await verifyRegistrationResponse({
    response: a.register(options),
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    supportedAlgorithmIDs: ALGS,
  });
  if (!v.verified) throw new Error('registration did not verify');
  return v.registrationInfo.credential;
}

test('produces a registration simplewebauthn accepts', async () => {
  const a = new SoftAuthenticator({ origin: ORIGIN });
  const options = await generateRegistrationOptions({
    rpName: 'T',
    rpID: RP_ID,
    userName: 'u',
    attestationType: 'none',
    supportedAlgorithmIDs: ALGS,
  });
  const response = a.register(options);
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    supportedAlgorithmIDs: ALGS,
  });
  expect(v.verified).toBe(true);
  expect(v.registrationInfo?.fmt).toBe('none');
  expect(v.registrationInfo?.credential.id).toBe(a.credentials[0]?.id);
  expect(v.registrationInfo?.credential.counter).toBe(0);
  expect(v.registrationInfo?.userVerified).toBe(true);
  expect(response.response.transports).toEqual(['internal']);
  expect(a.credentials[0]?.userHandle).toBe(options.user.id);
});

test('produces assertions that verify and count up', async () => {
  const a = new SoftAuthenticator({ origin: ORIGIN });
  const credential = await registered(a);

  for (const expected of [1, 2]) {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
    });
    const response = a.authenticate(options);
    expect(response.id).toBe(credential.id);
    expect(response.response.userHandle).toBe(a.credentials[0]?.userHandle);
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: options.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential,
    });
    expect(v.verified).toBe(true);
    expect(v.authenticationInfo.newCounter).toBe(expected);
    expect(a.credentials[0]?.signCount).toBe(expected);
    credential.counter = v.authenticationInfo.newCounter;
  }
});

test('picks the credential the relying party allows, or the one asked for', async () => {
  const a = new SoftAuthenticator({ origin: ORIGIN });
  await registered(a);
  await registered(a);
  const [first, second] = a.credentials;
  if (!first || !second) throw new Error('expected two credentials');

  const allowed = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: [{ id: 'bm90LWhlbGQ' }, { id: second.id }],
  });
  expect(a.authenticate(allowed).id).toBe(second.id);

  const any = await generateAuthenticationOptions({ rpID: RP_ID });
  expect(a.authenticate(any).id).toBe(first.id);
  expect(a.authenticate(any, { credentialId: second.id }).id).toBe(second.id);
});

test('honours excludeCredentials', async () => {
  const a = new SoftAuthenticator({ origin: ORIGIN });
  await registered(a);
  const options = await generateRegistrationOptions({
    rpName: 'T',
    rpID: RP_ID,
    userName: 'u',
    attestationType: 'none',
    supportedAlgorithmIDs: ALGS,
    excludeCredentials: [{ id: a.credentials[0]?.id ?? '' }],
  });
  expect(() => a.register(options)).toThrow(/InvalidStateError/);
  expect(a.credentials).toHaveLength(1);
});

test('refuses a registration that does not offer ES256', async () => {
  const a = new SoftAuthenticator({ origin: ORIGIN });
  const options = await generateRegistrationOptions({
    rpName: 'T',
    rpID: RP_ID,
    userName: 'u',
    supportedAlgorithmIDs: [-8, -257],
  });
  expect(() => a.register(options)).toThrow();
});

test('without user verification the UV flag stays clear', async () => {
  const a = new SoftAuthenticator({ origin: ORIGIN, uv: false });
  const options = await generateRegistrationOptions({
    rpName: 'T',
    rpID: RP_ID,
    userName: 'u',
    supportedAlgorithmIDs: ALGS,
  });
  const response = a.register(options);
  const required = verifyRegistrationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    supportedAlgorithmIDs: ALGS,
  });
  await expect(required).rejects.toThrow(/verif/i);
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    supportedAlgorithmIDs: ALGS,
    requireUserVerification: false,
  });
  expect(v.registrationInfo?.userVerified).toBe(false);
});

test('a tampered signature does not verify', async () => {
  const a = new SoftAuthenticator({ origin: ORIGIN });
  const credential = await registered(a);
  const options = await generateAuthenticationOptions({ rpID: RP_ID });
  const response = a.authenticate(options);
  const signature = Buffer.from(response.response.signature, 'base64url');
  const last = signature.length - 1;
  signature[last] = (signature[last] ?? 0) ^ 0x01;
  response.response.signature = signature.toString('base64url');

  const verified = await verifyAuthenticationResponse({
    response,
    expectedChallenge: options.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential,
  }).then(
    (v) => v.verified,
    () => false,
  );
  expect(verified).toBe(false);
});
