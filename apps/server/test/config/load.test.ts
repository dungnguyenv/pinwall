import { describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { parseDuration, parseList, parseSize } from '../../src/config/parse.ts';
import { ConfigError } from '../../src/config/types.ts';

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (e) {
    return (e as ConfigError).issues;
  }
  throw new Error('expected ConfigError');
}

test('defaults', () => {
  const c = loadConfig({ PINWALL_DATA_DIR: '/tmp/pw' });
  expect(c.publicOrigin).toBe('http://localhost:8080');
  expect(c.database).toEqual({ kind: 'sqlite', path: '/tmp/pw/pinwall.db' });
  expect(c.storage).toEqual({ kind: 'local', dir: '/tmp/pw/blobs' });
  expect(c.isolation).toEqual({ mode: 'single-domain' });
  expect(c.limits.maxUploadBytes).toBe(95_000_000);
  expect(c.limits.maxInlineBytes).toBe(2_000_000);
  expect(c.access.recheckIntervalMs).toBe(12 * 3600_000);
  expect(c.oidc).toBeNull();
  expect(c.trustProxy).toBe(false);
});

test('every remaining default matches the roadmap table', () => {
  const c = loadConfig({});
  expect(c.publicHttps).toBe(false);
  expect(c.listen).toEqual({ host: '0.0.0.0', port: 8080 });
  expect(c.dataDir).toBe('/data');
  expect(c.secretKey).toBeNull();
  expect(c.limits).toEqual({
    maxUploadBytes: 95_000_000,
    maxInlineBytes: 2_000_000,
    maxFileBytes: 50_000_000,
    maxVersionBytes: 500_000_000,
    maxFiles: 10_000,
    maxExpansionRatio: 100,
  });
  expect(c.ttl).toEqual({
    sessionMs: 30 * 86_400_000,
    previewMs: 12 * 3_600_000,
    uploadSessionMs: 10 * 60_000,
  });
  expect(c.access).toEqual({
    adminEmails: [],
    memberEmails: [],
    memberDomains: [],
    recheckIntervalMs: 12 * 3_600_000,
  });
  expect(c.metrics).toEqual({ port: 9464 });
  expect(c.logLevel).toBe('info');
  expect(c.webDir).toBeNull();
  expect(c.warnings).toEqual([]);
});

test('treats empty variables as unset', () => {
  const c = loadConfig({ PINWALL_PORT: '', PINWALL_PUBLIC_ORIGIN: '  ', PINWALL_STORAGE: '' });
  expect(c.listen.port).toBe(8080);
  expect(c.publicOrigin).toBe('http://localhost:8080');
  expect(c.storage.kind).toBe('local');
});

describe('_FILE secrets', () => {
  test('reads _FILE secrets, trimmed', () => {
    const c = loadConfig(
      {
        PINWALL_OIDC_ISSUER: 'https://idp.example',
        PINWALL_OIDC_CLIENT_ID: 'c',
        PINWALL_OIDC_CLIENT_SECRET_FILE: '/run/s',
      },
      { readFile: () => 's3cret\n' },
    );
    expect(c.oidc?.clientSecret).toBe('s3cret');
  });

  test('rejects both value and _FILE', () => {
    expect(() =>
      loadConfig(
        { PINWALL_SECRET_KEY: 'a'.repeat(64), PINWALL_SECRET_KEY_FILE: '/x' },
        { readFile: () => 'b' },
      ),
    ).toThrow(/PINWALL_SECRET_KEY.*only one/);
  });

  test('reports unreadable and empty files by variable name', () => {
    const env = { PINWALL_DATABASE_URL_FILE: '/run/db' };
    const unreadable = () => {
      throw Object.assign(new Error('boom'), { code: 'ENOENT' });
    };
    expect(() => loadConfig(env, { readFile: unreadable })).toThrow(
      /PINWALL_DATABASE_URL_FILE: cannot read \/run\/db \(ENOENT\)/,
    );
    expect(() => loadConfig(env, { readFile: () => ' \n' })).toThrow(
      /PINWALL_DATABASE_URL_FILE: .* is empty/,
    );
  });

  test('every secret accepts a _FILE variant', () => {
    const files: Record<string, string> = {
      '/s/db': 'postgres://u:p@h/db\n',
      '/s/ak': 'AKIA\n',
      '/s/sk': 'sekret\n',
      '/s/key': `${'ab'.repeat(32)}\n`,
    };
    const c = loadConfig(
      {
        PINWALL_DATABASE_URL_FILE: '/s/db',
        PINWALL_STORAGE: 's3',
        PINWALL_S3_BUCKET: 'b',
        PINWALL_S3_ACCESS_KEY_ID_FILE: '/s/ak',
        PINWALL_S3_SECRET_ACCESS_KEY_FILE: '/s/sk',
        PINWALL_SECRET_KEY_FILE: '/s/key',
      },
      { readFile: (path) => files[path] ?? '' },
    );
    expect(c.database).toMatchObject({ kind: 'postgres', url: 'postgres://u:p@h/db' });
    expect(c.storage).toMatchObject({ kind: 's3', accessKeyId: 'AKIA', secretAccessKey: 'sekret' });
    expect(c.secretKey?.equals(Buffer.alloc(32, 0xab))).toBe(true);
  });
});

test('collects every issue', () => {
  try {
    loadConfig({ PINWALL_ISOLATION: 'content-domain', PINWALL_STORAGE: 's3', PINWALL_PORT: 'x' });
  } catch (e) {
    expect((e as ConfigError).issues).toHaveLength(3);
    return;
  }
  throw new Error('expected ConfigError');
});

test('a ConfigError names each variable and joins the issues in its message', () => {
  const issues = issuesOf({ PINWALL_PORT: 'x', PINWALL_LOG_LEVEL: 'loud' });
  expect(issues).toHaveLength(2);
  expect(issues[0]).toMatch(/^PINWALL_PORT: /);
  expect(issues[1]).toMatch(/^PINWALL_LOG_LEVEL: /);
  try {
    loadConfig({ PINWALL_PORT: 'x' });
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toContain('PINWALL_PORT');
  }
});

test('loadConfig does not touch the filesystem for the data dir', () => {
  expect(() => loadConfig({ PINWALL_DATA_DIR: '/definitely/not/there' })).not.toThrow();
});

describe('origins', () => {
  test('public origin must be an origin', () => {
    expect(() => loadConfig({ PINWALL_PUBLIC_ORIGIN: 'https://a.example/sub' })).toThrow(/no path/);
    expect(loadConfig({ PINWALL_PUBLIC_ORIGIN: 'https://a.example/' }).publicOrigin).toBe(
      'https://a.example',
    );
  });

  test('public origin rejects other schemes, queries and non-URLs', () => {
    for (const bad of [
      'ftp://a.example',
      'a.example',
      'https://a.example?x=1',
      'https://u@a.example',
    ]) {
      expect(issuesOf({ PINWALL_PUBLIC_ORIGIN: bad })).toHaveLength(1);
    }
  });

  test('public origin keeps a non-default port and sets publicHttps', () => {
    const c = loadConfig({ PINWALL_PUBLIC_ORIGIN: 'https://a.example:8443' });
    expect(c.publicOrigin).toBe('https://a.example:8443');
    expect(c.publicHttps).toBe(true);
    expect(loadConfig({ PINWALL_PUBLIC_ORIGIN: 'https://a.example:443' }).publicOrigin).toBe(
      'https://a.example',
    );
  });

  test('content origin must not be the app host or its parent', () => {
    const base = {
      PINWALL_PUBLIC_ORIGIN: 'https://pinwall.example.com',
      PINWALL_ISOLATION: 'content-domain',
    };
    expect(() =>
      loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://pinwall.example.com' }),
    ).toThrow();
    expect(() => loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://example.com' })).toThrow();
    const ok = loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://content.example.com' });
    expect(ok.warnings.join()).toMatch(/registrable domain/);
    expect(
      loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://pw-content.net' }).warnings,
    ).toEqual([]);
  });

  test('content origin is split into scheme, host and port', () => {
    const base = { PINWALL_ISOLATION: 'content-domain' };
    expect(
      loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://pw-content.net' }).isolation,
    ).toEqual({
      mode: 'content-domain',
      contentOrigin: { scheme: 'https', host: 'pw-content.net' },
    });
    expect(
      loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'http://pw.localhost:8081' }).isolation,
    ).toEqual({
      mode: 'content-domain',
      contentOrigin: { scheme: 'http', host: 'pw.localhost', port: 8081 },
    });
  });

  test('content origin needs a domain name, a bare origin and a valid isolation mode', () => {
    const base = { PINWALL_ISOLATION: 'content-domain' };
    expect(() => loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'http://127.0.0.1:9000' })).toThrow(
      /domain name/,
    );
    expect(() => loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://c.net/x' })).toThrow(
      /no path/,
    );
    expect(() => loadConfig({ PINWALL_ISOLATION: 'sideways' })).toThrow(/PINWALL_ISOLATION/);
  });

  test('a registrable domain under a private suffix counts as shared', () => {
    const c = loadConfig({
      PINWALL_PUBLIC_ORIGIN: 'https://app.team.github.io',
      PINWALL_ISOLATION: 'content-domain',
      PINWALL_CONTENT_ORIGIN: 'https://files.team.github.io',
    });
    expect(c.warnings.join()).toMatch(/registrable domain team\.github\.io/);
  });
});

describe('durations and limits', () => {
  test('recheck interval cannot exceed 24h', () => {
    expect(() => loadConfig({ PINWALL_ACCESS_RECHECK_INTERVAL: '25h' })).toThrow(/24h/);
    expect(loadConfig({ PINWALL_ACCESS_RECHECK_INTERVAL: '24h' }).access.recheckIntervalMs).toBe(
      86_400_000,
    );
    expect(() => loadConfig({ PINWALL_ACCESS_RECHECK_INTERVAL: '0' })).toThrow(
      /PINWALL_ACCESS_RECHECK_INTERVAL/,
    );
  });

  test('sizes, durations and counts are parsed from the environment', () => {
    const c = loadConfig({
      PINWALL_MAX_UPLOAD_BYTES: '10MB',
      PINWALL_MAX_FILES: '5',
      PINWALL_MAX_EXPANSION_RATIO: '20',
      PINWALL_SESSION_TTL: '1d',
      PINWALL_PREVIEW_TTL: '30m',
      PINWALL_UPLOAD_SESSION_TTL: '90s',
    });
    expect(c.limits).toMatchObject({
      maxUploadBytes: 10_000_000,
      maxFiles: 5,
      maxExpansionRatio: 20,
    });
    expect(c.ttl).toEqual({ sessionMs: 86_400_000, previewMs: 1_800_000, uploadSessionMs: 90_000 });
  });

  test('invalid sizes and counts are issues naming the variable', () => {
    const issues = issuesOf({
      PINWALL_MAX_FILE_BYTES: 'lots',
      PINWALL_MAX_FILES: '0',
      PINWALL_SESSION_TTL: 'soon',
    });
    expect(issues.map((i) => i.split(':')[0])).toEqual([
      'PINWALL_MAX_FILE_BYTES',
      'PINWALL_MAX_FILES',
      'PINWALL_SESSION_TTL',
    ]);
  });

  test('ports: the listener and metrics must differ, and metrics may be disabled', () => {
    expect(loadConfig({ PINWALL_METRICS_PORT: '0' }).metrics.port).toBe(0);
    expect(() => loadConfig({ PINWALL_PORT: '9000', PINWALL_METRICS_PORT: '9000' })).toThrow(
      /PINWALL_METRICS_PORT/,
    );
    expect(() => loadConfig({ PINWALL_PORT: '70000' })).toThrow(/PINWALL_PORT/);
  });

  test('log level and web dir', () => {
    const c = loadConfig({ PINWALL_LOG_LEVEL: 'debug', PINWALL_WEB_DIR: '/srv/web' });
    expect(c.logLevel).toBe('debug');
    expect(c.webDir).toBe('/srv/web');
  });
});

describe('database and storage', () => {
  const key = { PINWALL_SECRET_KEY: 'ab'.repeat(32) };

  test('postgres url and pool size', () => {
    expect(loadConfig({ ...key, PINWALL_DATABASE_URL: 'postgres://u:p@h/db' }).database).toEqual({
      kind: 'postgres',
      url: 'postgres://u:p@h/db',
      poolSize: 10,
    });
    expect(
      loadConfig({
        ...key,
        PINWALL_DATABASE_URL: 'postgresql://u:p@h/db',
        PINWALL_DATABASE_POOL_SIZE: '25',
      }).database,
    ).toMatchObject({ kind: 'postgres', poolSize: 25 });
  });

  test('postgres requires PINWALL_SECRET_KEY, since a generated key would not survive', () => {
    const issues = issuesOf({ PINWALL_DATABASE_URL: 'postgres://u:hunter2@h/db' });
    expect(issues).toEqual([expect.stringMatching(/^PINWALL_SECRET_KEY: required when /)]);
    expect(issues[0]).toContain('PINWALL_SECRET_KEY_FILE');
    expect(issues[0]).toMatch(/data dir/);
    expect(issues[0]).not.toContain('hunter2');

    const fromFile = loadConfig(
      { PINWALL_DATABASE_URL: 'postgres://u:p@h/db', PINWALL_SECRET_KEY_FILE: '/run/key' },
      { readFile: () => 'cd'.repeat(32) },
    );
    expect(fromFile.secretKey?.equals(Buffer.alloc(32, 0xcd))).toBe(true);
    // A key that is set but unusable is reported once, as itself.
    expect(
      issuesOf({ PINWALL_DATABASE_URL: 'postgres://u:p@h/db', PINWALL_SECRET_KEY: 'abcd' }),
    ).toEqual([expect.stringMatching(/^PINWALL_SECRET_KEY: must decode to at least 32 bytes/)]);
    // SQLite keeps generating the key next to the database.
    expect(loadConfig({ PINWALL_DATABASE_URL: 'sqlite:x.db' }).secretKey).toBeNull();
  });

  test('sqlite urls: absolute, relative to the data dir', () => {
    const env = { PINWALL_DATA_DIR: '/tmp/pw' };
    expect(loadConfig({ ...env, PINWALL_DATABASE_URL: 'sqlite:/var/lib/x.db' }).database).toEqual({
      kind: 'sqlite',
      path: '/var/lib/x.db',
    });
    expect(loadConfig({ ...env, PINWALL_DATABASE_URL: 'sqlite:other.db' }).database).toEqual({
      kind: 'sqlite',
      path: '/tmp/pw/other.db',
    });
  });

  test('unknown database schemes do not leak the url', () => {
    const issues = issuesOf({ PINWALL_DATABASE_URL: 'mysql://user:hunter2@h/db' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^PINWALL_DATABASE_URL: /);
    expect(issues[0]).not.toContain('hunter2');
  });

  test('s3 storage', () => {
    const c = loadConfig({
      PINWALL_STORAGE: 's3',
      PINWALL_S3_BUCKET: 'blobs',
      PINWALL_S3_ENDPOINT: 'http://minio:9000',
      PINWALL_S3_ACCESS_KEY_ID: 'k',
      PINWALL_S3_SECRET_ACCESS_KEY: 's',
      PINWALL_S3_FORCE_PATH_STYLE: 'true',
      PINWALL_S3_PREFIX: 'pw/',
    });
    expect(c.storage).toEqual({
      kind: 's3',
      bucket: 'blobs',
      region: 'us-east-1',
      endpoint: 'http://minio:9000',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
      prefix: 'pw/',
    });
    expect(loadConfig({ PINWALL_STORAGE: 's3', PINWALL_S3_BUCKET: 'b' }).storage).toEqual({
      kind: 's3',
      bucket: 'b',
      region: 'us-east-1',
      forcePathStyle: false,
      prefix: '',
    });
  });

  test('s3 credentials come as a pair and the storage kind is checked', () => {
    expect(
      issuesOf({ PINWALL_STORAGE: 's3', PINWALL_S3_BUCKET: 'b', PINWALL_S3_ACCESS_KEY_ID: 'k' }),
    ).toEqual([expect.stringMatching(/^PINWALL_S3_SECRET_ACCESS_KEY: /)]);
    expect(() => loadConfig({ PINWALL_STORAGE: 'ftp' })).toThrow(/PINWALL_STORAGE/);
  });
});

describe('proxy, secret key and access', () => {
  test('trust proxy accepts true or CIDR list', () => {
    expect(loadConfig({ PINWALL_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ PINWALL_TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ PINWALL_TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12' }).trustProxy).toEqual([
      '10.0.0.0/8',
      '172.16.0.0/12',
    ]);
    expect(loadConfig({ PINWALL_TRUST_PROXY: '::1 fd00::/8 192.168.1.5' }).trustProxy).toEqual([
      '::1',
      'fd00::/8',
      '192.168.1.5',
    ]);
  });

  test('trust proxy rejects entries that are not addresses', () => {
    for (const bad of ['yes', '10.0.0.0/33', 'proxy.local', '10.0.0.0/x']) {
      expect(issuesOf({ PINWALL_TRUST_PROXY: bad })).toEqual([
        expect.stringMatching(/^PINWALL_TRUST_PROXY: /),
      ]);
    }
  });

  test('secret key decodes from hex or base64 and must be at least 32 bytes', () => {
    const bytes = Buffer.alloc(32, 9);
    expect(loadConfig({ PINWALL_SECRET_KEY: bytes.toString('hex') }).secretKey?.equals(bytes)).toBe(
      true,
    );
    expect(
      loadConfig({ PINWALL_SECRET_KEY: bytes.toString('base64') }).secretKey?.equals(bytes),
    ).toBe(true);
    expect(
      loadConfig({ PINWALL_SECRET_KEY: bytes.toString('base64url') }).secretKey?.equals(bytes),
    ).toBe(true);
    expect(() => loadConfig({ PINWALL_SECRET_KEY: 'abcd' })).toThrow(
      /PINWALL_SECRET_KEY.*32 bytes/,
    );
    expect(() => loadConfig({ PINWALL_SECRET_KEY: '!!!not a key!!!'.repeat(5) })).toThrow(
      /PINWALL_SECRET_KEY/,
    );
  });

  test('oidc lists and emails are normalized', () => {
    const c = loadConfig({
      PINWALL_OIDC_ISSUER: 'https://idp',
      PINWALL_OIDC_CLIENT_ID: 'c',
      PINWALL_OIDC_ADMIN_GROUPS: 'admins, ops',
      PINWALL_ADMIN_EMAILS: 'A@X.com',
      PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'access_type=offline',
    });
    expect(c.oidc).toMatchObject({
      adminGroups: ['admins', 'ops'],
      extraAuthParams: { access_type: 'offline' },
      scopes: ['openid', 'email', 'profile', 'offline_access'],
    });
    expect(c.access.adminEmails).toEqual(['a@x.com']);
  });

  test('oidc defaults and optional fields', () => {
    const c = loadConfig({
      PINWALL_OIDC_ISSUER: 'https://idp.example/realm',
      PINWALL_OIDC_CLIENT_ID: 'c',
      PINWALL_OIDC_SCOPES: 'openid groups',
      PINWALL_OIDC_DISPLAY_NAME: 'Company SSO',
      PINWALL_OIDC_ROLES_CLAIM: 'groups',
      PINWALL_OIDC_MEMBER_GROUPS: 'staff',
      PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'access_type=offline&prompt=consent',
    });
    expect(c.oidc).toEqual({
      issuer: 'https://idp.example/realm',
      clientId: 'c',
      scopes: ['openid', 'groups'],
      displayName: 'Company SSO',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      rolesClaim: 'groups',
      adminGroups: [],
      memberGroups: ['staff'],
    });
    expect(
      loadConfig({ PINWALL_OIDC_ISSUER: 'https://idp', PINWALL_OIDC_CLIENT_ID: 'c' }).oidc,
    ).toMatchObject({ displayName: 'Single sign-on', extraAuthParams: {} });
  });

  test('oidc needs issuer and client id together and the openid scope', () => {
    expect(issuesOf({ PINWALL_OIDC_ISSUER: 'https://idp' })).toEqual([
      expect.stringMatching(/^PINWALL_OIDC_CLIENT_ID: /),
    ]);
    expect(issuesOf({ PINWALL_OIDC_CLIENT_ID: 'c' })).toEqual([
      expect.stringMatching(/^PINWALL_OIDC_ISSUER: /),
    ]);
    expect(
      issuesOf({
        PINWALL_OIDC_ISSUER: 'https://idp',
        PINWALL_OIDC_CLIENT_ID: 'c',
        PINWALL_OIDC_SCOPES: 'email profile',
      }),
    ).toEqual([expect.stringMatching(/^PINWALL_OIDC_SCOPES: .*openid/)]);
    expect(issuesOf({ PINWALL_OIDC_ISSUER: 'not a url', PINWALL_OIDC_CLIENT_ID: 'c' })).toEqual([
      expect.stringMatching(/^PINWALL_OIDC_ISSUER: /),
    ]);
  });

  test('access lists are lowercased, deduplicated and validated', () => {
    const c = loadConfig({
      PINWALL_ADMIN_EMAILS: 'Boss@Corp.com, boss@corp.com',
      PINWALL_MEMBER_EMAILS: 'a@x.com b@y.org',
      PINWALL_MEMBER_DOMAINS: '@Corp.com, example.org',
    });
    expect(c.access).toMatchObject({
      adminEmails: ['boss@corp.com'],
      memberEmails: ['a@x.com', 'b@y.org'],
      memberDomains: ['corp.com', 'example.org'],
    });
    expect(issuesOf({ PINWALL_ADMIN_EMAILS: 'not-an-email' })).toEqual([
      expect.stringMatching(/^PINWALL_ADMIN_EMAILS: .*not-an-email/),
    ]);
  });
});

test('parse helpers', () => {
  expect(parseDuration('15m')).toBe(900_000);
  expect(parseDuration('7d')).toBe(604_800_000);
  expect(parseSize('95MB')).toBe(95_000_000);
  expect(parseSize('2MiB')).toBe(2_097_152);
  expect(() => parseSize('lots')).toThrow();
});

test('parseDuration and parseSize accept bare numbers, decimals, case and spaces', () => {
  expect(parseDuration('1500')).toBe(1500);
  expect(parseDuration('250ms')).toBe(250);
  expect(parseDuration('30s')).toBe(30_000);
  expect(parseDuration('1.5h')).toBe(5_400_000);
  expect(parseDuration(' 2 H ')).toBe(7_200_000);
  expect(parseSize('1024')).toBe(1024);
  expect(parseSize('1.5GB')).toBe(1_500_000_000);
  expect(parseSize('64kib')).toBe(65_536);
  expect(parseSize('3 gib')).toBe(3 * 1024 ** 3);
  for (const bad of ['', '-5m', '12x', 'h', '1e3', '5 minutes']) {
    expect(() => parseDuration(bad)).toThrow();
  }
  expect(() => parseSize('5 lots')).toThrow();
  expect(() => parseSize('-1MB')).toThrow();
});

test('parseList splits on commas and whitespace and drops empties', () => {
  expect(parseList(undefined)).toEqual([]);
  expect(parseList('')).toEqual([]);
  expect(parseList(' a, b ,,c  d\n')).toEqual(['a', 'b', 'c', 'd']);
});
