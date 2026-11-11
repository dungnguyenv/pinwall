import { expect, test } from 'vitest';
import { extractGroups, identityFromClaims, readClaim } from '../../../src/auth/oidc/identity.ts';

test('reads a top-level claim, then a dotted path', () => {
  expect(readClaim({ groups: ['a'] }, 'groups')).toEqual(['a']);
  expect(readClaim({ 'https://example.com/groups': ['a'] }, 'https://example.com/groups')).toEqual([
    'a',
  ]);
  expect(readClaim({ realm_access: { roles: ['r'] } }, 'realm_access.roles')).toEqual(['r']);
  expect(
    readClaim(
      { 'urn:zitadel:iam:org:project:roles': { admin: {} } },
      'urn:zitadel:iam:org:project:roles',
    ),
  ).toEqual({ admin: {} });
  expect(readClaim({}, 'missing.path')).toBeUndefined();
});

test('a dotted path walks only own properties of plain objects', () => {
  expect(readClaim({ realm_access: ['roles'] }, 'realm_access.0')).toBeUndefined();
  expect(readClaim({ a: 'text' }, 'a.length')).toBeUndefined();
  expect(readClaim({}, 'constructor.name')).toBeUndefined();
  expect(readClaim({ a: {} }, 'a.__proto__')).toBeUndefined();
  expect(readClaim({}, 'toString')).toBeUndefined();
});

test('groups from a string, an array or object keys', () => {
  expect(extractGroups('admins')).toEqual(['admins']);
  expect(extractGroups(['admins', 7, '', 'ops', 'admins'])).toEqual(['admins', 'ops']);
  expect(extractGroups({ admin: { '2799': 'org.example' }, member: {} })).toEqual([
    'admin',
    'member',
  ]);
  for (const v of [null, undefined, 42, true, '']) expect(extractGroups(v)).toEqual([]);
});

test('identity from claims normalizes email and verification', () => {
  expect(
    identityFromClaims(
      {
        sub: 's1',
        email: ' Ada@Example.COM ',
        email_verified: 'true',
        name: 'Ada',
        picture: 'https://img.example/a.png',
        groups: ['x'],
      },
      'groups',
    ),
  ).toEqual({
    subject: 's1',
    email: 'ada@example.com',
    emailVerified: true,
    name: 'Ada',
    avatarUrl: 'https://img.example/a.png',
    groups: ['x'],
  });
  expect(
    identityFromClaims({ sub: 's', email_verified: 'yes', groups: ['x'] }, undefined),
  ).toMatchObject({ email: null, emailVerified: false, name: 's', groups: [] });
  expect(
    identityFromClaims({ sub: 's', picture: 'javascript:alert(1)' }, undefined).avatarUrl,
  ).toBeNull();
  expect(
    identityFromClaims({ sub: 's', picture: 'http://img.example/a.png' }, undefined).avatarUrl,
  ).toBeNull();
  expect(identityFromClaims({ sub: 's', preferred_username: 'ada' }, undefined).name).toBe('ada');
  expect(
    identityFromClaims({ sub: 's', given_name: 'Ada', family_name: 'Lovelace' }, undefined).name,
  ).toBe('Ada Lovelace');
  expect(identityFromClaims({ sub: 's', email: 'a@b.example' }, undefined).name).toBe(
    'a@b.example',
  );
  expect(identityFromClaims({ sub: 's', name: 'x'.repeat(300) }, undefined).name).toHaveLength(200);
  expect(() => identityFromClaims({ email: 'a@b.example' }, undefined)).toThrow();
});

test('only true or "true" verifies an email', () => {
  const verified = (v: unknown) =>
    identityFromClaims({ sub: 's', email: 'a@b.example', email_verified: v }, undefined)
      .emailVerified;
  expect(verified(true)).toBe(true);
  expect(verified('true')).toBe(true);
  for (const v of [false, 'false', 'TRUE', 1, 'yes', null, undefined])
    expect(verified(v)).toBe(false);
});

test('an email that is not one, or too long, is dropped', () => {
  const email = (v: unknown) => identityFromClaims({ sub: 's', email: v }, undefined).email;
  expect(email('not an email')).toBeNull();
  expect(email(42)).toBeNull();
  expect(email('')).toBeNull();
  /** A valid address of exactly `length` characters. */
  const ofLength = (length: number) =>
    `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(length - 201)}.example`;
  expect(email(` ${ofLength(254)} `)).toBe(ofLength(254));
  expect(email(ofLength(255))).toBeNull();
});

test('blank name candidates are skipped and the result is trimmed', () => {
  expect(
    identityFromClaims({ sub: 's', name: '   ', preferred_username: '  ada  ' }, undefined).name,
  ).toBe('ada');
  expect(identityFromClaims({ sub: 's', name: 7, family_name: 'Lovelace' }, undefined).name).toBe(
    'Lovelace',
  );
  expect(identityFromClaims({ sub: 's', name: '<b>Ada</b>' }, undefined).name).toBe('<b>Ada</b>');
});

test('the name is cut at 200 characters without splitting one', () => {
  const name = identityFromClaims({ sub: 's', name: `${'x'.repeat(199)}😀😀` }, undefined).name;
  expect([...name]).toHaveLength(200);
  expect(name.endsWith('😀')).toBe(true);
});

test('an avatar must be an https URL of at most 2048 characters', () => {
  const avatar = (v: unknown) => identityFromClaims({ sub: 's', picture: v }, undefined).avatarUrl;
  const long = `https://img.example/${'a'.repeat(2048 - 'https://img.example/'.length)}`;
  expect(avatar(long)).toBe(long);
  expect(avatar(`${long}a`)).toBeNull();
  expect(avatar('not a url')).toBeNull();
  expect(avatar(['https://img.example/a.png'])).toBeNull();
});

test('groups come from the configured claim, including nested and object-valued ones', () => {
  expect(
    identityFromClaims(
      { sub: 's', realm_access: { roles: ['admin', 'user'] } },
      'realm_access.roles',
    ).groups,
  ).toEqual(['admin', 'user']);
  expect(
    identityFromClaims(
      { sub: 's', 'urn:zitadel:iam:org:project:roles': { admin: { '1': 'org' } } },
      'urn:zitadel:iam:org:project:roles',
    ).groups,
  ).toEqual(['admin']);
  expect(identityFromClaims({ sub: 's' }, 'groups').groups).toEqual([]);
});

test('a subject must be a non-empty string', () => {
  expect(() => identityFromClaims({ sub: 42 }, undefined)).toThrow(Error);
  expect(() => identityFromClaims({ sub: '' }, undefined)).toThrow(Error);
});
