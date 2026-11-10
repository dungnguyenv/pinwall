import { PublicConfig } from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { getOwner, ownerExists } from '../../src/auth/users.ts';
import { newId } from '../../src/lib/ids.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

describe.each(dialects)('public config on %s', (dialect) => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  const insertOwner = async (c: TestContext) => {
    const id = newId('usr');
    await c.deps.db.db
      .insertInto('users')
      .values({ id, kind: 'owner', email_verified: 0, created_at: 1_700_000_000_000 })
      .execute();
    return id;
  };

  test('public config before setup', async () => {
    ctx = await createTestContext({ dialect });
    const r = await ctx.request('/api/v1/config/public');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = await r.json();
    expect(body).toEqual({
      setup_required: true,
      oidc: { enabled: false, display_name: null },
      isolation: 'single-domain',
      passkeys_available: true,
      limits: {
        max_upload_bytes: 95_000_000,
        max_inline_bytes: 2_000_000,
        max_file_bytes: 50_000_000,
        max_version_bytes: 500_000_000,
        max_files: 10_000,
        max_expansion_ratio: 100,
      },
    });
    expect(PublicConfig.parse(body)).toEqual(body);
  });

  test('public config reflects OIDC, isolation and an existing owner', async () => {
    ctx = await createTestContext({
      dialect,
      env: {
        PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test',
        PINWALL_ISOLATION: 'content-domain',
        PINWALL_CONTENT_ORIGIN: 'https://pw-content.test',
        PINWALL_OIDC_ISSUER: 'https://idp.test',
        PINWALL_OIDC_CLIENT_ID: 'c',
        PINWALL_OIDC_DISPLAY_NAME: 'Zitadel',
      },
    });
    await insertOwner(ctx);
    const body = await (await ctx.request('/api/v1/config/public')).json();
    expect(body).toMatchObject({
      setup_required: false,
      oidc: { enabled: true, display_name: 'Zitadel' },
      isolation: 'content-domain',
      passkeys_available: true,
    });
  });

  test('passkeys are unavailable on a plain-http named origin', async () => {
    ctx = await createTestContext({
      dialect,
      env: { PINWALL_PUBLIC_ORIGIN: 'http://pinwall.lan:8080' },
    });
    const body = (await (await ctx.request('/api/v1/config/public')).json()) as PublicConfig;
    expect(body.passkeys_available).toBe(false);
  });

  test('ownerExists and getOwner see the owner', async () => {
    ctx = await createTestContext({ dialect });
    const { db } = ctx.deps.db;
    expect(await ownerExists(db)).toBe(false);
    expect(await getOwner(db)).toBeUndefined();
    const id = await insertOwner(ctx);
    expect(await ownerExists(db)).toBe(true);
    expect(await getOwner(db)).toMatchObject({ id, kind: 'owner' });
  });
});
