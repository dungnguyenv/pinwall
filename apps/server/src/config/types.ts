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
  limits: {
    maxUploadBytes: number;
    maxInlineBytes: number;
    maxFileBytes: number;
    maxVersionBytes: number;
    maxFiles: number;
    maxExpansionRatio: number;
  };
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
