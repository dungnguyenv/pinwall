import { expect, test } from 'vitest';
import {
  chooseAccountFrom,
  isServerRoute,
  oidcStartPath,
  returnToFrom,
  safeReturnTo,
  signInPath,
} from './return-to.ts';

test.each([
  ['/projects/p1?x=1#h', '/projects/p1?x=1#h'],
  ['//evil.example', '/'],
  ['/\\evil.example', '/'],
  ['https://evil.example', '/'],
  ['/\t/evil', '/'],
  ['javascript:alert(1)', '/'],
  ['/auth/oidc/start?return_to=/', '/'],
  ['/signin?return_to=/x', '/'],
  ['/setup?token=x', '/'],
  [`/${'x'.repeat(2048)}`, '/'],
  [null, '/'],
  ['', '/'],
])('safeReturnTo(%j) = %j', (raw, out) => expect(safeReturnTo(raw)).toBe(out));

test.each([
  // Dot segments that normalize into a protocol-relative URL.
  ['/.//evil.example', '/'],
  // Sign-in routes however they are spelled, so sign-in never loops.
  ['/SignIn', '/'],
  ['/signin/', '/'],
  ['/%73ignin', '/'],
  ['/Auth/OIDC/callback', '/'],
  // Look-alikes of blocked routes are ordinary pages.
  ['/signing-sheet', '/signing-sheet'],
  ['/', '/'],
])('safeReturnTo(%j) = %j', (raw, out) => expect(safeReturnTo(raw)).toBe(out));

test('next is read when return_to is absent', () => {
  expect(returnToFrom(new URLSearchParams('next=%2Fa%2Fart_1%2Fraw'))).toBe('/a/art_1/raw');
  expect(returnToFrom(new URLSearchParams('return_to=%2Fsettings&next=%2Fa%2Fart_1%2Fraw'))).toBe(
    '/settings',
  );
  expect(returnToFrom(new URLSearchParams('return_to=https%3A%2F%2Fevil.example'))).toBe('/');
  expect(returnToFrom(new URLSearchParams())).toBe('/');
});

test('sign-in and OIDC links carry the return path', () => {
  expect(signInPath('/projects/p1?view=list')).toBe(
    '/signin?return_to=%2Fprojects%2Fp1%3Fview%3Dlist',
  );
  expect(oidcStartPath('/a/art_1#c')).toBe('/auth/oidc/start?return_to=%2Fa%2Fart_1%23c');
  expect(oidcStartPath('/', true)).toBe('/auth/oidc/start?return_to=%2F&prompt=select_account');
});

test('a sign-in link can ask to choose another account', () => {
  expect(signInPath('/oauth/consent?request=req_1', { chooseAccount: true })).toBe(
    '/signin?return_to=%2Foauth%2Fconsent%3Frequest%3Dreq_1&choose_account=1',
  );
  expect(signInPath('/x', { chooseAccount: false })).toBe('/signin?return_to=%2Fx');
  expect(chooseAccountFrom(new URLSearchParams('return_to=%2F&choose_account=1'))).toBe(true);
  // Only the exact value counts, so a stray or hostile query asks for nothing.
  for (const query of ['', 'choose_account=0', 'choose_account=true', 'choose_account=']) {
    expect(chooseAccountFrom(new URLSearchParams(query))).toBe(false);
  }
});

test('server routes need a full navigation', () => {
  for (const path of [
    '/a/art_1/raw',
    '/a/art_1/v/2/raw',
    '/oauth/authorize?x',
    '/api/v1/me',
    '/auth/oidc/start?return_to=%2F',
    '/upload/tok',
    '/c/grant/index.html',
    '/mcp',
    '/.well-known/oauth-authorization-server',
  ]) {
    expect(isServerRoute(path), path).toBe(true);
  }
  for (const path of [
    '/a/art_1',
    '/a/art_1/v/2',
    '/oauth/consent?request=r',
    '/',
    '/projects/p1',
    '/signin?return_to=%2Fa%2Fart_1%2Fraw',
    '/settings/raw',
    '/mcp-notes',
  ]) {
    expect(isServerRoute(path), path).toBe(false);
  }
});
