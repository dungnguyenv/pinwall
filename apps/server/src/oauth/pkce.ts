import { createHash } from 'node:crypto';
import { safeEqual } from '../lib/crypto.ts';

/** A code verifier or S256 challenge (RFC 7636 §4.1–4.2): 43 to 128 unreserved characters. */
const PKCE_STRING = /^[A-Za-z0-9._~-]{43,128}$/;

export function isValidPkceString(s: string): boolean {
  return PKCE_STRING.test(s);
}

/** The S256 challenge of `verifier`: base64url of its SHA-256, without padding. */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Whether `verifier` is well formed and its S256 challenge is `challenge`, in constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  return isValidPkceString(verifier) && safeEqual(s256(verifier), challenge);
}
