# Pinwall M1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pnpm workspace whose server starts, loads configuration from the environment, migrates the full initial schema on SQLite or Postgres, stores blobs on disk or S3, answers `/healthz` and `/readyz`, renders HTML or JSON errors, serves the SPA, and runs as a read-only non-root container.

**Architecture:** See the roadmap. M1 builds the layers every later milestone stands on: `config/`, `lib/`, `db/`, `storage/`, `infra/`, `http/`, `pages/`, `app.ts`, `deps.ts`, `main.ts`.

**Tech Stack:** pnpm, TypeScript (strict), Biome, Vitest, Hono + `@hono/node-server`, zod, Kysely + better-sqlite3 + pg, `@aws-sdk/client-s3`, pino, esbuild, Docker.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md`. **Roadmap (shared names, data model, env vars, security model):** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md` — read its Global Constraints first; they apply to every task.

## Global Constraints

The roadmap's Global Constraints, plus for M1:
- Node.js `>=24` in every `package.json` `engines`; `.nvmrc` says `24`.
- `pnpm` pinned through the root `packageManager` field (current pnpm major at install time).
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, ESM only (`"type": "module"`).
- Default limits and env var names exactly as in the roadmap's Configuration table.

## Review Focus

From the roadmap, items owned by M1:
1. `foldForSearch` maps `đ`/`Đ` and strips combining marks from both NFC and NFD input → Task 2 test `folds Vietnamese in NFC and NFD`.
2. `publicUrl()` builds absolute URLs from `PINWALL_PUBLIC_ORIGIN` and ignores the request's `Host` and `X-Forwarded-*` → Task 7 test `public url ignores Host and forwarded headers`.
3. A config with both `PINWALL_X` and `PINWALL_X_FILE` set is ambiguous → Task 3 test `rejects both value and _FILE`.
4. SQLite opened by two processes (server plus `pinwall migrate`) → WAL + `busy_timeout` so the second waits instead of failing → Task 4 test `two handles on one file can both write`.
5. A blob `put` whose bytes do not hash to the given key → rejected, nothing stored → Task 5 contract test `rejects bytes that do not match the hash`.

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE` (full Apache-2.0 text), `NOTICE`, `README.md` (one paragraph + "status: in development")
- Create: `apps/server/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,test/smoke.test.ts}`
- Create: `apps/web/{package.json,tsconfig.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx,src/App.test.tsx,vitest.config.ts}`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts,src/i18n/en.json,test/smoke.test.ts}`
- Create: `packages/annotator/{package.json,tsconfig.json,src/index.ts,test/smoke.test.ts}`

**Interfaces:**
- Produces: package names `@pinwall/server`, `@pinwall/web`, `@pinwall/shared`, `@pinwall/annotator`; root scripts `build`, `test`, `lint`, `format`, `typecheck`, `test:integration`; `@pinwall/shared` exports `./i18n/en.json` and its `src/index.ts` (consumed via workspace TS source, no build step for shared in dev).

- [ ] **Step 1: Create the root files.** Root `package.json` is `private`, `"type": "module"`, `engines.node >=24`, `packageManager` pinned, scripts run `pnpm -r` equivalents (`typecheck` → `pnpm -r exec tsc --noEmit`, `test` → `pnpm -r test`, `lint` → `biome check .`). `biome.json`: recommended rules, 2-space indent, single quotes, line width 100, ignore `dist`, `node_modules`, `coverage`.
- [ ] **Step 2: Create the four packages and install dependencies.** Install with `pnpm add` (latest versions; check each license is in the roadmap's allowed list):
  - server: `hono @hono/node-server @hono/zod-openapi zod kysely better-sqlite3 pg @aws-sdk/client-s3 pino prom-client tar-stream fflate markdown-it markdown-it-anchor highlight.js htmlparser2 openid-client @simplewebauthn/server @modelcontextprotocol/sdk diff tldts`; dev: `typescript vitest tsx esbuild @types/node @types/better-sqlite3 @types/pg @types/tar-stream @types/markdown-it @types/diff oidc-provider`
  - web: `react react-dom react-router @tanstack/react-query radix-ui lucide-react i18next react-i18next @simplewebauthn/browser clsx sonner`; dev: `vite @vitejs/plugin-react tailwindcss @tailwindcss/vite typescript @types/react @types/react-dom vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom`
  - annotator: dev `esbuild vitest jsdom typescript`
  - root dev: `@biomejs/biome typescript @playwright/test`
  - `pnpm.onlyBuiltDependencies` allows `better-sqlite3` and `esbuild` install scripts.
- [ ] **Step 3: Write one smoke test per package.** Server: `test('server package loads', () => expect(typeof (await import('../src/index.ts'))).toBe('object'))`. Shared: `test('en.json has app.name', () => expect(en['app.name']).toBe('Pinwall'))`. Annotator: imports `src/index.ts`. Web: renders `<App />` and finds the text `Pinwall`.
- [ ] **Step 4: Verify.** Run: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @pinwall/web build`. Expected: all exit 0; four test files pass; `apps/web/dist/index.html` exists.
- [ ] **Step 5: Commit** `chore: scaffold pnpm workspace with server, web, shared and annotator packages`.

### Task 2: Core library — ids, errors, clock, crypto, search folding

**Files:**
- Create: `apps/server/src/lib/{ids.ts,errors.ts,clock.ts,crypto.ts,search-fold.ts,i18n.ts}`
- Test: `apps/server/test/lib/{ids,errors,crypto,search-fold,i18n}.test.ts`

**Interfaces:**
- Produces:
  - `type IdPrefix = 'usr'|'prj'|'art'|'ver'|'cmt'|'shr'|'tok'|'cli'|'pky'|'gnt'`; `newId(prefix: IdPrefix): string`; `newContentToken(): string`; `newSecret(): string`; `hashSecret(secret: string): string` (SHA-256 hex).
  - `type ErrorCode` (roadmap list); `class AppError extends Error { code; status; details? }`; factories `badRequest(msg, details?)`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `gone`, `payloadTooLarge`, `unsupportedMediaType`, `rateLimited(retryAfterSeconds)`, each returning `AppError` with the matching status (400, 401, 403, 404, 409, 410, 413, 415, 429).
  - `interface Clock { now(): number }` (epoch ms); `systemClock`; `class FixedClock implements Clock { constructor(start: number); advance(ms: number): void; set(ms: number): void }`.
  - `deriveKey(secret: Buffer, purpose: string): Buffer` (HKDF-SHA256, 32 bytes, info = `pinwall:` + purpose); `encryptString(key: Buffer, plaintext: string): string` (AES-256-GCM, format `v1.<iv>.<ciphertext>.<tag>` base64url); `decryptString(key: Buffer, payload: string): string` (throws on tamper or wrong key); `hashPassword(pw: string): Promise<string>` (scrypt N=2^15 r=8 p=1, 16-byte salt, format `scrypt$32768$8$1$<salt>$<hash>`); `verifyPassword(pw: string, stored: string): Promise<boolean>` (constant time); `safeEqual(a: string, b: string): boolean`.
  - `foldForSearch(text: string): string`.
  - `t(key: string, vars?: Record<string, string | number>): string` — reads `@pinwall/shared/i18n/en.json`, replaces `{{name}}`, returns the key itself when missing.

- [ ] **Step 1: Write failing tests.**

```ts
test('ids carry their prefix and 20 base32 chars', () => {
  expect(newId('art')).toMatch(/^art_[0-9a-hjkmnp-tv-z]{20}$/);
  expect(new Set(Array.from({ length: 1000 }, () => newId('art'))).size).toBe(1000);
});
test('content tokens are valid DNS labels', () => {
  expect(newContentToken()).toMatch(/^[0-9a-hjkmnp-tv-z]{32}$/);
});
test('secrets are 43 base64url chars and hash to 64 hex', () => {
  const s = newSecret();
  expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(hashSecret(s)).toMatch(/^[0-9a-f]{64}$/);
});
test('error factories set status and code', () => {
  expect(notFound('x')).toMatchObject({ status: 404, code: 'not_found', message: 'x' });
  expect(rateLimited(30)).toMatchObject({ status: 429, details: { retry_after_seconds: 30 } });
});
test('encrypt round-trips and detects tampering', () => {
  const k = deriveKey(Buffer.alloc(32, 7), 'idp-refresh-token');
  const c = encryptString(k, 'secret');
  expect(decryptString(k, c)).toBe('secret');
  expect(() => decryptString(k, c.slice(0, -2) + 'AA')).toThrow();
  expect(() => decryptString(deriveKey(Buffer.alloc(32, 7), 'other'), c)).toThrow();
});
test('passwords verify only with the right password', async () => {
  const h = await hashPassword('correct horse');
  expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
  expect(await verifyPassword('correct horse', h)).toBe(true);
  expect(await verifyPassword('wrong', h)).toBe(false);
});
test('folds Vietnamese in NFC and NFD', () => {
  expect(foldForSearch('Chụp ảnh Điện thoại')).toBe('chup anh dien thoai');
  expect(foldForSearch('Chụp ảnh'.normalize('NFD'))).toBe('chup anh');
  expect(foldForSearch('  Đà   Nẵng\n')).toBe('da nang');
});
test('t interpolates and falls back to the key', () => {
  expect(t('app.name')).toBe('Pinwall');
  expect(t('missing.key')).toBe('missing.key');
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/lib` — expected FAIL (modules missing).
- [ ] **Step 3: Implement the six modules** with the signatures above. Crockford base32 alphabet `0123456789abcdefghjkmnpqrstvwxyz`; `newId` uses 13 random bytes truncated to 100 bits (20 chars), `newContentToken` 20 bytes (32 chars). `foldForSearch`: NFD → remove `\p{M}` → replace `đ`→`d`, `Đ`→`D` → lowercase → collapse whitespace → trim. Add `"app.name": "Pinwall"` to `en.json`.
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit** `feat(server): add ids, errors, clock, crypto, search folding and i18n helpers`.

### Task 3: Configuration

**Files:**
- Create: `apps/server/src/config/{load.ts,parse.ts,secret-key.ts,types.ts}`
- Test: `apps/server/test/config/{load,secret-key}.test.ts`

**Interfaces:**
- Consumes: `AppError` is not used here; config errors use `ConfigError`.
- Produces (`types.ts`):

```ts
export interface Config {
  publicOrigin: string;                    // e.g. "https://pinwall.example" (no trailing slash)
  publicHttps: boolean;
  listen: { host: string; port: number };
  dataDir: string;
  database: { kind: 'sqlite'; path: string } | { kind: 'postgres'; url: string; poolSize: number };
  storage:
    | { kind: 'local'; dir: string }       // `${dataDir}/blobs`
    | { kind: 's3'; bucket: string; region: string; endpoint?: string; accessKeyId?: string;
        secretAccessKey?: string; forcePathStyle: boolean; prefix: string };
  isolation:
    | { mode: 'single-domain' }
    | { mode: 'content-domain'; contentOrigin: { scheme: 'http' | 'https'; host: string; port?: number } };
  secretKey: Buffer | null;                // null → ensureSecretKey generates one
  trustProxy: false | true | string[];
  oidc: null | { issuer: string; clientId: string; clientSecret?: string; scopes: string[];
    displayName: string; extraAuthParams: Record<string, string>; rolesClaim?: string;
    adminGroups: string[]; memberGroups: string[] };
  access: { adminEmails: string[]; memberEmails: string[]; memberDomains: string[]; recheckIntervalMs: number };
  limits: { maxUploadBytes: number; maxInlineBytes: number; maxFileBytes: number;
    maxVersionBytes: number; maxFiles: number; maxExpansionRatio: number };
  ttl: { sessionMs: number; previewMs: number; uploadSessionMs: number };
  metrics: { port: number };
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  webDir: string | null;
  warnings: string[];                      // non-fatal notes logged at start (e.g. shared registrable domain)
}
export class ConfigError extends Error { issues: string[] }
```

  - `loadConfig(env: Record<string, string | undefined>, io?: { readFile(path: string): string }): Config` — collects every issue before throwing one `ConfigError`.
  - `parseDuration(s: string): number`, `parseSize(s: string): number`, `parseList(s?: string): string[]` (comma/whitespace separated, trimmed, empty removed) in `parse.ts`.
  - `ensureSecretKey(config: Config, logger: { warn(msg: string): void }): Buffer` in `secret-key.ts`.

- [ ] **Step 1: Write failing tests** (`load.test.ts`), using an in-memory `readFile`:

```ts
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
test('reads _FILE secrets, trimmed', () => {
  const c = loadConfig({ PINWALL_OIDC_ISSUER: 'https://idp.example', PINWALL_OIDC_CLIENT_ID: 'c',
    PINWALL_OIDC_CLIENT_SECRET_FILE: '/run/s' }, { readFile: () => 's3cret\n' });
  expect(c.oidc?.clientSecret).toBe('s3cret');
});
test('rejects both value and _FILE', () => {
  expect(() => loadConfig({ PINWALL_SECRET_KEY: 'a'.repeat(64), PINWALL_SECRET_KEY_FILE: '/x' },
    { readFile: () => 'b' })).toThrow(/PINWALL_SECRET_KEY.*only one/);
});
test('collects every issue', () => {
  try { loadConfig({ PINWALL_ISOLATION: 'content-domain', PINWALL_STORAGE: 's3', PINWALL_PORT: 'x' }); }
  catch (e) { expect((e as ConfigError).issues).toHaveLength(3); return; }
  throw new Error('expected ConfigError');
});
test('public origin must be an origin', () => {
  expect(() => loadConfig({ PINWALL_PUBLIC_ORIGIN: 'https://a.example/sub' })).toThrow(/no path/);
  expect(loadConfig({ PINWALL_PUBLIC_ORIGIN: 'https://a.example/' }).publicOrigin).toBe('https://a.example');
});
test('content origin must not be the app host or its parent', () => {
  const base = { PINWALL_PUBLIC_ORIGIN: 'https://pinwall.example.com', PINWALL_ISOLATION: 'content-domain' };
  expect(() => loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://pinwall.example.com' })).toThrow();
  expect(() => loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://example.com' })).toThrow();
  const ok = loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://content.example.com' });
  expect(ok.warnings.join()).toMatch(/registrable domain/);
  expect(loadConfig({ ...base, PINWALL_CONTENT_ORIGIN: 'https://pw-content.net' }).warnings).toEqual([]);
});
test('recheck interval cannot exceed 24h', () => {
  expect(() => loadConfig({ PINWALL_ACCESS_RECHECK_INTERVAL: '25h' })).toThrow(/24h/);
});
test('postgres url and pool size', () => {
  expect(loadConfig({ PINWALL_DATABASE_URL: 'postgres://u:p@h/db' }).database)
    .toEqual({ kind: 'postgres', url: 'postgres://u:p@h/db', poolSize: 10 });
});
test('trust proxy accepts true or CIDR list', () => {
  expect(loadConfig({ PINWALL_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  expect(loadConfig({ PINWALL_TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12' }).trustProxy).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
});
test('oidc lists and emails are normalized', () => {
  const c = loadConfig({ PINWALL_OIDC_ISSUER: 'https://idp', PINWALL_OIDC_CLIENT_ID: 'c',
    PINWALL_OIDC_ADMIN_GROUPS: 'admins, ops', PINWALL_ADMIN_EMAILS: 'A@X.com', PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'access_type=offline' });
  expect(c.oidc).toMatchObject({ adminGroups: ['admins', 'ops'], extraAuthParams: { access_type: 'offline' },
    scopes: ['openid', 'email', 'profile', 'offline_access'] });
  expect(c.access.adminEmails).toEqual(['a@x.com']);
});
test('parse helpers', () => {
  expect(parseDuration('15m')).toBe(900_000); expect(parseDuration('7d')).toBe(604_800_000);
  expect(parseSize('95MB')).toBe(95_000_000); expect(parseSize('2MiB')).toBe(2_097_152);
  expect(() => parseSize('lots')).toThrow();
});
```

  `secret-key.test.ts`: `generates once and reuses` (temp dir: first call creates `secret.key` with mode `0o600` and 32 bytes, second call returns the same bytes, `warn` called once); `uses PINWALL_SECRET_KEY when set` (64 hex chars → 32-byte Buffer, no file written); `rejects short keys` (`PINWALL_SECRET_KEY=abcd` → `ConfigError`).
- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/config` — expected FAIL.
- [ ] **Step 3: Implement** with zod for per-variable parsing; registrable-domain comparison with `tldts.getDomain`. Key decoding: 64 hex chars → hex, otherwise base64; fewer than 32 bytes is an issue.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `feat(server): load configuration from environment with _FILE secrets`.

### Task 4: Database layer and initial schema

**Files:**
- Create: `apps/server/src/db/{schema.ts,connect.ts,migrate.ts,migrations/0001_initial.ts,migrations/index.ts,dialect.ts}`
- Create: `docker-compose.test.yml` (services `postgres` — `postgres:17-alpine`, port `55432`, db/user/password `pinwall`; `minio` — `minio/minio`, ports `59000`/`59001`, user `pinwall`, password `pinwall-secret`, plus a one-shot `minio-init` creating bucket `pinwall-test`)
- Test: `apps/server/test/db/{migrate,search}.test.ts`, `apps/server/test/helpers/db.ts`

**Interfaces:**
- Consumes: `Config['database']` (Task 3).
- Produces:
  - `schema.ts`: `interface Database` with one interface per table in the roadmap's Data model (`UsersTable`, `SessionsTable`, …), using Kysely `Generated<>`/`ColumnType<>` where useful; row aliases `UserRow = Selectable<UsersTable>` etc. `search_index` is not in `Database` (raw SQL only).
  - `interface DbHandle { db: Kysely<Database>; dialect: 'sqlite' | 'postgres'; close(): Promise<void>; ping(): Promise<void> }`.
  - `connectDb(cfg: Config['database']): Promise<DbHandle>`. SQLite pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`; parent directory created. Postgres: `pg.Pool` with `max = poolSize`, `types.setTypeParser(20, Number)`.
  - `migrateToLatest(h: DbHandle): Promise<string[]>` (names applied) via Kysely `Migrator` with an in-code `MigrationProvider` (no filesystem reads, so the bundle works).
  - `dialect.ts`: `bigintCol(h)` helper or equivalent used by migrations; `searchUpsert(h, row: { artifactId: string; name: string; tags: string; body: string }): Promise<void>`, `searchDelete(h, artifactId)`, `searchQuery(h, q: string, limit: number): Promise<string[]>` (artifact ids, best first). Inputs are folded with `foldForSearch` inside these functions. SQLite query: each folded word becomes a prefix term `"word"*` joined by spaces; Postgres: `to_tsquery('simple', 'word:* & word:*')` against `document`, upsert sets `document = to_tsvector('simple', unaccent(name || ' ' || tags || ' ' || body))`.
  - `test/helpers/db.ts`: `withDb(dialect: 'sqlite' | 'postgres'): Promise<DbHandle>` — SQLite in a fresh temp dir; Postgres creates a fresh schema-isolated database (`CREATE DATABASE pinwall_test_<random>`) from `PINWALL_TEST_POSTGRES_URL`, dropped in `close()`. `const dialects = process.env.PINWALL_TEST_POSTGRES_URL ? ['sqlite', 'postgres'] : ['sqlite']` exported, and a one-line console note when Postgres is skipped.

- [ ] **Step 1: Write failing tests**, each in `describe.each(dialects)`:

```ts
test('migrates an empty database and is idempotent', async () => {
  const h = await withDb(dialect);
  expect(await migrateToLatest(h)).toEqual(['0001_initial']);
  expect(await migrateToLatest(h)).toEqual([]);
  for (const t of ['users','password_credentials','passkeys','sessions','api_tokens','oauth_clients',
    'oauth_grants','oauth_tokens','projects','artifacts','artifact_tags','artifact_views','versions',
    'version_files','blobs','content_grants','share_links','comments','leases'])
    await expect(h.db.selectFrom(t as any).selectAll().execute()).resolves.toEqual([]);
});
test('enforces foreign keys', async () => {
  // insert an artifact whose project_id does not exist → rejects
});
test('cascades version deletion to files and grants', async () => {
  // project → artifact → version → version_files + content_grants; delete version → both empty
});
test('bigint columns come back as numbers', async () => {
  // insert blob with size 5_000_000_000 → select → typeof size === 'number' && size === 5_000_000_000
});
test('search is accent-insensitive', async () => {
  await searchUpsert(h, { artifactId: 'art_1', name: 'Bảng giá', tags: '', body: 'Dịch vụ chụp ảnh điện thoại' });
  expect(await searchQuery(h, 'chup anh', 10)).toEqual(['art_1']);
  expect(await searchQuery(h, 'dien thoai', 10)).toEqual(['art_1']);
  expect(await searchQuery(h, 'Chụp', 10)).toEqual(['art_1']);
  expect(await searchQuery(h, 'bang gi', 10)).toEqual(['art_1']);   // prefix
  await searchDelete(h, 'art_1');
  expect(await searchQuery(h, 'chup', 10)).toEqual([]);
});
test('search ignores FTS syntax in user input', async () => {
  expect(await searchQuery(h, '"unbalanced AND (', 10)).toEqual([]);   // must not throw
});
```

  SQLite only: `two handles on one file can both write` — open two `DbHandle`s on the same path, write in a transaction on one while the other inserts; both succeed.
- [ ] **Step 2: Run** `docker compose -f docker-compose.test.yml up -d --wait` then `PINWALL_TEST_POSTGRES_URL=postgres://pinwall:pinwall@localhost:55432/pinwall pnpm --filter @pinwall/server test test/db` — expected FAIL.
- [ ] **Step 3: Implement** `schema.ts`, `connect.ts`, `0001_initial.ts` (Kysely schema builder; indexes on every FK column, `sessions.expires_at`, `content_grants.expires_at`, `versions(artifact_id, number)` unique, `users(oidc_issuer, oidc_subject)` unique, `artifacts(project_id, updated_at)`, `comments(artifact_id, status)`), `migrate.ts`, `dialect.ts`.
- [ ] **Step 4: Run** the same command — expected PASS for both dialects; run once more without the env var — expected PASS with the skip note.
- [ ] **Step 5: Add** root script `test:integration` = `docker compose -f docker-compose.test.yml up -d --wait && PINWALL_TEST_POSTGRES_URL=… PINWALL_TEST_S3_ENDPOINT=http://localhost:59000 PINWALL_TEST_S3_BUCKET=pinwall-test PINWALL_TEST_S3_ACCESS_KEY_ID=pinwall PINWALL_TEST_S3_SECRET_ACCESS_KEY=pinwall-secret pnpm test`.
- [ ] **Step 6: Commit** `feat(server): add Kysely database layer, initial schema and accent-insensitive search for SQLite and Postgres`.

### Task 5: Blob stores

**Files:**
- Create: `apps/server/src/storage/{blob-store.ts,local.ts,s3.ts,index.ts}`
- Test: `apps/server/test/storage/{contract.ts,local.test.ts,s3.test.ts}`

**Interfaces:**
- Consumes: `AppError`/`notFound` (Task 2), `Config['storage']` (Task 3).
- Produces:

```ts
export interface BlobStore {
  put(sha256: string, body: Buffer | Readable, size: number): Promise<void>; // idempotent; verifies hash and size
  get(sha256: string, range?: { start: number; end: number }): Promise<Readable>; // end inclusive; notFound if absent
  has(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<void>;            // no error if absent
  list(): AsyncIterable<string>;                    // every stored sha256
  check(): Promise<void>;                           // readiness probe; throws when unusable
}
export function createBlobStore(cfg: Config['storage']): BlobStore;
```

  Local layout `<dir>/<sha[0:2]>/<sha[2:4]>/<sha>`, written to `<dir>/tmp/<random>` then renamed. S3 key `<prefix>blobs/<sha>`; `put` hashes while streaming to a temp file first, then uploads with `ContentLength` (so a wrong hash never reaches the bucket).

- [ ] **Step 1: Write the contract** `runBlobStoreContract(name: string, make: () => Promise<BlobStore>)` with tests: `round-trips bytes`, `serves an inclusive byte range` (`'0123456789'`, range 2–5 → `'2345'`), `has reflects presence`, `delete is idempotent`, `lists stored keys`, `get of a missing blob is not_found` (`AppError` code `not_found`), `rejects bytes that do not match the hash` (and `has` stays false), `put of an existing blob is a no-op`, `streams a 20 MB blob without buffering it whole` (put from a generated `Readable`, read back, compare hash). `local.test.ts` runs it on a temp dir; `s3.test.ts` runs it when `PINWALL_TEST_S3_ENDPOINT` is set (unique prefix per run) and logs the skip otherwise.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/storage` (with and without the S3 env from `test:integration`) — expected FAIL.
- [ ] **Step 3: Implement** `local.ts`, `s3.ts`, `createBlobStore`.
- [ ] **Step 4: Run** — expected PASS (S3 suite against MinIO).
- [ ] **Step 5: Commit** `feat(server): add local and S3 blob stores behind one contract`.

### Task 6: Infra primitives

**Files:**
- Create: `apps/server/src/infra/{event-bus.ts,one-time-store.ts,rate-limiter.ts,leases.ts,scheduler.ts,index.ts}`
- Test: `apps/server/test/infra/{event-bus,one-time-store,rate-limiter,leases,scheduler}.test.ts`

**Interfaces:**
- Consumes: `Clock`/`FixedClock` (Task 2), `DbHandle` + `leases` table (Task 4).
- Produces:

```ts
export type PinwallEvent = { type: string; [k: string]: unknown };
export interface EventBus { publish(topic: string, event: PinwallEvent): void;
  subscribe(topic: string, handler: (e: PinwallEvent) => void): () => void }
export class InProcessEventBus implements EventBus {}

export interface OneTimeStore {
  put<T>(key: string, value: T, ttlMs: number): Promise<void>;
  take<T>(key: string): Promise<T | null>;          // returns once, then null; null after expiry
  peek<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
}
export class InMemoryOneTimeStore implements OneTimeStore { constructor(clock: Clock) }

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterMs: number };
}
export class InMemoryRateLimiter implements RateLimiter { constructor(clock: Clock) }   // fixed window

export interface LeaseManager {
  acquire(name: string, holder: string, ttlMs: number): Promise<boolean>;
  renew(name: string, holder: string, ttlMs: number): Promise<boolean>;
  release(name: string, holder: string): Promise<void>;
  isHeld(name: string): Promise<boolean>;
}
export class DbLeaseManager implements LeaseManager { constructor(h: DbHandle, clock: Clock) }

export interface Scheduler {
  every(name: string, intervalMs: number, fn: () => Promise<void>): void;  // runs under lease `job:<name>`
  stop(): Promise<void>;                                                  // waits for running jobs
}
export class InProcessScheduler implements Scheduler {
  constructor(leases: LeaseManager, logger: { error(o: object, m: string): void }, holder: string)
}
```

- [ ] **Step 1: Write failing tests:** `delivers to subscribers of a topic only`, `unsubscribe stops delivery`, `a throwing handler does not stop others`; `take returns the value once`, `take after expiry is null` (advance `FixedClock`), `peek does not consume`; `allows up to the limit then reports retryAfterMs`, `window resets after windowMs`, `keys are independent`; `acquire is exclusive until expiry or release` (two holders), `renew only by the holder`, `expired lease can be taken over`, `isHeld false after release`; `scheduler runs the job and logs failures without stopping`, `stop waits for a running job`, `a second scheduler sharing the lease does not run the job concurrently`.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/infra` — expected FAIL.
- [ ] **Step 3: Implement.** Lease acquire is one statement: insert, or update when `expires_at < now` (SQLite `INSERT … ON CONFLICT(name) DO UPDATE … WHERE leases.expires_at < excluded…`; same shape on Postgres); success = one row affected.
- [ ] **Step 4: Run** — expected PASS (leases on both dialects).
- [ ] **Step 5: Commit** `feat(server): add event bus, one-time store, rate limiter, DB leases and scheduler`.

### Task 7: HTTP app skeleton, error pages, health, SPA, CLI

**Files:**
- Create: `apps/server/src/{app.ts,deps.ts,main.ts}`
- Create: `apps/server/src/http/{request-id.ts,logging.ts,security-headers.ts,errors.ts,client-ip.ts,public-url.ts,spa.ts}`
- Create: `apps/server/src/pages/{layout.tsx,error-page.tsx,pages.css.ts}`
- Create: `apps/server/src/lib/logger.ts`
- Modify: `packages/shared/src/i18n/en.json` (error page strings)
- Test: `apps/server/test/http/{health,errors,security-headers,public-url,spa,client-ip}.test.ts`, `apps/server/test/helpers/context.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces:
  - `type Logger = pino.Logger`; `createLogger(level): Logger` (JSON to stdout; redacts `authorization`, `cookie`, `set-cookie`, `*.password`, `*.token`, `*.secret`).
  - `interface AppDeps` exactly as in the roadmap; `createDeps(config: Config, overrides?: Partial<AppDeps>): Promise<AppDeps>` (connects DB, migrates, ensures secret key, builds blob store and infra); `closeDeps(d: AppDeps): Promise<void>`.
  - `type AppEnv` as in the roadmap; `buildApp(deps: AppDeps): Hono<AppEnv>` — mounts middleware in this order: request id, logging, deps injection, security headers, routes (`/healthz`, `/readyz`, then later milestones' routers), SPA fallback; `app.onError(errorHandler)`, `app.notFound(notFoundHandler)`.
  - `publicUrl(config: Config, path: string): string` — absolute URL on the public origin.
  - `clientIp(c: Context, trustProxy: Config['trustProxy']): string` — socket address unless trusted, then the right-most untrusted `X-Forwarded-For` entry.
  - `wantsHtml(c: Context): boolean` — true when `Accept` includes `text/html` and the path is not under `/api/`, `/mcp`, `/oauth/token`, `/oauth/register`, `/upload/`.
  - `renderErrorPage(p: { status: number; title: string; message: string; requestId: string; actions?: { label: string; href: string }[] }): string` (hono/jsx, style B, light/dark via `prefers-color-scheme`, served stylesheet `/_pinwall/pages.css`).
  - `appSecurityHeaders(config: Config): MiddlewareHandler` — headers from the roadmap's Security model for every non-content response.
  - `test/helpers/context.ts`: `createTestContext(opts?: { env?: Record<string, string>; dialect?: 'sqlite' | 'postgres'; clock?: FixedClock }): Promise<{ app: Hono<AppEnv>; deps: AppDeps; request(path: string, init?: RequestInit): Promise<Response>; close(): Promise<void> }>` — temp data dir, migrated DB, local blobs.
  - CLI `main.ts`: `pinwall serve` (default) and `pinwall migrate`, parsed with `node:util` `parseArgs`; a `ConfigError` prints each issue on its own line and exits 2; SIGTERM/SIGINT close the server then deps within 10 s; logs `listening` with `public_origin`, `isolation`, `database` kind, `storage` kind, and each `config.warnings` entry.

- [ ] **Step 1: Write failing tests:**

```ts
test('healthz is ok', async () => expect((await ctx.request('/healthz')).status).toBe(200));
test('readyz checks the database', async () => {
  expect((await ctx.request('/readyz')).status).toBe(200);
  await ctx.deps.db.close();
  const r = await ctx.request('/readyz');
  expect(r.status).toBe(503);
  expect(await r.json()).toMatchObject({ status: 'unavailable' });
});
test('browser 404 is an HTML page without stack traces', async () => {
  // no PINWALL_WEB_DIR; GET /definitely/not/here with Accept: text/html →
  // 404, content-type text/html, body contains t('error.notFound.title') and the request id
});
test('api 404 is JSON', async () => {
  const r = await ctx.request('/api/v1/nope', { headers: { accept: 'text/html' } });
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
});
test('unexpected errors hide internals', async () => {
  // register a test route that throws new Error('db password leaked') → HTML 500 page,
  // body contains the request id and does not contain 'db password leaked' or 'at '
});
test('AppError keeps its status and code', async () => { /* route throws conflict('x') → 409 JSON code conflict */ });
test('app pages carry the security headers', async () => {
  const r = await ctx.request('/healthz');
  expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(r.headers.get('content-security-policy')).toContain("frame-src 'self'");
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('strict-transport-security')).toBeNull(); // http origin
});
test('content-domain mode allows framing the content host', async () => {
  // env PINWALL_PUBLIC_ORIGIN=https://pinwall.test, PINWALL_ISOLATION=content-domain,
  // PINWALL_CONTENT_ORIGIN=https://pw-content.test:8443 →
  // CSP contains "frame-src https://*.pw-content.test:8443" and HSTS is set
});
test('public url ignores Host and forwarded headers', async () => {
  // route returning publicUrl(config, '/x'); request with Host: internal:8080 and
  // X-Forwarded-Host: evil.example, X-Forwarded-Proto: http → 'https://pinwall.test/x'
});
test('client ip uses X-Forwarded-For only when trusted', () => { /* false → socket; ['10.0.0.0/8'] → client */ });
test('spa fallback serves index.html for app routes only', async () => {
  // PINWALL_WEB_DIR=temp dir with index.html + assets/app.js →
  // GET /projects/x (Accept text/html) → 200 index.html with Cache-Control: no-cache;
  // GET /assets/app.js → 200 with Cache-Control containing immutable;
  // GET /api/v1/x → JSON 404; GET /healthz → not index.html
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/http` — expected FAIL.
- [ ] **Step 3: Implement** the modules. Add en.json keys: `error.notFound.title`, `error.notFound.message`, `error.server.title`, `error.server.message`, `error.requestId`, `error.goHome`.
- [ ] **Step 4: Run** the full server suite `pnpm --filter @pinwall/server test` — expected PASS.
- [ ] **Step 5: Smoke run:** `PINWALL_DATA_DIR=$(mktemp -d) pnpm --filter @pinwall/server exec tsx src/main.ts serve` in the background, `curl -fsS localhost:8080/healthz`, then stop it. Expected: `{"status":"ok"}` and a JSON `listening` log line.
- [ ] **Step 6: Commit** `feat(server): add HTTP skeleton with security headers, HTML/JSON errors, health checks, SPA fallback and CLI`.

### Task 8: Server bundle, container image, CI skeleton

**Files:**
- Create: `apps/server/build.mjs` (esbuild: `src/main.ts` → `dist/main.mjs`, ESM, `platform: node`, `target: node24`, externals `better-sqlite3`, `pg-native`; banner adding `createRequire` for CJS deps)
- Create: `Dockerfile`, `.dockerignore`, `deploy/compose/docker-compose.yml`, `.github/workflows/ci.yml`
- Modify: `apps/server/package.json` (`build` script), root `package.json` (`build` builds web then server)

**Interfaces:**
- Produces: image layout `/app/main.mjs`, `/app/node_modules/better-sqlite3`, `/app/web/` (SPA), `PINWALL_WEB_DIR=/app/web`, `PINWALL_DATA_DIR=/data`, user `10001:10001`, `VOLUME /data`, `EXPOSE 8080 9464`, `ENTRYPOINT ["node", "/app/main.mjs"]`, `CMD ["serve"]`. The `pinwall` command inside the image is `/usr/local/bin/pinwall` (shell wrapper `exec node /app/main.mjs "$@"`).

- [ ] **Step 1: Write** `build.mjs` and the Dockerfile: stage `build` on `node:24-bookworm-slim` (corepack pnpm, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm --filter @pinwall/server deploy --prod /out` to get a production `node_modules` with the native module); stage `runtime` on `node:24-bookworm-slim` copying only `dist/main.mjs`, the web build and `node_modules/better-sqlite3` with its runtime deps (`bindings`, `file-uri-to-path`), no pnpm, no compilers. `HEALTHCHECK` runs `node -e` fetching `http://127.0.0.1:8080/healthz`.
- [ ] **Step 2: Build and verify.** Run: `docker build -t pinwall:dev . && docker run -d --name pw-smoke --read-only --tmpfs /tmp -v pw-smoke:/data -p 18080:8080 pinwall:dev && sleep 3 && curl -fsS localhost:18080/healthz && curl -fsS localhost:18080/readyz && docker exec pw-smoke pinwall migrate && docker image inspect pinwall:dev --format '{{.Size}}'; docker rm -f pw-smoke; docker volume rm pw-smoke`. Expected: both endpoints `200`, `migrate` reports nothing to apply, image size under 400 MB uncompressed (proxy for well under 200 MB compressed), container user is `10001` (`docker run --rm --entrypoint id pinwall:dev -u` → `10001`).
- [ ] **Step 3: Write** `deploy/compose/docker-compose.yml` (one `pinwall` service, named volume, `PINWALL_PUBLIC_ORIGIN` placeholder, `read_only: true`, `tmpfs: /tmp`) and `.github/workflows/ci.yml` (on push/PR: pnpm setup, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` with Postgres and MinIO service containers and the `PINWALL_TEST_*` env, `docker build`). Pin every action by full commit SHA with a version comment.
- [ ] **Step 4: Verify** `docker compose -f deploy/compose/docker-compose.yml config` succeeds and `pnpm lint` still passes.
- [ ] **Step 5: Commit** `build: add server bundle, container image, compose example and CI workflow`.

---

## M1 done when

`pnpm lint && pnpm typecheck && pnpm test` pass; `pnpm test:integration` passes with Postgres and MinIO suites executed (not skipped); the Task 8 container check passes.
