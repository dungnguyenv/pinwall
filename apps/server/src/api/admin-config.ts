import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { AdminConfig, type ConfigEntry, type ConfigSection, ErrorBody } from '@pinwall/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireAdmin } from '../auth/guards.ts';
import type { Config } from '../config/types.ts';

/**
 * One environment variable as the admin view shows it. A plain setting reads its effective value
 * back out of `Config`, written as it would be in the environment (`null` when not set). A secret
 * has no reader at all, only `isSet`, so its value cannot reach a response.
 */
export type ConfigSetting = {
  section: ConfigSection;
  env: string;
  /** Leaves the setting out unless it applies, e.g. the S3 settings with local storage. */
  appliesTo?: (config: Config) => boolean;
} & (
  | { secret: false; read: (config: Config) => string | null }
  | { secret: true; isSet: (config: Config) => boolean }
);

const DURATION_UNITS = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
] as const;

/**
 * A URL without its secrets: `${protocol}//${username@}${host}${pathname}`, dropping the password,
 * the query (`?password=` works for PostgreSQL) and the fragment. A bare root path is kept only
 * when it was written, since an OIDC issuer has to match exactly.
 */
export function redactUrl(url: string): string {
  const u = new URL(url);
  const written = url.split(/[?#]/, 1)[0] ?? '';
  const path = u.pathname === '/' && !written.endsWith('/') ? '' : u.pathname;
  return `${u.protocol}//${u.username ? `${u.username}@` : ''}${u.host}${path}`;
}

/** A duration in the largest unit of d, h, m, s that divides it exactly; otherwise in `ms`. */
export function formatDuration(ms: number): string {
  for (const [unit, size] of DURATION_UNITS) {
    if (ms > 0 && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

const list = (entries: string[]): string | null => (entries.length > 0 ? entries.join(', ') : null);
const s3Of = (c: Config) => (c.storage.kind === 's3' ? c.storage : null);
const isS3 = (c: Config) => c.storage.kind === 's3';

function contentOrigin(c: Config): string | null {
  if (c.isolation.mode !== 'content-domain') return null;
  const { scheme, host, port } = c.isolation.contentOrigin;
  return `${scheme}://${host}${port === undefined ? '' : `:${port}`}`;
}

const setting = (
  section: ConfigSection,
  env: string,
  read: (config: Config) => string | null,
  appliesTo?: (config: Config) => boolean,
): ConfigSetting => ({ section, env, secret: false, read, ...(appliesTo ? { appliesTo } : {}) });

const secret = (
  section: ConfigSection,
  env: string,
  isSet: (config: Config) => boolean,
  appliesTo?: (config: Config) => boolean,
): ConfigSetting => ({ section, env, secret: true, isSet, ...(appliesTo ? { appliesTo } : {}) });

/**
 * Every infrastructure setting, grouped by section in `ConfigSection` order and, within a
 * section, in the order of the roadmap's Configuration table. It says how the admin view reads
 * each setting; `config/catalog.ts` holds the text about the same variables for the generated
 * configuration reference, and a test keeps the two lists, sections and defaults in step.
 */
export const CONFIG_SETTINGS: readonly ConfigSetting[] = [
  setting('general', 'PINWALL_PUBLIC_ORIGIN', (c) => c.publicOrigin),
  setting('general', 'PINWALL_HOST', (c) => c.listen.host),
  setting('general', 'PINWALL_PORT', (c) => String(c.listen.port)),
  setting('general', 'PINWALL_DATA_DIR', (c) => c.dataDir),
  // With SQLite and no key given, the server generates one into the data dir before serving.
  secret('general', 'PINWALL_SECRET_KEY', (c) => c.secretKey !== null),
  setting('general', 'PINWALL_TRUST_PROXY', (c) =>
    typeof c.trustProxy === 'boolean' ? String(c.trustProxy) : c.trustProxy.join(', '),
  ),
  setting('general', 'PINWALL_METRICS_PORT', (c) => String(c.metrics.port)),
  setting('general', 'PINWALL_LOG_LEVEL', (c) => c.logLevel),
  setting('general', 'PINWALL_WEB_DIR', (c) => c.webDir),

  setting('isolation', 'PINWALL_ISOLATION', (c) => c.isolation.mode),
  setting('isolation', 'PINWALL_CONTENT_ORIGIN', contentOrigin),

  setting('database', 'PINWALL_DATABASE_URL', (c) =>
    c.database.kind === 'sqlite' ? `sqlite:${c.database.path}` : redactUrl(c.database.url),
  ),
  setting('database', 'PINWALL_DATABASE_POOL_SIZE', (c) =>
    c.database.kind === 'postgres' ? String(c.database.poolSize) : null,
  ),

  setting('storage', 'PINWALL_STORAGE', (c) => c.storage.kind),
  setting('storage', 'PINWALL_S3_BUCKET', (c) => s3Of(c)?.bucket ?? null, isS3),
  setting('storage', 'PINWALL_S3_REGION', (c) => s3Of(c)?.region ?? null, isS3),
  setting(
    'storage',
    'PINWALL_S3_ENDPOINT',
    (c) => {
      const endpoint = s3Of(c)?.endpoint;
      return endpoint === undefined ? null : redactUrl(endpoint);
    },
    isS3,
  ),
  secret('storage', 'PINWALL_S3_ACCESS_KEY_ID', (c) => s3Of(c)?.accessKeyId !== undefined, isS3),
  secret(
    'storage',
    'PINWALL_S3_SECRET_ACCESS_KEY',
    (c) => s3Of(c)?.secretAccessKey !== undefined,
    isS3,
  ),
  setting(
    'storage',
    'PINWALL_S3_FORCE_PATH_STYLE',
    (c) => {
      const s3 = s3Of(c);
      return s3 ? String(s3.forcePathStyle) : null;
    },
    isS3,
  ),
  setting('storage', 'PINWALL_S3_PREFIX', (c) => s3Of(c)?.prefix || null, isS3),

  setting('sign_in', 'PINWALL_OIDC_ISSUER', (c) => (c.oidc ? redactUrl(c.oidc.issuer) : null)),
  setting('sign_in', 'PINWALL_OIDC_CLIENT_ID', (c) => c.oidc?.clientId ?? null),
  secret('sign_in', 'PINWALL_OIDC_CLIENT_SECRET', (c) => c.oidc?.clientSecret !== undefined),
  setting('sign_in', 'PINWALL_OIDC_SCOPES', (c) => c.oidc?.scopes.join(' ') ?? null),
  setting('sign_in', 'PINWALL_OIDC_DISPLAY_NAME', (c) => c.oidc?.displayName ?? null),
  setting('sign_in', 'PINWALL_OIDC_EXTRA_AUTH_PARAMS', (c) =>
    c.oidc ? new URLSearchParams(c.oidc.extraAuthParams).toString() || null : null,
  ),
  setting('sign_in', 'PINWALL_OIDC_ALLOW_HTTP_ISSUER', (c) =>
    c.oidc ? String(c.oidc.allowHttpIssuer) : null,
  ),

  setting('access', 'PINWALL_OIDC_ROLES_CLAIM', (c) => c.oidc?.rolesClaim ?? null),
  setting('access', 'PINWALL_OIDC_ADMIN_GROUPS', (c) => list(c.oidc?.adminGroups ?? [])),
  setting('access', 'PINWALL_OIDC_MEMBER_GROUPS', (c) => list(c.oidc?.memberGroups ?? [])),
  setting('access', 'PINWALL_ADMIN_EMAILS', (c) => list(c.access.adminEmails)),
  setting('access', 'PINWALL_MEMBER_EMAILS', (c) => list(c.access.memberEmails)),
  setting('access', 'PINWALL_MEMBER_DOMAINS', (c) => list(c.access.memberDomains)),
  setting('access', 'PINWALL_ACCESS_RECHECK_INTERVAL', (c) =>
    formatDuration(c.access.recheckIntervalMs),
  ),

  setting('spaces', 'PINWALL_VISIBILITY', (c) => c.visibility),
  setting('spaces', 'PINWALL_SHARE_LINKS', (c) => c.shareLinks),
  setting('spaces', 'PINWALL_ABUSE_CONTACT', (c) => c.abuseContact),
  setting('spaces', 'PINWALL_TERMS_URL', (c) => c.termsUrl),
  setting('spaces', 'PINWALL_PRIVACY_URL', (c) => c.privacyUrl),

  setting('limits', 'PINWALL_MAX_UPLOAD_BYTES', (c) => String(c.limits.maxUploadBytes)),
  setting('limits', 'PINWALL_MAX_INLINE_BYTES', (c) => String(c.limits.maxInlineBytes)),
  setting('limits', 'PINWALL_MAX_FILE_BYTES', (c) => String(c.limits.maxFileBytes)),
  setting('limits', 'PINWALL_MAX_VERSION_BYTES', (c) => String(c.limits.maxVersionBytes)),
  setting('limits', 'PINWALL_MAX_FILES', (c) => String(c.limits.maxFiles)),
  setting('limits', 'PINWALL_MAX_EXPANSION_RATIO', (c) => String(c.limits.maxExpansionRatio)),
  setting('limits', 'PINWALL_QUOTA_BYTES', (c) => String(c.quota.bytes)),
  setting('limits', 'PINWALL_QUOTA_ARTIFACTS', (c) => String(c.quota.artifacts)),
  setting('limits', 'PINWALL_QUOTA_FILES', (c) => String(c.quota.files)),

  setting('lifetimes', 'PINWALL_SESSION_TTL', (c) => formatDuration(c.ttl.sessionMs)),
  setting('lifetimes', 'PINWALL_PREVIEW_TTL', (c) => formatDuration(c.ttl.previewMs)),
  setting('lifetimes', 'PINWALL_UPLOAD_SESSION_TTL', (c) => formatDuration(c.ttl.uploadSessionMs)),
];

/**
 * The startup warnings with every configured URL in its redacted form: a warning may quote one
 * (the http: issuer warning does), and a URL can carry a password.
 */
function redactedWarnings(c: Config): string[] {
  const urls = [
    c.database.kind === 'postgres' ? c.database.url : undefined,
    s3Of(c)?.endpoint,
    c.oidc?.issuer,
  ].filter((url) => url !== undefined);
  return c.warnings.map((warning) =>
    urls.reduce((text, url) => text.replaceAll(url, redactUrl(url)), warning),
  );
}

/** The effective configuration as admins see it, built from `config` alone; no secret values. */
export function describeConfig(config: Config): AdminConfig {
  const entries = CONFIG_SETTINGS.filter((s) => s.appliesTo?.(config) ?? true).map(
    (s): ConfigEntry => {
      if (s.secret) {
        return { section: s.section, env: s.env, value: null, secret: true, set: s.isSet(config) };
      }
      const value = s.read(config);
      return { section: s.section, env: s.env, value, secret: false, set: value !== null };
    },
  );
  return {
    isolation: config.isolation.mode,
    content_origin: contentOrigin(config),
    entries,
    warnings: redactedWarnings(config),
  };
}

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

const getAdminConfig = createRoute({
  method: 'get',
  path: '/admin/config',
  tags: ['admin'],
  summary: 'Read the effective configuration',
  description:
    'Every infrastructure setting, named by the environment variable that sets it, with the value the server runs with. ' +
    'Pinwall only shows these: change them in the deployment and restart. Secrets are never returned, only whether each is set; ' +
    'URLs come without passwords or query strings. `isolation` says where artifact content is served: `single-domain` ' +
    "serves it from the app's own host in a sandbox, which needs nothing extra but shares the registrable domain; " +
    '`content-domain` serves each version from its own host under `content_origin`, which isolates it fully but needs a ' +
    'second domain and a wildcard certificate.',
  middleware: [requireAdmin] as MiddlewareHandler<AppEnv>[],
  security: [{ session: [] }, { bearer: [] }],
  responses: {
    200: {
      description: 'The effective configuration',
      content: { 'application/json': { schema: AdminConfig } },
    },
    401: error('Not signed in'),
    403: error('Not an admin (`forbidden`)'),
  },
});

export function registerAdminConfigRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(getAdminConfig, (c) =>
    c.json(describeConfig(c.var.deps.config), 200, { 'Cache-Control': 'no-store' }),
  );
}
