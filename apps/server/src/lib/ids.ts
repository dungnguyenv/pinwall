import { createHash, randomBytes } from 'node:crypto';

export type IdPrefix =
  | 'usr'
  | 'prj'
  | 'art'
  | 'ver'
  | 'cmt'
  | 'shr'
  | 'tok'
  | 'cli'
  | 'pky'
  | 'gnt';

/** Lowercase Crockford base32: no i, l, o or u, so ids read unambiguously and are valid DNS labels. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Encodes `bytes` as base32, five bits per character, truncating to the first `chars` characters. */
function base32(bytes: Uint8Array, chars: number): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** `<prefix>_` followed by 100 random bits as 20 base32 characters. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${base32(randomBytes(13), 20)}`;
}

/** 160 random bits as 32 base32 characters: a valid DNS label for per-artifact content hosts. */
export function newContentToken(): string {
  return base32(randomBytes(20), 32);
}

/** 256 random bits as 43 base64url characters, for bearer secrets. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest. Secrets are stored only in this form. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
