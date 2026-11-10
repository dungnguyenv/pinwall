import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  CeremonyOptions,
  ErrorBody,
  Label,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasskeyAuthenticationResponse,
  PasskeyRegistrationResponse,
  PasskeySignInRequest,
  PasswordSignInRequest,
  page,
  SetupPasskeyOptionsRequest,
  SetupRequest,
  SetupTokenRequest,
  Timestamp,
} from '../src/index.ts';

test('Label trims and keeps 1 to 100 characters', () => {
  expect(Label.parse('  Laptop  ')).toBe('Laptop');
  expect(Label.safeParse('   ').success).toBe(false);
  expect(Label.safeParse('x'.repeat(100)).success).toBe(true);
  expect(Label.safeParse('x'.repeat(101)).success).toBe(false);
});

test('Timestamp is a whole number', () => {
  expect(Timestamp.safeParse(1_700_000_000_000).success).toBe(true);
  expect(Timestamp.safeParse(1.5).success).toBe(false);
});

test('page wraps items with a nullable cursor', () => {
  const schema = page(z.object({ id: z.string() }));
  expect(schema.parse({ items: [{ id: 'a' }], next_cursor: null })).toEqual({
    items: [{ id: 'a' }],
    next_cursor: null,
  });
  expect(schema.safeParse({ items: [{ id: 'a' }] }).success).toBe(false);
});

test('ErrorBody has an optional details object', () => {
  expect(ErrorBody.safeParse({ error: { code: 'x', message: 'y' } }).success).toBe(true);
  expect(
    ErrorBody.safeParse({ error: { code: 'x', message: 'y', details: { a: 1 } } }).success,
  ).toBe(true);
});

const registration = {
  id: 'cred',
  rawId: 'cred',
  type: 'public-key',
  response: { clientDataJSON: 'cd', attestationObject: 'ao', transports: ['internal'] },
  authenticatorAttachment: 'platform',
};

test('passkey responses keep unknown fields and default the extension results', () => {
  expect(PasskeyRegistrationResponse.parse(registration)).toEqual({
    ...registration,
    clientExtensionResults: {},
  });
  expect(PasskeyRegistrationResponse.safeParse({ ...registration, type: 'other' }).success).toBe(
    false,
  );
  const assertion = {
    id: 'cred',
    rawId: 'cred',
    type: 'public-key',
    response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig' },
    clientExtensionResults: {},
  };
  expect(PasskeyAuthenticationResponse.safeParse(assertion).success).toBe(true);
  const { signature: _, ...unsigned } = assertion.response;
  expect(
    PasskeyAuthenticationResponse.safeParse({ ...assertion, response: unsigned }).success,
  ).toBe(false);
});

test('ceremony options carry at least a challenge', () => {
  const body = { ceremony_id: 'c', options: { challenge: 'x', rp: { id: 'localhost' } } };
  expect(CeremonyOptions.parse(body)).toEqual(body);
  expect(CeremonyOptions.safeParse({ ceremony_id: 'c', options: {} }).success).toBe(false);
});

test('a setup request needs a token and a name; email, password and passkey are optional', () => {
  expect(SetupRequest.parse({ token: 't', name: ' Ada ' })).toEqual({ token: 't', name: 'Ada' });
  expect(SetupRequest.safeParse({ token: 't', name: 'Ada', email: null }).success).toBe(true);
  expect(SetupRequest.safeParse({ token: 't', name: 'Ada', email: 'not-an-email' }).success).toBe(
    false,
  );
  expect(SetupRequest.safeParse({ token: '', name: 'Ada' }).success).toBe(false);
  expect(SetupRequest.safeParse({ token: 't', name: 'Ada', password: '' }).success).toBe(false);
  const withPasskey = SetupRequest.parse({
    token: 't',
    name: 'Ada',
    passkey: { ceremony_id: 'c', response: registration },
  });
  expect(withPasskey.passkey?.name).toBeUndefined();
  expect(SetupTokenRequest.safeParse({ token: 'x'.repeat(201) }).success).toBe(false);
  expect(SetupPasskeyOptionsRequest.safeParse({ token: 't', name: '' }).success).toBe(false);
});

test('the password limits are 12 to 256 characters', () => {
  expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 256]);
});

test('sign-in requests need a password, or a ceremony id and an assertion', () => {
  expect(PasswordSignInRequest.safeParse({ password: 'x' }).success).toBe(true);
  expect(PasswordSignInRequest.safeParse({ password: '' }).success).toBe(false);
  expect(PasswordSignInRequest.safeParse({ password: 'x'.repeat(1025) }).success).toBe(false);
  const response = {
    id: 'cred',
    rawId: 'cred',
    type: 'public-key',
    response: { clientDataJSON: 'cd', authenticatorData: 'ad', signature: 'sig', userHandle: 'u' },
  };
  expect(PasskeySignInRequest.safeParse({ ceremony_id: 'c', response }).success).toBe(true);
  expect(PasskeySignInRequest.safeParse({ ceremony_id: '', response }).success).toBe(false);
});
