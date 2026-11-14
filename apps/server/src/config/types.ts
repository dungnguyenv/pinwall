/** Whether every member sees every project (`team`), or each person has a space of their own. */
export type Visibility = 'team' | 'personal';

export interface Config {
  /** Origin only, no trailing slash, e.g. "https://pinwall.example". */
  publicOrigin: string;
  publicHttps: boolean;
  listen: { host: string; port: number };
  dataDir: string;
  database: { kind: 'sqlite'; path: string } | { kind: 'postgres'; url: string; poolSize: number };
  storage:
    | { kind: 'local'; dir: string }
    | {
        kind: 's3';
        bucket: string;
        region: string;
        endpoint?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        forcePathStyle: boolean;
        prefix: string;
      };
  isolation:
    | { mode: 'single-domain' }
    | {
        mode: 'content-domain';
        contentOrigin: { scheme: 'http' | 'https'; host: string; port?: number };
      };
  /**
   * `null` means `ensureSecretKey` generates and persists one. Only with SQLite: `loadConfig`
   * requires a key when the database is Postgres.
   */
  secretKey: Buffer | null;
  trustProxy: false | true | string[];
  oidc: null | {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    scopes: string[];
    displayName: string;
    extraAuthParams: Record<string, string>;
    /** `PINWALL_OIDC_ALLOW_HTTP_ISSUER`: an `http:` issuer was explicitly allowed. */
    allowHttpIssuer: boolean;
    rolesClaim?: string;
    adminGroups: string[];
    memberGroups: string[];
  };
  access: {
    adminEmails: string[];
    memberEmails: string[];
    memberDomains: string[];
    recheckIntervalMs: number;
  };
  /** `PINWALL_VISIBILITY`. Changing it takes a restart. */
  visibility: Visibility;
  /**
   * `PINWALL_SHARE_LINKS`: who may expose content outside Pinwall (share links, raw links, pages
   * opened top-level). `members`: everyone, as in 1.0; `approved`: admins and approved members.
   */
  shareLinks: 'members' | 'approved';
  /**
   * `PINWALL_ABUSE_CONTACT`: where people report abuse, an email address or an http(s) URL. Shown
   * on the pages for links that are gone or not found. `null`: no abuse line anywhere.
   */
  abuseContact: string | null;
  /** `PINWALL_TERMS_URL`: an http(s) URL of the terms of use, linked from the sign-in page. */
  termsUrl: string | null;
  /** `PINWALL_PRIVACY_URL`: an http(s) URL of the privacy notice, linked from the sign-in page. */
  privacyUrl: string | null;
  limits: {
    maxUploadBytes: number;
    maxInlineBytes: number;
    maxFileBytes: number;
    maxVersionBytes: number;
    maxFiles: number;
    maxExpansionRatio: number;
  };
  /**
   * `PINWALL_QUOTA_BYTES`, `PINWALL_QUOTA_ARTIFACTS` and `PINWALL_QUOTA_FILES`: what one person
   * may store, as the total size of their versions, their number of artifacts and the files of
   * all their versions. 0 means no limit.
   */
  quota: { bytes: number; artifacts: number; files: number };
  ttl: { sessionMs: number; previewMs: number; uploadSessionMs: number };
  metrics: { port: number };
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  webDir: string | null;
  /** Non-fatal notes the server logs at start. */
  warnings: string[];
}

/** Thrown once by `loadConfig` with every problem found, so an operator fixes them in one pass. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';

  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }
}
