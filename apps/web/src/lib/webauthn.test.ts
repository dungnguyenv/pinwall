import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../api/client.ts';
import i18n from '../i18n.ts';
import { fx } from '../test/fixtures.ts';
import {
  createPasskey,
  getPasskeyAssertion,
  isPasskeyCancelled,
  passkeyErrorMessage,
  passkeysUsable,
} from './webauthn.ts';

/*
 * The real @simplewebauthn/browser runs here against a fake
 * `navigator.credentials`, the browser's own WebAuthn boundary, so these
 * tests see the errors and JSON the library really produces.
 */

const t = i18n.t;
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const base64url = (text: string): string =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const text = (buffer: unknown): string => new TextDecoder().decode(buffer as ArrayBuffer);

const create = vi.fn();
const get = vi.fn();

beforeEach(() => {
  vi.stubGlobal('PublicKeyCredential', class {});
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { create, get } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'credentials');
  create.mockReset();
  get.mockReset();
});

const creationOptions = {
  challenge: base64url('challenge-1'),
  rp: { name: 'Pinwall', id: 'localhost' },
  user: { id: base64url('usr_1'), name: 'Ada', displayName: 'Ada' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
};

const requestOptions = { challenge: base64url('challenge-2'), rpId: 'localhost' };

test('passkeys are usable when the server allows them and the browser has WebAuthn', () => {
  expect(passkeysUsable(fx.config({ passkeys_available: true }))).toBe(true);
  expect(passkeysUsable(fx.config({ passkeys_available: false }))).toBe(false);
  vi.unstubAllGlobals();
  expect(passkeysUsable(fx.config({ passkeys_available: true }))).toBe(false);
});

test('creating a passkey sends the options and returns JSON the server accepts', async () => {
  create.mockResolvedValue({
    id: 'cred-1',
    rawId: bytes('cred-1'),
    type: 'public-key',
    response: {
      clientDataJSON: bytes('{"type":"webauthn.create"}'),
      attestationObject: bytes('attestation'),
      getTransports: () => ['internal'],
    },
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: 'platform',
  });

  const response = await createPasskey(creationOptions);

  const sent = create.mock.lastCall?.[0] as CredentialCreationOptions | undefined;
  expect(text(sent?.publicKey?.challenge)).toBe('challenge-1');
  expect(sent?.publicKey?.rp).toEqual(creationOptions.rp);
  expect(response).toMatchObject({
    id: 'cred-1',
    rawId: base64url('cred-1'),
    type: 'public-key',
    response: { attestationObject: base64url('attestation'), transports: ['internal'] },
  });
});

test('signing in with a passkey returns an assertion the server accepts', async () => {
  get.mockResolvedValue({
    id: 'cred-1',
    rawId: bytes('cred-1'),
    type: 'public-key',
    response: {
      authenticatorData: bytes('authenticator'),
      clientDataJSON: bytes('{"type":"webauthn.get"}'),
      signature: bytes('signature'),
      userHandle: bytes('usr_1'),
    },
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: 'platform',
  });

  const response = await getPasskeyAssertion(requestOptions);

  const sent = get.mock.lastCall?.[0] as CredentialRequestOptions | undefined;
  expect(text(sent?.publicKey?.challenge)).toBe('challenge-2');
  expect(response).toMatchObject({
    id: 'cred-1',
    response: { signature: base64url('signature'), userHandle: base64url('usr_1') },
  });
});

test('closing the browser prompt counts as cancelled, other failures do not', async () => {
  create.mockRejectedValue(new DOMException('The operation was not allowed.', 'NotAllowedError'));
  const closed = await createPasskey(creationOptions).catch((e: unknown) => e);
  expect(isPasskeyCancelled(closed)).toBe(true);

  get.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
  const aborted = await getPasskeyAssertion(requestOptions).catch((e: unknown) => e);
  expect(isPasskeyCancelled(aborted)).toBe(true);

  create.mockRejectedValue(new DOMException('Already registered.', 'InvalidStateError'));
  const registered = await createPasskey(creationOptions).catch((e: unknown) => e);
  expect(isPasskeyCancelled(registered)).toBe(false);

  expect(isPasskeyCancelled(new DOMException('', 'NotAllowedError'))).toBe(true);
  expect(isPasskeyCancelled(new ApiError(401, 'invalid_credentials', 'No.'))).toBe(false);
  expect(isPasskeyCancelled('NotAllowedError')).toBe(false);
});

test('passkey failures read as one sentence', () => {
  const cancelled = new DOMException('', 'NotAllowedError');
  expect(passkeyErrorMessage(cancelled, t, 'create')).toBe(t('web.passkey.cancelled'));
  expect(passkeyErrorMessage(cancelled, t, 'get')).toBe(t('web.passkey.cancelled'));

  const refused = new ApiError(401, 'invalid_credentials', 'This passkey could not be verified.');
  expect(passkeyErrorMessage(refused, t, 'get')).toBe('This passkey could not be verified.');

  const broken = new DOMException('Already registered.', 'InvalidStateError');
  expect(passkeyErrorMessage(broken, t, 'create')).toBe(t('web.passkey.createFailed'));
  expect(passkeyErrorMessage(broken, t, 'get')).toBe(t('web.passkey.getFailed'));
});
