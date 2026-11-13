import { AdminConfig, type ConfigEntry, ConfigSection } from '@pinwall/shared';
import messages from '@pinwall/shared/i18n/en.json' with { type: 'json' };
import { afterEach, describe, expect, test } from 'vitest';
import {
  CONFIG_SETTINGS,
  describeConfig,
  formatDuration,
  redactUrl,
} from '../../src/api/admin-config.ts';
import { loadConfig } from '../../src/config/load.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, createSignedInUser, createUserToken } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';

function entry(d: AdminConfig, env: string): ConfigEntry {
  const found = d.entries.find((e) => e.env === env);
  if (!found) throw new Error(`no entry for ${env}`);
  return found;
}

const shown = (d: AdminConfig, env: string) => entry(d, env).value;

describe('describeConfig', () => {
  test('secrets never appear in the description', () => {
    const c = loadConfig({
      PINWALL_DATA_DIR: '/tmp/pw',
      PINWALL_DATABASE_URL:
        'postgres://pw:db-pass-123@db:5432/pinwall?sslmode=require&password=q-pass-456',
      PINWALL_STORAGE: 's3',
      PINWALL_S3_BUCKET: 'b',
      PINWALL_S3_ACCESS_KEY_ID: 'AKIA-key-789',
      PINWALL_S3_SECRET_ACCESS_KEY: 's3-secret-000',
      PINWALL_OIDC_ISSUER: 'https://idp.example',
      PINWALL_OIDC_CLIENT_ID: 'pinwall',
      PINWALL_OIDC_CLIENT_SECRET: 'oidc-secret-222',
      PINWALL_SECRET_KEY: 'ab'.repeat(32),
    });
    const d = describeConfig(c);
    const json = JSON.stringify(d);
    for (const s of [
      'db-pass-123',
      'q-pass-456',
      'AKIA-key-789',
      's3-secret-000',
      'oidc-secret-222',
      'ab'.repeat(32),
    ]) {
      expect(json).not.toContain(s);
    }
    expect(entry(d, 'PINWALL_DATABASE_URL').value).toBe('postgres://pw@db:5432/pinwall');
    expect(entry(d, 'PINWALL_S3_SECRET_ACCESS_KEY')).toEqual({
      section: 'storage',
      env: 'PINWALL_S3_SECRET_ACCESS_KEY',
      value: null,
      secret: true,
      set: true,
    });
    expect(entry(d, 'PINWALL_S3_ACCESS_KEY_ID')).toMatchObject({
      value: null,
      secret: true,
      set: true,
    });
    expect(entry(d, 'PINWALL_SECRET_KEY')).toMatchObject({ value: null, secret: true, set: true });
    expect(entry(d, 'PINWALL_OIDC_CLIENT_SECRET')).toMatchObject({
      value: null,
      secret: true,
      set: true,
    });
    expect(entry(d, 'PINWALL_OIDC_CLIENT_ID').value).toBe('pinwall');
    expect(d.entries.filter((e) => e.secret).map((e) => e.env)).toEqual([
      'PINWALL_SECRET_KEY',
      'PINWALL_S3_ACCESS_KEY_ID',
      'PINWALL_S3_SECRET_ACCESS_KEY',
      'PINWALL_OIDC_CLIENT_SECRET',
    ]);
    expect(d.entries.every((e) => !e.secret || e.value === null)).toBe(true);
  });

  test('defaults read as environment values', () => {
    const d = describeConfig(loadConfig({ PINWALL_DATA_DIR: '/tmp/pw' }));
    expect(entry(d, 'PINWALL_ISOLATION').value).toBe('single-domain');
    expect(entry(d, 'PINWALL_DATABASE_URL').value).toBe('sqlite:/tmp/pw/pinwall.db');
    expect(entry(d, 'PINWALL_MAX_UPLOAD_BYTES').value).toBe('95000000');
    expect(entry(d, 'PINWALL_ACCESS_RECHECK_INTERVAL').value).toBe('12h');
    expect(entry(d, 'PINWALL_SESSION_TTL').value).toBe('30d');
    expect(entry(d, 'PINWALL_UPLOAD_SESSION_TTL').value).toBe('10m');
    expect(entry(d, 'PINWALL_OIDC_CLIENT_SECRET')).toMatchObject({
      value: null,
      secret: true,
      set: false,
    });
    expect(new Set(d.entries.map((e) => e.env)).size).toBe(d.entries.length);
    expect(AdminConfig.parse(d)).toEqual(d);

    expect(d).toMatchObject({ isolation: 'single-domain', content_origin: null, warnings: [] });
    expect(shown(d, 'PINWALL_PUBLIC_ORIGIN')).toBe('http://localhost:8080');
    expect(shown(d, 'PINWALL_PORT')).toBe('8080');
    expect(shown(d, 'PINWALL_TRUST_PROXY')).toBe('false');
    expect(shown(d, 'PINWALL_WEB_DIR')).toBeNull();
    expect(shown(d, 'PINWALL_METRICS_PORT')).toBe('9464');
    expect(shown(d, 'PINWALL_CONTENT_ORIGIN')).toBeNull();
    expect(shown(d, 'PINWALL_DATABASE_POOL_SIZE')).toBeNull();
    expect(shown(d, 'PINWALL_STORAGE')).toBe('local');
    expect(shown(d, 'PINWALL_PREVIEW_TTL')).toBe('12h');
    expect(shown(d, 'PINWALL_MAX_EXPANSION_RATIO')).toBe('100');
    expect(shown(d, 'PINWALL_ADMIN_EMAILS')).toBeNull();
    // With SQLite and no key given, the server generates one at start; loadConfig alone has none.
    expect(entry(d, 'PINWALL_SECRET_KEY')).toMatchObject({ value: null, secret: true, set: false });
    // S3 settings only appear when S3 is the storage.
    expect(d.entries.some((e) => e.env.startsWith('PINWALL_S3_'))).toBe(false);
    // With OIDC off, every sign-in setting reads as not set.
    const signIn = d.entries.filter((e) => e.section === 'sign_in');
    expect(signIn.map((e) => [e.env, e.value, e.set])).toEqual([
      ['PINWALL_OIDC_ISSUER', null, false],
      ['PINWALL_OIDC_CLIENT_ID', null, false],
      ['PINWALL_OIDC_CLIENT_SECRET', null, false],
      ['PINWALL_OIDC_SCOPES', null, false],
      ['PINWALL_OIDC_DISPLAY_NAME', null, false],
      ['PINWALL_OIDC_EXTRA_AUTH_PARAMS', null, false],
      ['PINWALL_OIDC_ALLOW_HTTP_ISSUER', null, false],
    ]);
  });

  test('every setting is listed once, grouped by section in table order', () => {
    const d = describeConfig(
      loadConfig({
        PINWALL_DATA_DIR: '/tmp/pw',
        PINWALL_DATABASE_URL: 'postgres://pw:secret@db/pinwall',
        PINWALL_SECRET_KEY: 'ab'.repeat(32),
        PINWALL_STORAGE: 's3',
        PINWALL_S3_BUCKET: 'b',
        PINWALL_OIDC_ISSUER: 'https://idp.example',
        PINWALL_OIDC_CLIENT_ID: 'pinwall',
      }),
    );
    expect(d.entries.map((e) => `${e.section} ${e.env}`)).toEqual([
      'general PINWALL_PUBLIC_ORIGIN',
      'general PINWALL_HOST',
      'general PINWALL_PORT',
      'general PINWALL_DATA_DIR',
      'general PINWALL_SECRET_KEY',
      'general PINWALL_TRUST_PROXY',
      'general PINWALL_METRICS_PORT',
      'general PINWALL_LOG_LEVEL',
      'general PINWALL_WEB_DIR',
      'isolation PINWALL_ISOLATION',
      'isolation PINWALL_CONTENT_ORIGIN',
      'database PINWALL_DATABASE_URL',
      'database PINWALL_DATABASE_POOL_SIZE',
      'storage PINWALL_STORAGE',
      'storage PINWALL_S3_BUCKET',
      'storage PINWALL_S3_REGION',
      'storage PINWALL_S3_ENDPOINT',
      'storage PINWALL_S3_ACCESS_KEY_ID',
      'storage PINWALL_S3_SECRET_ACCESS_KEY',
      'storage PINWALL_S3_FORCE_PATH_STYLE',
      'storage PINWALL_S3_PREFIX',
      'sign_in PINWALL_OIDC_ISSUER',
      'sign_in PINWALL_OIDC_CLIENT_ID',
      'sign_in PINWALL_OIDC_CLIENT_SECRET',
      'sign_in PINWALL_OIDC_SCOPES',
      'sign_in PINWALL_OIDC_DISPLAY_NAME',
      'sign_in PINWALL_OIDC_EXTRA_AUTH_PARAMS',
      'sign_in PINWALL_OIDC_ALLOW_HTTP_ISSUER',
      'access PINWALL_OIDC_ROLES_CLAIM',
      'access PINWALL_OIDC_ADMIN_GROUPS',
      'access PINWALL_OIDC_MEMBER_GROUPS',
      'access PINWALL_ADMIN_EMAILS',
      'access PINWALL_MEMBER_EMAILS',
      'access PINWALL_MEMBER_DOMAINS',
      'access PINWALL_ACCESS_RECHECK_INTERVAL',
      'spaces PINWALL_VISIBILITY',
      'spaces PINWALL_SHARE_LINKS',
      'limits PINWALL_MAX_UPLOAD_BYTES',
      'limits PINWALL_MAX_INLINE_BYTES',
      'limits PINWALL_MAX_FILE_BYTES',
      'limits PINWALL_MAX_VERSION_BYTES',
      'limits PINWALL_MAX_FILES',
      'limits PINWALL_MAX_EXPANSION_RATIO',
      'lifetimes PINWALL_SESSION_TTL',
      'lifetimes PINWALL_PREVIEW_TTL',
      'lifetimes PINWALL_UPLOAD_SESSION_TTL',
    ]);
    expect(new Set(d.entries.map((e) => e.section))).toEqual(new Set(ConfigSection.options));
  });

  test('values read as they would be written in the environment', () => {
    const d = describeConfig(
      loadConfig({
        PINWALL_DATA_DIR: '/tmp/pw',
        PINWALL_DATABASE_URL: 'postgresql://pinwall@db.internal/pinwall',
        PINWALL_DATABASE_POOL_SIZE: '20',
        PINWALL_SECRET_KEY: 'ab'.repeat(32),
        PINWALL_TRUST_PROXY: '10.0.0.0/8,192.168.1.1',
        PINWALL_WEB_DIR: '/srv/web',
        PINWALL_METRICS_PORT: '0',
        PINWALL_STORAGE: 's3',
        PINWALL_S3_BUCKET: 'artifacts',
        PINWALL_S3_ENDPOINT: 'https://minio.example:9000',
        PINWALL_S3_FORCE_PATH_STYLE: 'true',
        PINWALL_S3_PREFIX: 'pinwall/',
        PINWALL_OIDC_ISSUER: 'https://idp.example/realms/main',
        PINWALL_OIDC_CLIENT_ID: 'pinwall',
        PINWALL_OIDC_SCOPES: 'openid email groups',
        PINWALL_OIDC_DISPLAY_NAME: 'Company SSO',
        PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'access_type=offline&prompt=consent',
        PINWALL_OIDC_ROLES_CLAIM: 'groups',
        PINWALL_OIDC_ADMIN_GROUPS: 'admins, ops',
        PINWALL_MEMBER_DOMAINS: '@Example.com,example.org',
        PINWALL_ADMIN_EMAILS: 'ada@example.com',
        PINWALL_ACCESS_RECHECK_INTERVAL: '90m',
        PINWALL_PREVIEW_TTL: '1500',
      }),
    );
    expect(shown(d, 'PINWALL_DATABASE_URL')).toBe('postgresql://pinwall@db.internal/pinwall');
    expect(shown(d, 'PINWALL_DATABASE_POOL_SIZE')).toBe('20');
    expect(shown(d, 'PINWALL_TRUST_PROXY')).toBe('10.0.0.0/8, 192.168.1.1');
    expect(shown(d, 'PINWALL_WEB_DIR')).toBe('/srv/web');
    expect(shown(d, 'PINWALL_METRICS_PORT')).toBe('0');
    expect(shown(d, 'PINWALL_S3_BUCKET')).toBe('artifacts');
    expect(shown(d, 'PINWALL_S3_REGION')).toBe('us-east-1');
    expect(shown(d, 'PINWALL_S3_ENDPOINT')).toBe('https://minio.example:9000');
    expect(shown(d, 'PINWALL_S3_FORCE_PATH_STYLE')).toBe('true');
    expect(shown(d, 'PINWALL_S3_PREFIX')).toBe('pinwall/');
    expect(entry(d, 'PINWALL_S3_ACCESS_KEY_ID')).toMatchObject({ value: null, set: false });
    expect(shown(d, 'PINWALL_OIDC_ISSUER')).toBe('https://idp.example/realms/main');
    expect(shown(d, 'PINWALL_OIDC_SCOPES')).toBe('openid email groups');
    expect(shown(d, 'PINWALL_OIDC_DISPLAY_NAME')).toBe('Company SSO');
    expect(shown(d, 'PINWALL_OIDC_EXTRA_AUTH_PARAMS')).toBe('access_type=offline&prompt=consent');
    expect(shown(d, 'PINWALL_OIDC_ALLOW_HTTP_ISSUER')).toBe('false');
    expect(entry(d, 'PINWALL_OIDC_CLIENT_SECRET')).toMatchObject({ value: null, set: false });
    expect(shown(d, 'PINWALL_OIDC_ROLES_CLAIM')).toBe('groups');
    expect(shown(d, 'PINWALL_OIDC_ADMIN_GROUPS')).toBe('admins, ops');
    expect(shown(d, 'PINWALL_OIDC_MEMBER_GROUPS')).toBeNull();
    expect(shown(d, 'PINWALL_MEMBER_DOMAINS')).toBe('example.com, example.org');
    expect(shown(d, 'PINWALL_ADMIN_EMAILS')).toBe('ada@example.com');
    expect(shown(d, 'PINWALL_MEMBER_EMAILS')).toBeNull();
    expect(shown(d, 'PINWALL_ACCESS_RECHECK_INTERVAL')).toBe('90m');
    expect(shown(d, 'PINWALL_PREVIEW_TTL')).toBe('1500ms');
    for (const e of d.entries) expect(e.set, e.env).toBe(e.secret ? e.set : e.value !== null);
  });

  test('content-domain mode reports its origin and warnings', () => {
    const d = describeConfig(
      loadConfig({
        PINWALL_DATA_DIR: '/tmp/pw',
        PINWALL_PUBLIC_ORIGIN: 'https://pinwall.example.com',
        PINWALL_ISOLATION: 'content-domain',
        PINWALL_CONTENT_ORIGIN: 'https://content.example.com:8443',
      }),
    );
    expect(d.isolation).toBe('content-domain');
    expect(d.content_origin).toBe('https://content.example.com:8443');
    expect(shown(d, 'PINWALL_ISOLATION')).toBe('content-domain');
    expect(shown(d, 'PINWALL_CONTENT_ORIGIN')).toBe('https://content.example.com:8443');
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toContain('registrable domain');

    const separate = describeConfig(
      loadConfig({
        PINWALL_DATA_DIR: '/tmp/pw',
        PINWALL_PUBLIC_ORIGIN: 'https://pinwall.example.com',
        PINWALL_ISOLATION: 'content-domain',
        PINWALL_CONTENT_ORIGIN: 'https://pinwall-content.example',
      }),
    );
    expect(separate).toMatchObject({
      content_origin: 'https://pinwall-content.example',
      warnings: [],
    });
  });

  test('warnings never repeat credentials from a configured URL', () => {
    const d = describeConfig(
      loadConfig({
        PINWALL_DATA_DIR: '/tmp/pw',
        PINWALL_OIDC_ISSUER: 'http://svc:issuer-pass-333@idp.cluster.local/realms/main?k=v',
        PINWALL_OIDC_CLIENT_ID: 'pinwall',
        PINWALL_OIDC_ALLOW_HTTP_ISSUER: 'true',
      }),
    );
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toContain('http://svc@idp.cluster.local/realms/main');
    expect(JSON.stringify(d)).not.toContain('issuer-pass-333');
    expect(shown(d, 'PINWALL_OIDC_ISSUER')).toBe('http://svc@idp.cluster.local/realms/main');
    expect(shown(d, 'PINWALL_OIDC_ALLOW_HTTP_ISSUER')).toBe('true');
  });
});

test('redactUrl and formatDuration', () => {
  expect(redactUrl('https://u:p@minio.example:9000/x?a=1#f')).toBe(
    'https://u@minio.example:9000/x',
  );
  expect(redactUrl('postgres://:only-pass@db/pinwall')).toBe('postgres://db/pinwall');
  // An issuer must match exactly: a root path is shown only when it was written.
  expect(redactUrl('https://idp.example')).toBe('https://idp.example');
  expect(redactUrl('https://idp.example/')).toBe('https://idp.example/');
  expect(redactUrl('https://idp.example?next=/a/')).toBe('https://idp.example');
  expect(formatDuration(90_000)).toBe('90s');
  expect(formatDuration(1500)).toBe('1500ms');
  expect(formatDuration(5 * 60_000)).toBe('5m');
  expect(formatDuration(36 * 3_600_000)).toBe('36h');
  expect(formatDuration(7 * 86_400_000)).toBe('7d');
});

describe('GET /admin/config', () => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  type Auth = { cookie?: string; bearer?: string };
  const get = (o: Auth) => ctx.request('/api/v1/admin/config', apiInit(ctx, o));

  test('GET /admin/config is for admins only', async () => {
    ctx = await createTestContext();
    const { user: owner, cookie } = await createSignedInUser(ctx);
    const r = await get({ cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = AdminConfig.parse(await r.json());
    expect(body.isolation).toBe('single-domain');
    expect(entry(body, 'PINWALL_DATA_DIR').value).toBe(ctx.deps.config.dataDir);
    // The server generated a key at start: one is set, and it is not shown.
    expect(entry(body, 'PINWALL_SECRET_KEY')).toMatchObject({ value: null, set: true });

    const token = await createUserToken(ctx, owner.id);
    expect((await get({ bearer: token })).status).toBe(200);

    const { cookie: memberCookie } = await createSignedInUser(ctx, { kind: 'oidc' });
    const denied = await get({ cookie: memberCookie });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: unknown }).error).toEqual({
      code: 'forbidden',
      message: t('auth.adminOnly'),
    });
    expect((await get({})).status).toBe(401);

    const doc = (await (await ctx.request('/api/v1/openapi.json')).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths)).toContain('/admin/config');
  });

  test('the response holds no secret anywhere', async () => {
    const secrets = {
      PINWALL_SECRET_KEY: 'cd'.repeat(32),
      PINWALL_S3_ACCESS_KEY_ID: 'AKIA-http-key-444',
      PINWALL_S3_SECRET_ACCESS_KEY: 's3-http-secret-555',
      PINWALL_OIDC_CLIENT_SECRET: 'oidc-http-secret-666',
    };
    ctx = await createTestContext({
      env: {
        ...secrets,
        PINWALL_STORAGE: 's3',
        PINWALL_S3_BUCKET: 'b',
        PINWALL_S3_ENDPOINT: 'https://minio-user:endpoint-pass-777@minio.example:9000',
        PINWALL_OIDC_ISSUER: 'https://idp.example',
        PINWALL_OIDC_CLIENT_ID: 'pinwall',
      },
    });
    const { cookie } = await createSignedInUser(ctx);
    const r = await get({ cookie });
    expect(r.status).toBe(200);
    const text = await r.text();
    for (const s of [...Object.values(secrets), 'endpoint-pass-777']) {
      expect(text).not.toContain(s);
    }
    const body = AdminConfig.parse(JSON.parse(text));
    expect(entry(body, 'PINWALL_S3_ENDPOINT').value).toBe('https://minio-user@minio.example:9000');
    for (const env of Object.keys(secrets)) {
      expect(entry(body, env)).toMatchObject({ value: null, secret: true, set: true });
    }
  });
});

test('the web app explains every setting, and only the settings listed', () => {
  // The Configuration page prints `web.config.help.<ENV>` under each entry; a setting without
  // one would show a bare key, and a help text for a removed setting is dead weight.
  const helped = Object.keys(messages)
    .filter((key) => key.startsWith('web.config.help.'))
    .map((key) => key.slice('web.config.help.'.length));
  expect(helped.sort()).toEqual(CONFIG_SETTINGS.map((setting) => setting.env).sort());
});
