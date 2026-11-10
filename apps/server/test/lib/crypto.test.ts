import { expect, test } from 'vitest';
import {
  decryptString,
  deriveKey,
  encryptString,
  hashPassword,
  safeEqual,
  verifyPassword,
} from '../../src/lib/crypto.ts';

test('encrypt round-trips and detects tampering', () => {
  const k = deriveKey(Buffer.alloc(32, 7), 'idp-refresh-token');
  const c = encryptString(k, 'secret');
  expect(decryptString(k, c)).toBe('secret');
  // Replace the last two characters (part of the auth tag), choosing a value that differs from them.
  expect(() => decryptString(k, `${c.slice(0, -2)}${c.endsWith('AA') ? 'Aw' : 'AA'}`)).toThrow();
  const [version, iv, body, tag] = c.split('.');
  const flippedBody = `${body?.startsWith('A') ? 'B' : 'A'}${body?.slice(1)}`;
  expect(() => decryptString(k, [version, iv, flippedBody, tag].join('.'))).toThrow();
  expect(() => decryptString(deriveKey(Buffer.alloc(32, 7), 'other'), c)).toThrow();
});

test('derived keys are 32 bytes, stable per purpose and distinct across purposes', () => {
  const secret = Buffer.alloc(32, 1);
  expect(deriveKey(secret, 'a')).toHaveLength(32);
  expect(deriveKey(secret, 'a').equals(deriveKey(secret, 'a'))).toBe(true);
  expect(deriveKey(secret, 'a').equals(deriveKey(secret, 'b'))).toBe(false);
});

test('ciphertext has the v1.<iv>.<ciphertext>.<tag> shape and a fresh IV each time', () => {
  const k = deriveKey(Buffer.alloc(32, 7), 'x');
  const c = encryptString(k, 'same');
  expect(c).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  expect(encryptString(k, 'same')).not.toBe(c);
  expect(decryptString(k, encryptString(k, ''))).toBe('');
});

test('malformed payloads are rejected', () => {
  const k = deriveKey(Buffer.alloc(32, 7), 'x');
  expect(() => decryptString(k, 'nonsense')).toThrow();
  expect(() => decryptString(k, 'v2.a.b.c')).toThrow();
});

test('passwords verify only with the right password', async () => {
  const h = await hashPassword('correct horse');
  expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
  expect(await verifyPassword('correct horse', h)).toBe(true);
  expect(await verifyPassword('wrong', h)).toBe(false);
});

test('password hashes are salted and malformed hashes never verify', async () => {
  expect(await hashPassword('pw')).not.toBe(await hashPassword('pw'));
  expect(await verifyPassword('pw', 'not-a-hash')).toBe(false);
  expect(await verifyPassword('pw', 'scrypt$32768$8$1$AAAA')).toBe(false);
});

test('safeEqual compares strings in constant time without length errors', () => {
  expect(safeEqual('abc', 'abc')).toBe(true);
  expect(safeEqual('abc', 'abd')).toBe(false);
  expect(safeEqual('abc', 'abcd')).toBe(false);
  expect(safeEqual('', '')).toBe(true);
});
