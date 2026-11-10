import { expect, test } from 'vitest';
import { hashSecret, newContentToken, newId, newSecret } from '../../src/lib/ids.ts';

test('ids carry their prefix and 20 base32 chars', () => {
  expect(newId('art')).toMatch(/^art_[0-9a-hjkmnp-tv-z]{20}$/);
  expect(new Set(Array.from({ length: 1000 }, () => newId('art'))).size).toBe(1000);
});

test('every prefix is accepted', () => {
  for (const prefix of [
    'usr',
    'prj',
    'art',
    'ver',
    'cmt',
    'shr',
    'tok',
    'cli',
    'pky',
    'gnt',
  ] as const) {
    expect(newId(prefix).startsWith(`${prefix}_`)).toBe(true);
  }
});

test('content tokens are valid DNS labels', () => {
  expect(newContentToken()).toMatch(/^[0-9a-hjkmnp-tv-z]{32}$/);
});

test('secrets are 43 base64url chars and hash to 64 hex', () => {
  const s = newSecret();
  expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(hashSecret(s)).toMatch(/^[0-9a-f]{64}$/);
});

test('hashSecret is the SHA-256 of the secret', () => {
  expect(hashSecret('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
