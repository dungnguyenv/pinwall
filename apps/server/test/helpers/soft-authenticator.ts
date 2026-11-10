import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

/** The CBOR values this authenticator writes: the attestation object and a COSE key. */
type CborValue = number | string | Uint8Array | Map<CborValue, CborValue>;

const CBOR_UNSIGNED = 0;
const CBOR_NEGATIVE = 1;
const CBOR_BYTES = 2;
const CBOR_TEXT = 3;
const CBOR_MAP = 5;

/** The initial byte (major type in the top three bits) plus the argument in the fewest bytes. */
function cborHead(major: number, argument: number): Buffer {
  if (!Number.isSafeInteger(argument) || argument < 0 || argument > 0xffff_ffff) {
    throw new RangeError(`CBOR argument out of range: ${argument}`);
  }
  const type = major << 5;
  if (argument < 24) return Buffer.from([type | argument]);
  if (argument <= 0xff) return Buffer.from([type | 0x18, argument]);
  if (argument <= 0xffff) {
    const head = Buffer.alloc(3);
    head[0] = type | 0x19;
    head.writeUInt16BE(argument, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = type | 0x1a;
  head.writeUInt32BE(argument, 1);
  return head;
}

/** Encodes `value` as CBOR (RFC 8949); map entries keep their insertion order. */
function cbor(value: CborValue): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(CBOR_UNSIGNED, value) : cborHead(CBOR_NEGATIVE, -1 - value);
  }
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(CBOR_TEXT, text.length), text]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborHead(CBOR_BYTES, value.length), value]);
  }
  const parts = [cborHead(CBOR_MAP, value.size)];
  for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
  return Buffer.concat(parts);
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

/** COSE algorithm ES256 and the COSE key labels/values it needs (RFC 9053). */
const COSE_ES256 = -7;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

interface HeldCredential {
  id: string;
  /** base64url `user.id` from the registration options. */
  userHandle: string;
  signCount: number;
}

/**
 * A software passkey for tests: an ES256 key pair per credential, "none" attestation, a sign
 * counter, and the response JSON a browser would hand to the server. It behaves like a platform
 * authenticator holding discoverable credentials; it does not check the RP ID it is asked for.
 */
export class SoftAuthenticator {
  private readonly origin: string;
  private readonly uv: boolean;
  private readonly held: HeldCredential[] = [];
  private readonly keys = new Map<string, KeyObject>();

  constructor(opts: { origin: string; uv?: boolean }) {
    this.origin = opts.origin;
    this.uv = opts.uv ?? true;
  }

  /** The credentials created so far, oldest first. `signCount` moves with each assertion. */
  get credentials(): ReadonlyArray<{ id: string; userHandle: string; signCount: number }> {
    return this.held;
  }

  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    o: { origin?: string } = {},
  ): RegistrationResponseJSON {
    if (!options.pubKeyCredParams.some((param) => param.alg === COSE_ES256)) {
      throw new Error('NotSupportedError: the relying party does not accept ES256');
    }
    if (options.excludeCredentials?.some((credential) => this.keys.has(credential.id))) {
      throw new Error('InvalidStateError: this authenticator already holds an excluded credential');
    }
    const origin = o.origin ?? this.origin;
    const rpId = options.rp.id ?? new URL(origin).hostname;

    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    if (!jwk.x || !jwk.y) throw new Error('The P-256 public key has no coordinates');
    const coseKey = cbor(
      new Map<CborValue, CborValue>([
        [1, COSE_KTY_EC2],
        [3, COSE_ES256],
        [-1, COSE_CRV_P256],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );

    const credentialId = randomBytes(16);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([
      this.authDataHeader(rpId, FLAG_AT, 0),
      Buffer.alloc(16), // AAGUID: all zeros, as for "none" attestation
      idLength,
      credentialId,
      coseKey,
    ]);
    const attestationObject = cbor(
      new Map<CborValue, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );

    const id = credentialId.toString('base64url');
    this.keys.set(id, privateKey);
    this.held.push({ id, userHandle: options.user.id, signCount: 0 });
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: clientData('webauthn.create', options.challenge, origin),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
    o: { origin?: string; credentialId?: string } = {},
  ): AuthenticationResponseJSON {
    const credential = this.pick(options, o.credentialId);
    const privateKey = this.keys.get(credential.id);
    if (!privateKey) throw new Error('NotAllowedError: no key for this credential');
    const origin = o.origin ?? this.origin;
    const rpId = options.rpId ?? new URL(origin).hostname;

    credential.signCount += 1;
    const authData = this.authDataHeader(rpId, 0, credential.signCount);
    const clientDataJSON = clientData('webauthn.get', options.challenge, origin);
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, 'base64url'))]),
      privateKey,
    );
    return {
      id: credential.id,
      rawId: credential.id,
      type: 'public-key',
      response: {
        clientDataJSON,
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** The credential asked for, else the first held one the RP allows, else the first held. */
  private pick(options: PublicKeyCredentialRequestOptionsJSON, wanted?: string): HeldCredential {
    const byId = (id: string) => this.held.find((credential) => credential.id === id);
    if (wanted !== undefined) {
      const credential = byId(wanted);
      if (!credential) throw new Error(`NotAllowedError: no credential ${wanted}`);
      return credential;
    }
    for (const allowed of options.allowCredentials ?? []) {
      const credential = byId(allowed.id);
      if (credential) return credential;
    }
    const first = this.held[0];
    if (!first) throw new Error('NotAllowedError: this authenticator holds no credentials');
    return first;
  }

  /** RP ID hash ‖ flags ‖ big-endian sign count: the 37 bytes every authData starts with. */
  private authDataHeader(rpId: string, extraFlags: number, signCount: number): Buffer {
    const flags = FLAG_UP | (this.uv ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | extraFlags;
    const tail = Buffer.alloc(5);
    tail[0] = flags;
    tail.writeUInt32BE(signCount, 1);
    return Buffer.concat([sha256(rpId), tail]);
  }
}

/** base64url of the client data JSON a browser builds for a ceremony. */
function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString(
    'base64url',
  );
}
