import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { getDomain, parse as parseHostname } from 'tldts';
import { z } from 'zod';
import { parseDuration, parseList, parseSize } from './parse.ts';
import { decodeSecretKey } from './secret-key.ts';
import { type Config, ConfigError } from './types.ts';

export { type Config, ConfigError } from './types.ts';

type Env = Record<string, string | undefined>;

export interface ConfigIo {
  readFile(path: string): string;
}

const DAY_MS = 86_400_000;
/** The shortest PINWALL_ACCESS_RECHECK_INTERVAL. */
const MIN_RECHECK_INTERVAL_MS = 300_000;

interface ParsedOrigin {
  origin: string;
  scheme: 'http' | 'https';
  host: string;
  port?: number;
}

/** An http(s) origin: scheme, host and optional port, nothing else. */
function parseOrigin(value: string): ParsedOrigin {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('must be an absolute URL such as https://pinwall.example');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('must start with http:// or https://');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(
      'must be an origin (scheme, host and optional port) with no path, query, fragment or credentials',
    );
  }
  return {
    origin: url.origin,
    scheme: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    ...(url.port ? { port: Number(url.port) } : {}),
  };
}

function parseHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('must be an absolute http:// or https:// URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('must be an absolute http:// or https:// URL');
  }
  return value;
}

function parseDatabase(
  value: string,
  dataDir: string,
  poolSize: number,
): NonNullable<Config['database']> {
  if (value.startsWith('sqlite:')) {
    const path = value.slice('sqlite:'.length).trim();
    if (!path) throw new Error('sqlite: needs a file path, for example sqlite:/data/pinwall.db');
    return { kind: 'sqlite', path: resolve(dataDir, path) };
  }
  if (/^postgres(ql)?:\/\//i.test(value)) {
    try {
      new URL(value);
    } catch {
      throw new Error('is not a valid PostgreSQL connection URL');
    }
    return { kind: 'postgres', url: value, poolSize };
  }
  throw new Error('must start with sqlite: or postgres://');
}

function parseTrustProxy(value: string): Config['trustProxy'] {
  const lowered = value.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  const entries = parseList(value);
  const hint =
    'use true, false, or a comma-separated list of IPs or CIDR ranges such as 10.0.0.0/8';
  if (entries.length === 0) throw new Error(hint);
  for (const entry of entries) {
    const [address = '', prefix, ...rest] = entry.split('/');
    const family = isIP(address);
    const maxPrefix = family === 4 ? 32 : 128;
    const prefixOk = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (family === 0 || rest.length > 0 || !prefixOk) {
      throw new Error(`"${entry}" is not an IP address or CIDR range; ${hint}`);
    }
  }
  return entries;
}

function parseAuthParams(value: string): Record<string, string> {
  const parts = value.split('&').filter((part) => part.length > 0);
  if (parts.some((part) => part.startsWith('=') || !part.includes('='))) {
    throw new Error('must look like name=value&name=value');
  }
  return Object.fromEntries(new URLSearchParams(parts.join('&')));
}

/** A string schema that runs `parse` and reports its thrown message as the validation issue. */
function custom<T>(parse: (value: string) => T) {
  return z.string().transform((value, ctx) => {
    try {
      return parse(value);
    } catch (error) {
      ctx.issues.push({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
        input: value,
      });
      return z.NEVER;
    }
  });
}

const wholeNumber = (min: number, max: number = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`));

const positiveSize = custom(parseSize).pipe(z.number().min(1, 'must be greater than zero'));
const positiveDuration = custom(parseDuration).pipe(z.number().min(1, 'must be greater than zero'));
const text = z.string();
const originSchema = custom(parseOrigin);
const stringBoolean = z.stringbool({ error: 'must be true or false' });

/** Reads variables from an environment map, recording one issue per problem instead of throwing. */
class EnvReader {
  readonly issues: string[] = [];

  constructor(
    private readonly env: Env,
    private readonly io: ConfigIo,
  ) {}

  /** The trimmed value, or undefined when unset or blank. */
  raw(name: string): string | undefined {
    const value = this.env[name]?.trim();
    return value ? value : undefined;
  }

  fail(name: string, message: string): void {
    this.issues.push(`${name}: ${message}`);
  }

  /** Validates `raw` as the value of `name`; undefined (with an issue recorded) when invalid. */
  validate<T>(name: string, schema: z.ZodType<T>, raw: string): T | undefined {
    const result = schema.safeParse(raw);
    if (result.success) return result.data;
    this.fail(name, result.error.issues[0]?.message ?? 'invalid value');
    return undefined;
  }

  /** The parsed value, or undefined when unset or invalid. */
  read<T>(name: string, schema: z.ZodType<T>): T | undefined {
    const raw = this.raw(name);
    return raw === undefined ? undefined : this.validate(name, schema, raw);
  }

  /** A secret given directly as `NAME` or as the path of a file in `NAME_FILE`, never both. */
  secret(name: string): string | undefined {
    const fileVar = `${name}_FILE`;
    const direct = this.raw(name);
    const path = this.raw(fileVar);
    if (direct !== undefined && path !== undefined) {
      this.fail(name, `set only one of ${name} and ${fileVar}`);
      return undefined;
    }
    if (path === undefined) return direct;
    let content: string;
    try {
      content = this.io.readFile(path).trim();
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
      this.fail(fileVar, `cannot read ${path} (${reason})`);
      return undefined;
    }
    if (!content) {
      this.fail(fileVar, `${path} is empty`);
      return undefined;
    }
    return content;
  }

  /** A list variable whose entries are normalized with `normalize`, deduplicated and validated. */
  list(name: string, normalize: (entry: string) => string, isValid: (entry: string) => boolean) {
    const entries = [...new Set(parseList(this.raw(name)).map(normalize))];
    const invalid = entries.filter((entry) => !isValid(entry));
    if (invalid.length > 0) {
      this.fail(name, `invalid entries: ${invalid.join(', ')}`);
    }
    return entries;
  }
}

const isEmail = (entry: string) => z.email().safeParse(entry).success;

/**
 * Builds the configuration from environment variables. Every problem is collected and thrown
 * together as one `ConfigError`. It never touches the filesystem except to read `*_FILE` secrets.
 */
export function loadConfig(
  env: Env,
  io: ConfigIo = { readFile: (path) => readFileSync(path, 'utf8') },
): Config {
  const r = new EnvReader(env, io);
  const warnings: string[] = [];

  // Public origin
  const publicParsed = r.read('PINWALL_PUBLIC_ORIGIN', originSchema);
  const publicOrigin = publicParsed ?? parseOrigin('http://localhost:8080');
  const publicOriginValid =
    publicParsed !== undefined || r.raw('PINWALL_PUBLIC_ORIGIN') === undefined;

  // Listeners
  const listen = {
    host: r.read('PINWALL_HOST', text) ?? '0.0.0.0',
    port: r.read('PINWALL_PORT', wholeNumber(0, 65535)) ?? 8080,
  };
  const metricsPort = r.read('PINWALL_METRICS_PORT', wholeNumber(0, 65535)) ?? 9464;
  if (metricsPort !== 0 && metricsPort === listen.port) {
    r.fail('PINWALL_METRICS_PORT', 'must differ from PINWALL_PORT (or be 0 to disable metrics)');
  }

  // Data, database and blobs
  const dataDir = resolve(r.read('PINWALL_DATA_DIR', text) ?? '/data');
  const poolSize = r.read('PINWALL_DATABASE_POOL_SIZE', wholeNumber(1, 1000)) ?? 10;
  const defaultDatabase: Config['database'] = {
    kind: 'sqlite',
    path: resolve(dataDir, 'pinwall.db'),
  };
  const databaseRaw = r.secret('PINWALL_DATABASE_URL');
  const database =
    databaseRaw === undefined
      ? defaultDatabase
      : (r.validate(
          'PINWALL_DATABASE_URL',
          custom((value) => parseDatabase(value, dataDir, poolSize)),
          databaseRaw,
        ) ?? defaultDatabase);

  const storageKind =
    r.read('PINWALL_STORAGE', z.enum(['local', 's3'], { error: 'must be "local" or "s3"' })) ??
    'local';
  let storage: Config['storage'] = { kind: 'local', dir: resolve(dataDir, 'blobs') };
  if (storageKind === 's3') {
    const bucket = r.read('PINWALL_S3_BUCKET', text);
    if (bucket === undefined) r.fail('PINWALL_S3_BUCKET', 'required when PINWALL_STORAGE=s3');
    const endpoint = r.read('PINWALL_S3_ENDPOINT', custom(parseHttpUrl));
    const accessKeyId = r.secret('PINWALL_S3_ACCESS_KEY_ID');
    const secretAccessKey = r.secret('PINWALL_S3_SECRET_ACCESS_KEY');
    if (accessKeyId !== undefined && secretAccessKey === undefined) {
      r.fail('PINWALL_S3_SECRET_ACCESS_KEY', 'required when PINWALL_S3_ACCESS_KEY_ID is set');
    }
    if (secretAccessKey !== undefined && accessKeyId === undefined) {
      r.fail('PINWALL_S3_ACCESS_KEY_ID', 'required when PINWALL_S3_SECRET_ACCESS_KEY is set');
    }
    storage = {
      kind: 's3',
      bucket: bucket ?? '',
      region: r.read('PINWALL_S3_REGION', text) ?? 'us-east-1',
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(accessKeyId === undefined ? {} : { accessKeyId }),
      ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
      forcePathStyle: r.read('PINWALL_S3_FORCE_PATH_STYLE', stringBoolean) ?? false,
      prefix: r.read('PINWALL_S3_PREFIX', text) ?? '',
    };
  }

  // Content isolation
  const isolationMode =
    r.read(
      'PINWALL_ISOLATION',
      z.enum(['single-domain', 'content-domain'], {
        error: 'must be "single-domain" or "content-domain"',
      }),
    ) ?? 'single-domain';
  let isolation: Config['isolation'] = { mode: 'single-domain' };
  if (isolationMode === 'content-domain') {
    const contentRaw = r.raw('PINWALL_CONTENT_ORIGIN');
    if (contentRaw === undefined) {
      r.fail('PINWALL_CONTENT_ORIGIN', 'required when PINWALL_ISOLATION=content-domain');
    } else {
      const content = r.validate('PINWALL_CONTENT_ORIGIN', originSchema, contentRaw);
      if (content) {
        const appHost = publicOrigin.host;
        if (parseHostname(content.host).isIp) {
          r.fail(
            'PINWALL_CONTENT_ORIGIN',
            'must be a domain name, not an IP address: each artifact is served from its own subdomain',
          );
        } else if (
          publicOriginValid &&
          (content.host === appHost || appHost.endsWith(`.${content.host}`))
        ) {
          r.fail(
            'PINWALL_CONTENT_ORIGIN',
            "must not be the app host or a parent domain of it, or artifacts could reach the app's cookies",
          );
        } else {
          const contentDomain = getDomain(content.host, { allowPrivateDomains: true });
          const appDomain = getDomain(appHost, { allowPrivateDomains: true });
          if (contentDomain !== null && contentDomain === appDomain) {
            warnings.push(
              `PINWALL_CONTENT_ORIGIN shares the registrable domain ${contentDomain} with PINWALL_PUBLIC_ORIGIN, ` +
                'so artifacts and the app are same-site; use a separate registrable domain for full isolation.',
            );
          }
        }
        isolation = {
          mode: 'content-domain',
          contentOrigin: {
            scheme: content.scheme,
            host: content.host,
            ...(content.port === undefined ? {} : { port: content.port }),
          },
        };
      }
    }
  }

  // Secrets and proxy trust
  const secretKeyRaw = r.secret('PINWALL_SECRET_KEY');
  const secretKey =
    secretKeyRaw === undefined
      ? null
      : (r.validate('PINWALL_SECRET_KEY', custom(decodeSecretKey), secretKeyRaw) ?? null);
  const secretKeySet =
    r.raw('PINWALL_SECRET_KEY') !== undefined || r.raw('PINWALL_SECRET_KEY_FILE') !== undefined;
  if (database.kind === 'postgres' && !secretKeySet) {
    r.fail(
      'PINWALL_SECRET_KEY',
      'required when the database is PostgreSQL: without it a key is generated into the data dir, ' +
        'which a container without a persistent volume loses on every restart, and what was ' +
        'encrypted with the old key can no longer be read. Set PINWALL_SECRET_KEY or ' +
        'PINWALL_SECRET_KEY_FILE (generate one with: openssl rand -hex 32)',
    );
  }
  const trustProxy = r.read('PINWALL_TRUST_PROXY', custom(parseTrustProxy)) ?? false;

  // Single sign-on
  let oidc: Config['oidc'] = null;
  const issuerRaw = r.raw('PINWALL_OIDC_ISSUER');
  const clientIdRaw = r.raw('PINWALL_OIDC_CLIENT_ID');
  const clientSecret = r.secret('PINWALL_OIDC_CLIENT_SECRET');
  if (issuerRaw !== undefined || clientIdRaw !== undefined || clientSecret !== undefined) {
    if (issuerRaw === undefined) {
      r.fail('PINWALL_OIDC_ISSUER', 'required when other PINWALL_OIDC_* credentials are set');
    }
    if (clientIdRaw === undefined) {
      r.fail('PINWALL_OIDC_CLIENT_ID', 'required when other PINWALL_OIDC_* credentials are set');
    }
    const issuer =
      issuerRaw === undefined
        ? undefined
        : r.validate('PINWALL_OIDC_ISSUER', custom(parseHttpUrl), issuerRaw);
    const scopes = parseList(r.raw('PINWALL_OIDC_SCOPES') ?? 'openid email profile offline_access');
    if (!scopes.includes('openid')) {
      r.fail('PINWALL_OIDC_SCOPES', 'must include the openid scope');
    }
    const rolesClaim = r.read('PINWALL_OIDC_ROLES_CLAIM', text);
    if (issuer !== undefined && clientIdRaw !== undefined) {
      oidc = {
        issuer,
        clientId: clientIdRaw,
        ...(clientSecret === undefined ? {} : { clientSecret }),
        scopes,
        displayName: r.read('PINWALL_OIDC_DISPLAY_NAME', text) ?? 'Single sign-on',
        extraAuthParams: r.read('PINWALL_OIDC_EXTRA_AUTH_PARAMS', custom(parseAuthParams)) ?? {},
        ...(rolesClaim === undefined ? {} : { rolesClaim }),
        adminGroups: parseList(r.raw('PINWALL_OIDC_ADMIN_GROUPS')),
        memberGroups: parseList(r.raw('PINWALL_OIDC_MEMBER_GROUPS')),
      };
    }
  }

  // Access policy
  const lower = (entry: string) => entry.toLowerCase();
  const access = {
    adminEmails: r.list('PINWALL_ADMIN_EMAILS', lower, isEmail),
    memberEmails: r.list('PINWALL_MEMBER_EMAILS', lower, isEmail),
    memberDomains: r.list(
      'PINWALL_MEMBER_DOMAINS',
      (entry) => entry.replace(/^@/, '').toLowerCase(),
      (entry) => entry.length > 0,
    ),
    recheckIntervalMs:
      r.read(
        'PINWALL_ACCESS_RECHECK_INTERVAL',
        custom(parseDuration).pipe(
          z
            .number()
            .min(
              MIN_RECHECK_INTERVAL_MS,
              'must be at least 5m: a shorter interval asks the IdP on nearly every request',
            )
            .max(DAY_MS, 'must be at most 24h: access is re-checked with the IdP at least daily'),
        ),
      ) ?? 12 * 3_600_000,
  };

  // Limits and lifetimes
  const limits = {
    maxUploadBytes: r.read('PINWALL_MAX_UPLOAD_BYTES', positiveSize) ?? 95_000_000,
    maxInlineBytes: r.read('PINWALL_MAX_INLINE_BYTES', positiveSize) ?? 2_000_000,
    maxFileBytes: r.read('PINWALL_MAX_FILE_BYTES', positiveSize) ?? 50_000_000,
    maxVersionBytes: r.read('PINWALL_MAX_VERSION_BYTES', positiveSize) ?? 500_000_000,
    maxFiles: r.read('PINWALL_MAX_FILES', wholeNumber(1)) ?? 10_000,
    maxExpansionRatio: r.read('PINWALL_MAX_EXPANSION_RATIO', wholeNumber(1)) ?? 100,
  };
  const ttl = {
    sessionMs: r.read('PINWALL_SESSION_TTL', positiveDuration) ?? 30 * DAY_MS,
    previewMs: r.read('PINWALL_PREVIEW_TTL', positiveDuration) ?? 12 * 3_600_000,
    uploadSessionMs: r.read('PINWALL_UPLOAD_SESSION_TTL', positiveDuration) ?? 10 * 60_000,
  };

  // Operations
  const logLevel =
    r.read(
      'PINWALL_LOG_LEVEL',
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'], {
        error: 'must be one of fatal, error, warn, info, debug, trace',
      }),
    ) ?? 'info';
  const webDirRaw = r.read('PINWALL_WEB_DIR', text);

  if (r.issues.length > 0) throw new ConfigError(r.issues);

  return {
    publicOrigin: publicOrigin.origin,
    publicHttps: publicOrigin.scheme === 'https',
    listen,
    dataDir,
    database,
    storage,
    isolation,
    secretKey,
    trustProxy,
    oidc,
    access,
    limits,
    ttl,
    metrics: { port: metricsPort },
    logLevel,
    webDir: webDirRaw === undefined ? null : resolve(webDirRaw),
    warnings,
  };
}
