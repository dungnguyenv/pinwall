import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OidcIdentity } from '../../../src/auth/oidc/identity.ts';
import {
  applyIdentity,
  openRefreshToken,
  sealRefreshToken,
  upsertOidcUser,
} from '../../../src/auth/oidc/users.ts';
import type { RoleOverride } from '../../../src/db/schema.ts';
import type { AppDeps } from '../../../src/deps.ts';
import { FixedClock } from '../../../src/lib/clock.ts';
import { newId } from '../../../src/lib/ids.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dialects } from '../../helpers/db.ts';

const T = Date.UTC(2026, 10, 10);
const ISSUER = 'https://idp.test';

const id = (o: Partial<OidcIdentity> = {}): OidcIdentity => ({
  subject: 's1',
  email: 'ada@example.com',
  emailVerified: true,
  name: 'Ada',
  avatarUrl: null,
  groups: ['pinwall-users'],
  ...o,
});

describe.each(dialects)('OIDC users on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({
      dialect,
      clock,
      env: {
        PINWALL_OIDC_ISSUER: ISSUER,
        PINWALL_OIDC_CLIENT_ID: 'pinwall',
        PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins',
        PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-users',
      },
    });
  });
  afterEach(() => ctx.close());

  const upsert = (identity: OidcIdentity, refreshToken: string | null = 'rt-1', issuer = ISSUER) =>
    upsertOidcUser(ctx.deps, { issuer, identity, refreshToken });
  const row = (userId: string) =>
    ctx.deps.db.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  const users = () => ctx.deps.db.db.selectFrom('users').selectAll().orderBy('id').execute();
  const setColumns = (
    userId: string,
    values: {
      role_override?: RoleOverride | null;
      disabled_at?: number | null;
      disabled_reason?: string | null;
    },
  ) => ctx.deps.db.db.updateTable('users').set(values).where('id', '=', userId).execute();

  test('first sign-in creates an oidc user keyed by issuer and subject', async () => {
    const r = await upsert(id());
    expect(r).toMatchObject({ created: true, admitted: true, reenabled: false });
    expect(r.user).toMatchObject({
      kind: 'oidc',
      oidc_issuer: ISSUER,
      oidc_subject: 's1',
      email: 'ada@example.com',
      email_verified: 1,
      name: 'Ada',
      avatar_url: null,
      idp_role: 'member',
      role_override: null,
      idp_checked_at: clock.now(),
      disabled_at: null,
      disabled_reason: null,
      created_at: clock.now(),
    });
    expect(r.user.id).toMatch(/^usr_/);
    expect(await row(r.user.id)).toEqual(r.user);
  });

  test('a later sign-in updates the same row', async () => {
    const first = await upsert(id());
    clock.advance(60_000);
    const r = await upsert(
      id({
        email: 'ada@new.example',
        name: 'Ada Lovelace',
        avatarUrl: 'https://img.example/ada.png',
        groups: ['pinwall-admins'],
      }),
    );
    expect(r).toMatchObject({ created: false, admitted: true, reenabled: false });
    expect(r.user).toMatchObject({
      id: first.user.id,
      email: 'ada@new.example',
      name: 'Ada Lovelace',
      avatar_url: 'https://img.example/ada.png',
      idp_role: 'admin',
      idp_checked_at: clock.now(),
      created_at: T,
    });
    expect(await row(r.user.id)).toEqual(r.user);
    expect(await users()).toHaveLength(1);
  });

  test('the same subject at another issuer is another user', async () => {
    const a = await upsert(id());
    const b = await upsert(id(), 'rt-1', 'https://other-idp.test');
    expect(b.created).toBe(true);
    expect(b.user.id).not.toBe(a.user.id);
    expect(b.user.oidc_issuer).toBe('https://other-idp.test');
    expect(await users()).toHaveLength(2);
  });

  test('the same email under another subject is not linked', async () => {
    const ownerId = newId('usr');
    await ctx.deps.db.db
      .insertInto('users')
      .values({
        id: ownerId,
        kind: 'owner',
        email: 'ada@example.com',
        email_verified: 1,
        name: 'Owner Ada',
        created_at: T,
      })
      .execute();
    const owner = await row(ownerId);

    const a = await upsert(id({ subject: 's1' }));
    const b = await upsert(id({ subject: 's2' }));
    expect(a.created && b.created).toBe(true);
    expect(b.user.id).not.toBe(a.user.id);
    const oidcRows = (await users()).filter((u) => u.kind === 'oidc');
    expect(oidcRows.map((u) => u.oidc_subject).sort()).toEqual(['s1', 's2']);
    expect(await row(ownerId)).toEqual(owner);
  });

  test('the refresh token is stored sealed', async () => {
    const r = await upsert(id(), 'rt-1');
    const column = (await row(r.user.id)).idp_refresh_token;
    expect(column).not.toBeNull();
    expect(column?.startsWith('v1.')).toBe(true);
    expect(column).not.toContain('rt-1');
    expect(openRefreshToken(ctx.deps, column ?? '')).toBe('rt-1');
  });

  test('a sign-in without a refresh token keeps the stored one', async () => {
    const r = await upsert(id(), 'rt-1');
    await upsert(id(), null);
    expect(openRefreshToken(ctx.deps, (await row(r.user.id)).idp_refresh_token ?? '')).toBe('rt-1');
    await upsert(id(), 'rt-2');
    expect(openRefreshToken(ctx.deps, (await row(r.user.id)).idp_refresh_token ?? '')).toBe('rt-2');
  });

  test('a denied identity is recorded without a refresh token', async () => {
    const first = await upsert(id(), 'rt-1');
    const r = await upsert(id({ groups: ['other'] }), 'rt-2');
    expect(r).toMatchObject({ created: false, admitted: false, reenabled: false });
    expect(r.user).toMatchObject({ id: first.user.id, idp_role: null, idp_refresh_token: null });
    expect(await row(r.user.id)).toEqual(r.user);

    const stranger = await upsert(id({ subject: 's9', groups: [] }), 'rt-9');
    expect(stranger).toMatchObject({ created: true, admitted: false });
    expect((await row(stranger.user.id)).idp_refresh_token).toBeNull();
  });

  test('role_override replaces the mapped role only while the IdP admits the person', async () => {
    const first = await upsert(id());
    await setColumns(first.user.id, { role_override: 'admin' });
    const promoted = await upsert(id(), 'rt-2');
    expect(promoted).toMatchObject({ admitted: true });
    expect(promoted.user).toMatchObject({ idp_role: 'member', role_override: 'admin' });
    expect(openRefreshToken(ctx.deps, promoted.user.idp_refresh_token ?? '')).toBe('rt-2');

    // Dropped by the IdP: the override no longer lets them in, but stays stored.
    for (const role_override of ['member', 'admin'] as const) {
      await setColumns(first.user.id, { role_override });
      const dropped = await upsert(id({ groups: ['other'] }), 'rt-3');
      expect(dropped, role_override).toMatchObject({ admitted: false });
      expect(dropped.user).toMatchObject({
        idp_role: null,
        role_override,
        idp_refresh_token: null,
      });
    }

    await setColumns(first.user.id, { role_override: 'blocked' });
    const blocked = await upsert(id({ groups: ['pinwall-admins'] }), 'rt-3');
    expect(blocked).toMatchObject({ admitted: false });
    expect(blocked.user).toMatchObject({
      idp_role: 'admin',
      role_override: 'blocked',
      idp_refresh_token: null,
    });
  });

  test('an idp_removed user who is admitted again is re-enabled', async () => {
    const first = await upsert(id());
    await setColumns(first.user.id, { disabled_at: T, disabled_reason: 'idp_removed' });
    const still = await upsert(id({ groups: ['other'] }));
    expect(still).toMatchObject({ admitted: false, reenabled: false });
    expect(still.user).toMatchObject({ disabled_at: T, disabled_reason: 'idp_removed' });

    const back = await upsert(id());
    expect(back).toMatchObject({ admitted: true, reenabled: true });
    expect(back.user).toMatchObject({ disabled_at: null, disabled_reason: null });
    expect(await row(first.user.id)).toEqual(back.user);
  });

  test('a user disabled for another reason stays disabled', async () => {
    const first = await upsert(id());
    await setColumns(first.user.id, { disabled_at: T, disabled_reason: 'admin' });
    const r = await upsert(id());
    expect(r).toMatchObject({ admitted: true, reenabled: false });
    expect(r.user).toMatchObject({ disabled_at: T, disabled_reason: 'admin' });
  });

  test('two concurrent first sign-ins create one row', async () => {
    const [a, b] = await Promise.all([upsert(id(), 'rt-a'), upsert(id(), 'rt-b')]);
    const rows = await users();
    expect(rows).toHaveLength(1);
    expect(a.user.id).toBe(rows[0]?.id);
    expect(b.user.id).toBe(rows[0]?.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  test('a token sealed under another secret key opens as null', () => {
    const other: AppDeps = {
      ...ctx.deps,
      config: { ...ctx.deps.config, secretKey: randomBytes(32) },
    };
    const sealed = sealRefreshToken(other, 'rt-1');
    const error = vi.spyOn(ctx.deps.logger, 'error');
    expect(openRefreshToken(ctx.deps, sealed)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain(sealed);
    expect(openRefreshToken(ctx.deps, 'not a sealed token')).toBeNull();
  });

  test('sealing needs the secret key', () => {
    const keyless: AppDeps = { ...ctx.deps, config: { ...ctx.deps.config, secretKey: null } };
    expect(() => sealRefreshToken(keyless, 'rt-1')).toThrow();
  });

  test('applyIdentity writes the identity and the check time', async () => {
    const first = await upsert(id());
    clock.advance(3_600_000);
    const user = await applyIdentity(
      ctx.deps,
      first.user.id,
      id({
        email: 'ada@new.example',
        emailVerified: false,
        name: 'A. L.',
        groups: ['pinwall-admins'],
      }),
    );
    expect(user).toMatchObject({
      id: first.user.id,
      email: 'ada@new.example',
      email_verified: 0,
      name: 'A. L.',
      idp_role: 'admin',
      idp_checked_at: clock.now(),
    });
    expect(openRefreshToken(ctx.deps, user.idp_refresh_token ?? '')).toBe('rt-1');
    expect(await row(first.user.id)).toEqual(user);
  });
});
