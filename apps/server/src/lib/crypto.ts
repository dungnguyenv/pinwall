import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

const ENCRYPTION_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Derives a 32-byte key for one purpose from the instance secret (HKDF-SHA256). */
export function deriveKey(secret: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `pinwall:${purpose}`, 32));
}

/** AES-256-GCM. Output is `v1.<iv>.<ciphertext>.<tag>`, each part base64url. */
export function encryptString(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/** Reverses `encryptString`. Throws when the payload is malformed, tampered with, or the key is wrong. */
export function decryptString(key: Buffer, payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) {
    throw new Error('Unsupported ciphertext format');
  }
  const [, ivPart = '', ciphertextPart = '', tagPart = ''] = parts;
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed ciphertext');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_KEY_BYTES = 32;
/** Upper bounds accepted when reading parameters back from a stored hash. */
const SCRYPT_MAX = { n: 2 ** 20, r: 32, p: 16 };

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // scrypt needs 128 * N * r bytes; allow headroom over Node's default 32 MiB cap.
    scrypt(password, salt, keyLength, { N: n, r, p, maxmem: 256 * n * r }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** scrypt (N=2^15, r=8, p=1) with a random 16-byte salt: `scrypt$N$r$p$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveScrypt(password, salt, SCRYPT_KEY_BYTES, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Checks a password against a `hashPassword` result in constant time. Malformed hashes never verify. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nText = '', rText = '', pText = '', saltText = '', hashText = ''] = parts;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  const validParams =
    Number.isInteger(n) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    n >= 2 &&
    (n & (n - 1)) === 0 &&
    n <= SCRYPT_MAX.n &&
    r >= 1 &&
    r <= SCRYPT_MAX.r &&
    p >= 1 &&
    p <= SCRYPT_MAX.p;
  if (!validParams) return false;
  const salt = Buffer.from(saltText, 'base64url');
  const expected = Buffer.from(hashText, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await deriveScrypt(password, salt, expected.length, n, r, p);
  return timingSafeEqual(actual, expected);
}

/** Constant-time string comparison that does not leak length differences. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
