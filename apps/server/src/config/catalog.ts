import type { ConfigSection } from '@pinwall/shared';

/**
 * Everything an operator needs to know about one environment variable. `loadConfig` is the code
 * that reads them; this catalog is the text about them, and `docs/configuration.md` is rendered
 * from it. A test keeps the three in step: the names, the secret flags and every default.
 */
export interface ConfigVar {
  /** The environment variable, e.g. `PINWALL_MAX_UPLOAD_BYTES`. */
  name: string;
  section: ConfigSection;
  /** Read with `EnvReader.secret`, so `<NAME>_FILE` works too. */
  secret: boolean;
  /**
   * The value to put in the environment to get the default, e.g. `95000000`, `12h`,
   * `single-domain`. `null` when there is no default or none that can be written as a value.
   */
  default: string | null;
  /** The default in words, for a variable whose default is no fixed value, e.g. a generated key. */
  defaultNote?: string;
  /** Original wording, at most 400 characters, with no `|` or line break (it goes in a table cell). */
  description: string;
}

/** The headings of the generated document, one per section, in the order of `ConfigSection`. */
export const SECTION_TITLES: Record<ConfigSection, string> = {
  general: 'General',
  isolation: 'Content isolation',
  database: 'Database',
  storage: 'Storage',
  sign_in: 'Single sign-on',
  access: 'Roles and access',
  spaces: 'Spaces and sharing',
  limits: 'Upload limits',
  lifetimes: 'Lifetimes',
};

const SECTION_INTROS: Record<ConfigSection, string> = {
  general:
    'Where Pinwall listens, what address it presents to the world, and where it keeps its files.',
  isolation:
    "Artifacts are untrusted pages, so Pinwall serves them apart from the app's own pages. Changing either variable takes a restart.",
  database: 'Pinwall keeps its data in SQLite (the default) or PostgreSQL.',
  storage:
    'Artifact files live on the local disk (the default) or in an S3-compatible bucket. The `PINWALL_S3_*` variables apply only with `PINWALL_STORAGE=s3`.',
  sign_in:
    'Single sign-on through an OpenID Connect identity provider. It is on when the issuer and the client id are set, and off when neither is. Setting only one of them, or a client secret without them, stops Pinwall at startup.',
  access:
    'Who the identity provider admits, and as what: admin or member. People who sign in with the owner account are not affected by these.',
  spaces:
    'Whether every member sees every project, or each person has a space of their own. Changing it takes a restart.',
  limits:
    'The `*_BYTES` limits accept the size syntax above. A publish that goes over any limit is refused.',
  lifetimes: 'Durations accept the syntax above.',
};

/**
 * Every variable `loadConfig` reads, grouped by section and, inside a section, in the order the
 * roadmap's Configuration table lists them. The admin page shows the same variables in the same
 * sections.
 */
export const CONFIG_VARS: readonly ConfigVar[] = [
  // General
  {
    name: 'PINWALL_PUBLIC_ORIGIN',
    section: 'general',
    secret: false,
    default: 'http://localhost:8080',
    description:
      'The address people use to reach Pinwall: scheme, host and optional port, with no path. Every link, redirect, passkey and cookie setting is built from it, and an https origin turns on secure cookies and HSTS. Set it to your real address.',
  },
  {
    name: 'PINWALL_HOST',
    section: 'general',
    secret: false,
    default: '0.0.0.0',
    description: 'The network address the app listens on. `0.0.0.0` means every interface.',
  },
  {
    name: 'PINWALL_PORT',
    section: 'general',
    secret: false,
    default: '8080',
    description:
      'The port the app listens on, from 0 to 65535 (0 lets the system pick a free one). The metrics listener must use a different port, see `PINWALL_METRICS_PORT`.',
  },
  {
    name: 'PINWALL_DATA_DIR',
    section: 'general',
    secret: false,
    default: '/data',
    description:
      'The folder for what Pinwall keeps on disk: the SQLite database, locally stored files, the generated secret key and temporary files such as backup spools. It must be writable, and persistent when you use SQLite or local storage.',
  },
  {
    name: 'PINWALL_SECRET_KEY',
    section: 'general',
    secret: true,
    default: null,
    defaultNote: 'generated into `<data dir>/secret.key` (SQLite only)',
    description:
      'The key that Pinwall derives its encryption and signing keys from: 64 hex characters or base64 that decodes to at least 32 bytes (`openssl rand -hex 32` makes one). Required with PostgreSQL. Keep it with your backups, because what it encrypts cannot be read without it.',
  },
  {
    name: 'PINWALL_TRUST_PROXY',
    section: 'general',
    secret: false,
    default: 'false',
    description:
      "Which reverse proxies to believe about the visitor address. `false` trusts none and ignores `X-Forwarded-For`. `true` trusts exactly one proxy. A comma-separated list of IP addresses or CIDR ranges trusts those proxies, for two or more in a row. Without a match, every visitor has the proxy's address and shares its limits per address: rate limits, and 20 open live-update streams.",
  },
  {
    name: 'PINWALL_METRICS_PORT',
    section: 'general',
    secret: false,
    default: '9464',
    description:
      'The port of the separate listener that serves Prometheus metrics at `/metrics`; the app port never serves them. 0 turns metrics off. It must differ from `PINWALL_PORT`. Keep this port off the public network.',
  },
  {
    name: 'PINWALL_LOG_LEVEL',
    section: 'general',
    secret: false,
    default: 'info',
    description:
      'How much the server logs, from least to most: `fatal`, `error`, `warn`, `info`, `debug`, `trace`. Logs are JSON lines.',
  },
  {
    name: 'PINWALL_WEB_DIR',
    section: 'general',
    secret: false,
    default: null,
    defaultNote: 'the web app bundled with the server',
    description:
      'The folder the web app is served from. Leave it unset to use the copy bundled with Pinwall; set it only to serve a build of your own.',
  },

  // Content isolation
  {
    name: 'PINWALL_ISOLATION',
    section: 'isolation',
    secret: false,
    default: 'single-domain',
    description:
      "Where artifact pages are served from. `single-domain` serves them from the app's own host inside a sandbox and needs nothing extra. `content-domain` gives each version its own host under `PINWALL_CONTENT_ORIGIN`, which isolates artifacts fully but needs a second domain with a wildcard certificate.",
  },
  {
    name: 'PINWALL_CONTENT_ORIGIN',
    section: 'isolation',
    secret: false,
    default: null,
    defaultNote: 'none; required with `content-domain`',
    description:
      "The origin artifacts are served under in `content-domain` mode, such as `https://pinwall-content.example`; each version gets `<token>.<host>`. It must be a domain name, not an IP address, and not the app host or a parent of it, and it must use https when `PINWALL_PUBLIC_ORIGIN` does. A warning is logged when it shares the app's registrable domain.",
  },

  // Database
  {
    name: 'PINWALL_DATABASE_URL',
    section: 'database',
    secret: true,
    default: null,
    defaultNote: 'SQLite at `<data dir>/pinwall.db`',
    description:
      'Where Pinwall keeps its data: `sqlite:<path>` (a relative path is inside the data dir) or a `postgres://` or `postgresql://` URL, which may carry a password. PostgreSQL needs `PINWALL_SECRET_KEY` as well.',
  },
  {
    name: 'PINWALL_DATABASE_POOL_SIZE',
    section: 'database',
    secret: false,
    default: '10',
    description:
      'The most PostgreSQL connections one Pinwall process opens, from 1 to 1000. `pinwall backup` and `pinwall restore` open one more, for their lease. Opening a connection, or waiting for a free one when all are busy, fails after 10 seconds. SQLite ignores it.',
  },

  // Storage
  {
    name: 'PINWALL_STORAGE',
    section: 'storage',
    secret: false,
    default: 'local',
    description:
      'Where artifact files are stored: `local` (the `blobs` folder in the data dir) or `s3` (an S3-compatible bucket, which also needs `PINWALL_S3_BUCKET`).',
  },
  {
    name: 'PINWALL_S3_BUCKET',
    section: 'storage',
    secret: false,
    default: null,
    defaultNote: 'none; required with `s3`',
    description: 'The bucket that holds artifact files. Pinwall does not create it.',
  },
  {
    name: 'PINWALL_S3_REGION',
    section: 'storage',
    secret: false,
    default: 'us-east-1',
    description:
      'The region of the bucket. S3-compatible services that have no regions usually accept the default.',
  },
  {
    name: 'PINWALL_S3_ENDPOINT',
    section: 'storage',
    secret: false,
    default: null,
    defaultNote: 'Amazon S3',
    description:
      'The address of an S3-compatible service such as MinIO, as an `http://` or `https://` URL. Leave it unset for Amazon S3.',
  },
  {
    name: 'PINWALL_S3_ACCESS_KEY_ID',
    section: 'storage',
    secret: true,
    default: null,
    defaultNote: "the credentials of the machine Pinwall runs on (the AWS SDK's default chain)",
    description:
      'The access key id Pinwall signs in to the bucket with. Set it together with `PINWALL_S3_SECRET_ACCESS_KEY`, or set neither to use the role or credentials of the environment.',
  },
  {
    name: 'PINWALL_S3_SECRET_ACCESS_KEY',
    section: 'storage',
    secret: true,
    default: null,
    defaultNote: 'none; set together with the access key id',
    description: 'The secret that goes with the access key id. The two are set together.',
  },
  {
    name: 'PINWALL_S3_FORCE_PATH_STYLE',
    section: 'storage',
    secret: false,
    default: 'false',
    description:
      'Put the bucket name in the URL path (`host/bucket`) instead of the host name (`bucket.host`). Many self-hosted S3 services need `true`.',
  },
  {
    name: 'PINWALL_S3_PREFIX',
    section: 'storage',
    secret: false,
    default: null,
    defaultNote: 'empty',
    description:
      'Text put in front of every object key, so one bucket can be shared. Files are stored as `<prefix>blobs/<sha256>`; end it with a slash for a folder, for example `pinwall/`.',
  },

  // Single sign-on
  {
    name: 'PINWALL_OIDC_ISSUER',
    section: 'sign_in',
    secret: false,
    default: null,
    defaultNote: 'none; single sign-on is off',
    description:
      'The issuer URL of your OpenID Connect identity provider. It must use `https` unless `PINWALL_OIDC_ALLOW_HTTP_ISSUER` is `true`. Register `<public origin>/auth/oidc/callback` as the redirect URI at the provider, and `<public origin>/auth/oidc/signed-out` as a post-logout redirect URI: "Use a different account" signs a refused person out at the provider first, when it supports that.',
  },
  {
    name: 'PINWALL_OIDC_CLIENT_ID',
    section: 'sign_in',
    secret: false,
    default: null,
    defaultNote: 'none; required with the issuer',
    description: 'The client id Pinwall is registered under at the identity provider.',
  },
  {
    name: 'PINWALL_OIDC_CLIENT_SECRET',
    section: 'sign_in',
    secret: true,
    default: null,
    defaultNote: 'none; Pinwall then acts as a public client',
    description:
      'The client secret for a confidential client. Leave it unset when the provider registered Pinwall as a public client.',
  },
  {
    name: 'PINWALL_OIDC_SCOPES',
    section: 'sign_in',
    secret: false,
    default: 'openid email profile offline_access',
    description:
      "The scopes Pinwall asks for at sign-in, separated by spaces or commas. `openid` is required. `offline_access` lets Pinwall re-check someone's access with a refresh token.",
  },
  {
    name: 'PINWALL_OIDC_DISPLAY_NAME',
    section: 'sign_in',
    secret: false,
    default: 'Single sign-on',
    description: 'The text on the sign-in button.',
  },
  {
    name: 'PINWALL_OIDC_EXTRA_AUTH_PARAMS',
    section: 'sign_in',
    secret: false,
    default: null,
    defaultNote: 'empty',
    description:
      'Extra query parameters for the sign-in request, written `name=value&name=value`. Google, for one, needs `access_type=offline` before it issues refresh tokens.',
  },
  {
    name: 'PINWALL_OIDC_ALLOW_HTTP_ISSUER',
    section: 'sign_in',
    secret: false,
    default: 'false',
    description:
      'Allow an issuer reached over plain `http`. Anyone on the network path to such a provider can forge any identity, admins included, so use it only for tests or a trusted private network. A warning is logged at start.',
  },

  // Roles and access
  {
    name: 'PINWALL_OIDC_ROLES_CLAIM',
    section: 'access',
    secret: false,
    default: null,
    defaultNote: 'none; groups are not read',
    description:
      "The claim in the sign-in token that lists a person's groups or roles: a string, an array, or an object whose keys are the groups. A dotted name such as `realm_access.roles` reads a nested claim.",
  },
  {
    name: 'PINWALL_OIDC_ADMIN_GROUPS',
    section: 'access',
    secret: false,
    default: null,
    defaultNote: 'none',
    description:
      'Groups whose members become admins, separated by commas. Names must match exactly, including case. Requires `PINWALL_OIDC_ROLES_CLAIM`: without it Pinwall does not start.',
  },
  {
    name: 'PINWALL_OIDC_MEMBER_GROUPS',
    section: 'access',
    secret: false,
    default: null,
    defaultNote: 'none',
    description:
      'Groups whose members become members, separated by commas. Names must match exactly, including case. Requires `PINWALL_OIDC_ROLES_CLAIM`: without it Pinwall does not start.',
  },
  {
    name: 'PINWALL_ADMIN_EMAILS',
    section: 'access',
    secret: false,
    default: null,
    defaultNote: 'none',
    description:
      'Email addresses that become admins, separated by commas. Matched ignoring case, and only when the provider says the email is verified.',
  },
  {
    name: 'PINWALL_MEMBER_EMAILS',
    section: 'access',
    secret: false,
    default: null,
    defaultNote: 'none',
    description:
      'Email addresses that become members, separated by commas. Matched ignoring case, and only when the provider says the email is verified.',
  },
  {
    name: 'PINWALL_MEMBER_DOMAINS',
    section: 'access',
    secret: false,
    default: null,
    defaultNote: 'none',
    description:
      'Email domains whose verified addresses become members, such as `example.com`. When no member group, email or domain is set, everyone the provider admits is a member.',
  },
  {
    name: 'PINWALL_ACCESS_RECHECK_INTERVAL',
    section: 'access',
    secret: false,
    default: '12h',
    description:
      'How often Pinwall asks the identity provider whether someone still has access, from `5m` to `24h`. Someone removed at the provider loses access by the next check.',
  },

  // Spaces and sharing
  {
    name: 'PINWALL_VISIBILITY',
    section: 'spaces',
    secret: false,
    default: 'team',
    description:
      'team: every member sees every project, as in Pinwall 1.0. personal: each person sees only the projects they own or were added to. Going from personal back to team needs pinwall visibility team --confirm once.',
  },
  {
    name: 'PINWALL_SHARE_LINKS',
    section: 'spaces',
    secret: false,
    default: 'members',
    description:
      "members: any member may make share links and open raw links, as in Pinwall 1.0. approved: only admins and the members an admin approved in Admin → Users may; everyone else's pages open only inside Pinwall's viewer. Approve people before switching: links made by others stop opening.",
  },

  // Upload limits
  {
    name: 'PINWALL_MAX_UPLOAD_BYTES',
    section: 'limits',
    secret: false,
    default: '95000000',
    description:
      'The largest single upload request. The default sits under the 100 MB request cap that Cloudflare applies on its Free and Pro plans; raise it only when nothing in front of Pinwall caps requests.',
  },
  {
    name: 'PINWALL_MAX_INLINE_BYTES',
    section: 'limits',
    secret: false,
    default: '2000000',
    description:
      'The most content an agent can send inline, inside the request itself, in one publish over MCP. Larger publishes use an upload URL.',
  },
  {
    name: 'PINWALL_MAX_FILE_BYTES',
    section: 'limits',
    secret: false,
    default: '50000000',
    description: 'The largest single file inside an artifact version.',
  },
  {
    name: 'PINWALL_MAX_VERSION_BYTES',
    section: 'limits',
    secret: false,
    default: '500000000',
    description: 'The largest total size of an artifact version once it is unpacked.',
  },
  {
    name: 'PINWALL_MAX_FILES',
    section: 'limits',
    secret: false,
    default: '10000',
    description: 'The most files one artifact version can hold.',
  },
  {
    name: 'PINWALL_MAX_EXPANSION_RATIO',
    section: 'limits',
    secret: false,
    default: '100',
    description:
      'How many times larger than its compressed upload a version may unpack to. It stops archive bombs.',
  },
  {
    name: 'PINWALL_QUOTA_BYTES',
    section: 'limits',
    secret: false,
    default: '0',
    description:
      "The most a person may store, as the total size of their versions, each counted in full. 0 means no limit. In personal mode it counts the projects a person owns, editors' publishes included; in team mode what they published. Admins have no limit, and an admin can set another value for one person.",
  },
  {
    name: 'PINWALL_QUOTA_ARTIFACTS',
    section: 'limits',
    secret: false,
    default: '0',
    description:
      'The most artifacts a person may have, counted like PINWALL_QUOTA_BYTES. 0 means no limit.',
  },

  // Lifetimes
  {
    name: 'PINWALL_SESSION_TTL',
    section: 'lifetimes',
    secret: false,
    default: '30d',
    description:
      'How long a browser session lasts without use. Each visit extends it, so an active person stays signed in.',
  },
  {
    name: 'PINWALL_PREVIEW_TTL',
    section: 'lifetimes',
    secret: false,
    default: '12h',
    description:
      'How long the content access Pinwall grants for viewing an artifact lasts, in the review viewer and in raw links. A share link that expires sooner cuts it short.',
  },
  {
    name: 'PINWALL_UPLOAD_SESSION_TTL',
    section: 'lifetimes',
    secret: false,
    default: '10m',
    description: 'How long a one-time upload URL stays usable after Pinwall hands it out.',
  },
];

const INTRO = `Pinwall reads its infrastructure settings from environment variables, and from nothing else. The admin page under **Configuration** shows what the server runs with; it never changes anything, so edit your deployment and restart.

A variable marked **secret** can also be given as \`<NAME>_FILE\`, the path of a file that holds the value, which is how container and Kubernetes secrets are usually mounted. Set \`<NAME>\` or \`<NAME>_FILE\`, not both: Pinwall refuses to start when both are set. Pinwall never shows a secret's value on the admin page, and never writes it to its logs or to a backup.

Values are written like this:

- **Durations** are a whole or decimal number with an optional unit: \`ms\`, \`s\`, \`m\`, \`h\` or \`d\`. A bare number is milliseconds. Examples: \`500\`, \`30s\`, \`15m\`, \`12h\`, \`7d\`.
- **Sizes** are a number with an optional unit: \`B\`, the decimal \`KB\`, \`MB\` and \`GB\`, or the binary \`KiB\`, \`MiB\` and \`GiB\`. A bare number is bytes. Examples: \`95000000\`, \`95MB\`, \`2GiB\`.
- **Numbers** that are not sizes or durations (ports, counts, the pool size, the expansion ratio) are whole numbers.
- **Lists** are separated by commas or spaces.
- **Booleans** are \`true\` or \`false\`.
- A variable that is empty or only blank counts as not set.`;

const FOOTER =
  'Generated from apps/server/src/config/catalog.ts by pnpm docs:config. Do not edit by hand.';

function defaultCell(v: ConfigVar): string {
  if (v.default !== null) return `\`${v.default}\``;
  return v.defaultNote ?? 'none';
}

function variableCell(v: ConfigVar): string {
  const name = `\`${v.name}\``;
  return v.secret ? `${name}<br>secret · also \`${v.name}_FILE\`` : name;
}

function renderSection(section: ConfigSection, vars: readonly ConfigVar[]): string {
  const rows = vars.map((v) => `| ${variableCell(v)} | ${defaultCell(v)} | ${v.description} |`);
  return [
    `## ${SECTION_TITLES[section]}`,
    '',
    SECTION_INTROS[section],
    '',
    '| Variable | Default | Description |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * The configuration reference as Markdown: an introduction, then one table per section that has
 * variables, in `ConfigSection` order. It holds only what the catalog holds, so no secret value
 * can appear in it.
 */
export function renderConfigurationDoc(vars: readonly ConfigVar[]): string {
  const sections = (Object.keys(SECTION_TITLES) as ConfigSection[])
    .map((section) => ({ section, vars: vars.filter((v) => v.section === section) }))
    .filter(({ vars: inSection }) => inSection.length > 0)
    .map(({ section, vars: inSection }) => renderSection(section, inSection));
  return `# Configuration\n\n${INTRO}\n\n${sections.join('\n\n')}\n\n${FOOTER}\n`;
}
