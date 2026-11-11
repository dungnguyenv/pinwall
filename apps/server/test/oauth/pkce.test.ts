import { expect, test } from 'vitest';
import { isValidPkceString, s256, verifyPkce } from '../../src/oauth/pkce.ts';

// RFC 7636 Appendix B.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

test('the RFC 7636 example pair verifies', () => {
  expect(s256(VERIFIER)).toBe(CHALLENGE);
  expect(verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
});

test('a one-character change does not verify', () => {
  expect(verifyPkce(`${VERIFIER.slice(0, -1)}j`, CHALLENGE)).toBe(false);
  expect(verifyPkce(VERIFIER, `${CHALLENGE.slice(0, -1)}d`)).toBe(false);
});

test('a verifier outside the RFC 7636 alphabet or length never verifies', () => {
  const short = 'a'.repeat(42);
  expect(verifyPkce(short, s256(short))).toBe(false);
  const plus = `${'a'.repeat(42)}+`;
  expect(verifyPkce(plus, s256(plus))).toBe(false);
});

test('PKCE strings are 43 to 128 unreserved characters', () => {
  expect(isValidPkceString('a'.repeat(43))).toBe(true);
  expect(isValidPkceString('a'.repeat(128))).toBe(true);
  expect(isValidPkceString(`${'A'.repeat(39)}0._~-`)).toBe(true);
  expect(isValidPkceString('a'.repeat(42))).toBe(false);
  expect(isValidPkceString('a'.repeat(129))).toBe(false);
  expect(isValidPkceString(`${'a'.repeat(42)}+`)).toBe(false);
  expect(isValidPkceString(`${'a'.repeat(42)}=`)).toBe(false);
  expect(isValidPkceString('')).toBe(false);
});
