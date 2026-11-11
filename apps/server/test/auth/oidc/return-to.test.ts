import { expect, test } from 'vitest';
import { safeReturnTo } from '../../../src/auth/oidc/return-to.ts';

const o = 'https://pinwall.test';

test('keeps same-origin paths', () => {
  expect(safeReturnTo('/projects/p1?tab=a#c', o)).toBe('/projects/p1?tab=a#c');
  expect(safeReturnTo('/a/art_1/v/2', o)).toBe('/a/art_1/v/2');
  expect(safeReturnTo('/', o)).toBe('/');
  expect(safeReturnTo(`/${'x'.repeat(2047)}`, o)).toHaveLength(2048);
});

test('everything else falls back to /', () => {
  for (const raw of [
    undefined,
    null,
    '',
    'projects',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    'https://evil.example/',
    'https://pinwall.test/x',
    'javascript:alert(1)',
    '/auth/oidc/start?return_to=/',
    '/auth/oidc/callback',
    `/${'x'.repeat(2048)}`,
  ])
    expect(safeReturnTo(raw, o)).toBe('/');
});

test('control characters anywhere are refused', () => {
  for (const raw of ['/a\x00b', '/a\rb', '/a\x1fb', '/a\x7fb', '/a?x=\x01', '/a#\x1b'])
    expect(safeReturnTo(raw, o)).toBe('/');
});

test('paths that normalize into /auth/oidc/ are refused', () => {
  for (const raw of [
    '/./auth/oidc/start',
    '/x/../auth/oidc/callback',
    '/%61uth/oidc/start',
    '/AUTH/OIDC/start',
    '/auth/oidc/',
  ])
    expect(safeReturnTo(raw, o)).toBe('/');
  expect(safeReturnTo('/auth/oidcx', o)).toBe('/auth/oidcx');
});

test('the result is the normalized path, never longer than 2048 characters', () => {
  expect(safeReturnTo('/a/./b/../c?q=1', o)).toBe('/a/c?q=1');
  expect(safeReturnTo('/é', o)).toBe('/%C3%A9');
  expect(safeReturnTo(`/${'é'.repeat(1000)}`, o)).toBe('/');
});
