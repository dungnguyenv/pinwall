# Pinwall M9a — Operations: Backup, Restore, Metrics, Config Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server side of operating Pinwall:
- a self-contained `pinwall backup` / `pinwall restore` that moves an installation between any storage setups, including the upgrade from SQLite + local disk to Postgres + S3;
- Prometheus metrics on their own listener;
- proof that no secret reaches a log line or the metrics page;
- a configuration reference generated from a tested catalog.

**Architecture:**
- **Backup** lives in `apps/server/src/ops/backup/`. It takes M4a's `maintenance:backup` lease before it opens one read transaction (Postgres `REPEATABLE READ READ ONLY`, a SQLite read transaction), and spools every table to JSONL under the data dir. It then writes one tar: manifest first, then tables, then every referenced blob, verified as it is read.
- **Restore** takes the same lease. It verifies the whole archive while it streams blobs into the target store, then inserts every row and rebuilds the search index in one transaction. If anything fails, it deletes the blobs it wrote.
- **Metrics** are a per-process `Metrics` object on `AppDeps`, served on `PINWALL_METRICS_PORT`.

**Tech Stack:** Kysely 0.29 (`setIsolationLevel`, `setAccessMode`, `introspection.getTables`), tar-stream 3, `node:zlib`, `@prometheus-io/client` 0.16, `hono/route` (`matchedRoutes`), pino, Vitest.
- `@prometheus-io/client` is the prom-client API: `Registry`, `Counter`, `Gauge`, `Histogram`, `collectDefaultMetrics`. It is CommonJS with named exports.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` (§3.12; §9 acceptance 6).

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`. Its Global Constraints apply to every task. M9 edited it in three places: `AppDeps` gains `metrics`, the layout gains `tools/`, and the license constraint names `THIRD_PARTY_NOTICES`.

**Split:** M9 is two plans that share one task numbering:
- this one, Tasks 1–6;
- `2026-11-10-pinwall-m9b-release.md`, Tasks 7–13: the license check, the image, the chart, the docs, the release workflow, the Keycloak e2e and the acceptance suite.

M9b's Task 13 runs this plan's backup and restore inside the built image.

**Depends on:** every earlier plan. This plan uses:
- M1: `AppDeps`, `createDeps`, `createTestContext`, `dialects`, `BlobStore`, `LeaseManager`, `Scheduler`, `createLogger`, `loadConfig`, `migrations`.
- M2: `setupOwner`, `createSignedInUser`, `createUserToken`, `apiInit`.
- M3: `startTestIdp`, `signInOidcUser`, `IDP_REFRESH_TOKEN_PURPOSE`.
- M4a: `BACKUP_LEASE`, `sweepBlobs`, `publishFiles`, `indexArtifact`, `extractVersionText`, `DEFAULT_PROJECT_ID`, `ensureDefaultProject`, `commitVersion`, `restoreVersion`, `ingestUpload`/`ingestFiles`/`ingestInline`.
- M4b: `deleteVersion`, `deleteArtifact`, `createGrant`, `createPublishSession`.
- M5: `createThread`, `createShareLink`.
- M6: the OAuth client in `test/helpers/mcp.ts`.
- M7b: `describeConfig`, `ConfigSection`.

Where merged code differs in a name or signature, the code wins: change the import and keep the behavior.

## Global Constraints

The roadmap's Global Constraints apply, plus these for M9a:
- **Backup archive:** a plain tar.
  - Entries, in this order: `manifest.json`, then `tables/<table>.jsonl` in `BACKUP_TABLES` order, then `blobs/<sha256>` sorted by sha.
  - Manifest fields `format: "pinwall-backup"` and `format_version: 1`.
  - Rows are logical values (numbers, 0/1 booleans, JSON columns as strings), so an archive moves between SQLite and Postgres unchanged.
  - The archive never contains the secret key, only `key_fingerprint`.
- **Lease:** backup and restore both hold `maintenance:backup` (M4a `BACKUP_LEASE`). TTL is `600_000` ms, renewed every `60_000` ms. A lost lease aborts the run.
- **Spool and temp files** go under `<PINWALL_DATA_DIR>/tmp`. The root filesystem is read-only.
- **The CLI's stdout carries only the archive** for `backup --out -`. Every log line of `backup` and `restore` goes to stderr.
- **Metrics** are served only on `PINWALL_METRICS_PORT` (default `9464`; `0` disables) at `GET /metrics`, never on the app port.
  - Metric names start with `pinwall_`, except Node's default process metrics.
  - Labels never carry a token, id, email, hostname or raw path.
- **Logs:** no secret, token, password, cookie, OAuth code or key ever reaches a log line. The one exception, by design (M2), is the setup link in the single `setup_url` line.
- **i18n:** every message an operator reads goes through `t()`, with the exact copy each task gives (`backup.*`, `restore.*`).
- **Both databases:** DB-touching tests run in `describe.each(dialects)`. The backup and restore round trips run over every available storage pair, so `pnpm test:integration` covers SQLite + local ⇄ Postgres + S3.

## Review Focus

1. **Operator runs `docker exec -t … backup --out - > file`, or logs land on stdout.** Expected: stdout holds only tar bytes, and the README (M9b) warns against `-t`. → Task 3 `backup --out - writes only the archive to stdout`.
2. **Backup next to a busy server.** A second process on the same SQLite file runs while publishes and deletes go on. Expected: the archive is one consistent moment that restores cleanly. → Task 3 `a backup next to a busy server is consistent`.
3. **Restoring into a target where the server already started once.** Its default project exists. Expected: this counts as empty and the restore proceeds. A target with any user or artifact is refused. → Task 2 `a freshly started target counts as empty`, `a non-empty target is refused before the archive is read`.
4. **SQLite → Postgres upgrade without carrying the generated `secret.key`.** Expected: the restore succeeds. Encrypted IdP refresh tokens are cleared, with a warning saying who must sign in again and how to keep the key; nothing fails later at decrypt time. → Task 2 `a different secret key clears IdP refresh tokens with a warning`.
5. **Scanners and token URLs hitting the server.** That is random 404 paths, `/c/<token>/…`, `/s/<token>`, `/upload/<token>`, and content-domain hosts. Expected: route labels are patterns, so series stay bounded and no token appears on `/metrics`. → Task 4 `unknown paths share one series`, `counts requests by route pattern, never by raw path`.

## Interface handed to M9b

- **CLI:** `pinwall backup --out <file|->`, `pinwall restore --in <file|->` and `pinwall version` (Task 3). Logs go to stderr, and the exit codes are 0, 1 and 2.
- **Version:** `PINWALL_VERSION` (`apps/server/src/version.ts`). The server's `build.mjs` defines `__PINWALL_VERSION__` from the root `package.json`.
- **Metrics:** `startMetricsServer` on `PINWALL_METRICS_PORT`, with metric names as in Task 4. The chart's ServiceMonitor targets port `metrics`, path `/metrics`.
- **Configuration:** `CONFIG_VARS`, `ConfigVar` and `renderConfigurationDoc` (`apps/server/src/config/catalog.ts`); `docs/configuration.md`; `pnpm docs:config`.

---

### Task 1: Backup archive writer (model: opus)

**Files:**
- Create: `apps/server/src/version.ts`, `apps/server/src/ops/backup/{format.ts,lease.ts,backup.ts}`, `apps/server/test/helpers/backup.ts`
- Modify: `apps/server/build.mjs` (`define: { __PINWALL_VERSION__: JSON.stringify(<root package.json version>) }`)
- Test: `apps/server/test/ops/backup.test.ts`, `apps/server/test/version.test.ts`

**Interfaces:**
- Consumes:
  - M1: `AppDeps`, `migrations` (`db/migrations/index.ts`), `deriveKey`, `conflict`, `isSha256`, `createTestContext`, `dialects`.
  - M4a: `BACKUP_LEASE`, `sweepBlobs`, `publishFiles`.
  - M4b: `deleteVersion`, `deleteArtifact`.
  - M5: `createThread`, `createShareLink`.
  - M2: `setupOwner`, `createUserToken`.
- Produces:

```ts
// version.ts
export const PINWALL_VERSION: string;   // the __PINWALL_VERSION__ define in the bundle; under tsx, the root package.json "version"
// ops/backup/format.ts
export const BACKUP_FORMAT = 'pinwall-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_TABLES = ['users', 'password_credentials', 'passkeys', 'sessions', 'api_tokens', 'oauth_clients', 'oauth_grants',
  'oauth_tokens', 'projects', 'artifacts', 'artifact_tags', 'artifact_views', 'versions', 'version_files', 'blobs', 'share_links',
  'content_grants', 'comments', 'tombstones'] as const;           // parents before children: restore inserts in this order
export type BackupTable = (typeof BACKUP_TABLES)[number];
export const TABLE_KEYS: Record<BackupTable, readonly string[]>;
  // primary keys, for keyset paging and stable order: password_credentials ['user_id'], sessions ['id_hash'], oauth_tokens ['token_hash'],
  // artifact_tags ['artifact_id','tag'], artifact_views ['user_id','artifact_id'], version_files ['version_id','path'], blobs ['sha256'],
  // content_grants ['token'], tombstones ['kind','key'], every other table ['id']
export function isSkippedTable(name: string): boolean;   // leases, search_index, search_index_* (FTS5 shadow tables), kysely_migration, kysely_migration_lock
export interface Manifest {
  format: 'pinwall-backup'; format_version: number; pinwall_version: string; created_at: number;
  source: { database: 'sqlite' | 'postgres'; storage: 'local' | 's3' };
  migrations: string[];                                      // applied, in order
  key_fingerprint: string;                                   // 64 hex
  tables: Record<BackupTable, { rows: number; bytes: number; sha256: string }>;
  blobs: { count: number; bytes: number };
}
export const ManifestSchema: z.ZodType<Manifest>;
export function keyFingerprint(secretKey: Buffer): string;   // hex SHA-256 of deriveKey(secretKey, 'backup-key-fingerprint')
// ops/backup/lease.ts
export const MAINTENANCE_LEASE_TTL_MS = 600_000;
export const MAINTENANCE_LEASE_RENEW_MS = 60_000;
export interface MaintenanceLease { assertHeld(): void; release(): Promise<void> }
export function holdMaintenanceLease(deps: AppDeps, role: 'backup' | 'restore'): Promise<MaintenanceLease>;
  // holder `${role}:${hostname()}:${process.pid}:${4 random bytes hex}`; not acquired → conflict(t('backup.busy'));
  // renews on an unref'd interval; a failed renew makes assertHeld() throw new Error(t('backup.leaseLost'))
// ops/backup/backup.ts
export interface BackupHooks { afterSnapshot?(): Promise<void> }   // tests only
export function createBackup(deps: AppDeps, out: Writable, hooks?: BackupHooks): Promise<{ manifest: Manifest }>;
// test/helpers/backup.ts
export interface Seeded { ownerPassword: string; apiToken: string; artifactId: string; deletedArtifactId: string;
  shareToken: string; sharePassword: string; files: Record<string, Buffer> /* v2 */; secretSha: string /* v1-only file */ }
export function seedInstallation(ctx: TestContext): Promise<Seeded>;
  // owner with a password; an API token; project 'Ảnh'; artifact tagged 'đồ án' with
  // v1 { 'index.html': '<h1>Dịch vụ chụp ảnh</h1>', 'img/photo.bin': 5 MB random, 'shared.css': 'body{}', 'notes/secret.txt': 'sk-live-backup' }
  // and v2 (index.html changed, notes/ dropped, the rest shared); a thread on v1 with one reply; a password share link;
  // a second artifact published then deleted (tombstone); one blobs row + object that nothing references
export function backupToBuffer(deps: AppDeps, hooks?: BackupHooks): Promise<{ buf: Buffer; manifest: Manifest }>;
export function readArchive(buf: Buffer): Promise<{ name: string; data: Buffer }[]>;
export function rewriteArchive(buf: Buffer, edit: (e: { name: string; data: Buffer }) => { name: string; data: Buffer } | null,
  append?: { name: string; data: Buffer }[]): Promise<Buffer>;    // null drops the entry
export function referencedShas(deps: AppDeps): Promise<string[]>;  // distinct version_files.sha256, sorted
export function dumpLogical(deps: AppDeps): Promise<Record<BackupTable, unknown[]>>;   // rows sorted by TABLE_KEYS; blobs: referenced rows only
```

  en.json:
  - `"backup.busy": "Another backup or restore is running (lease maintenance:backup). Try again when it has finished."`
  - `"backup.leaseLost": "The backup lease was lost, so stored files may have been removed meanwhile. Run the backup again."`
  - `"backup.blobBad": "Stored file {{sha}} is missing or does not match its SHA-256; the backup was not completed."`

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; `sha(b)` is hex SHA-256; `entry(name)` finds an archive entry):

```ts
test('the archive is the manifest, one JSONL per table and every referenced blob', async () => {
  await seedInstallation(ctx);
  const { buf, manifest } = await backupToBuffer(ctx.deps);
  const entries = await readArchive(buf);
  const refs = await referencedShas(ctx.deps);
  expect(entries.map((e) => e.name)).toEqual(['manifest.json', ...BACKUP_TABLES.map((t) => `tables/${t}.jsonl`), ...refs.map((s) => `blobs/${s}`)]);
  const m = ManifestSchema.parse(JSON.parse(entries[0]!.data.toString('utf8')));
  expect(m).toMatchObject({ format: 'pinwall-backup', format_version: 1, pinwall_version: PINWALL_VERSION,
    source: { database: dialect, storage: 'local' }, migrations: Object.keys(migrations),
    key_fingerprint: keyFingerprint(ctx.deps.config.secretKey!) });
  for (const t of BACKUP_TABLES) {
    const e = entry(`tables/${t}.jsonl`);
    expect(m.tables[t]).toEqual({ rows: e.data.toString().split('\n').filter(Boolean).length, bytes: e.data.length, sha256: sha(e.data) });
  }
  expect(m.tables.blobs.rows).toBe(refs.length);                       // the orphan row is left out
  expect(m.blobs.count).toBe(refs.length);
  for (const s of refs) expect(sha(entry(`blobs/${s}`).data)).toBe(s);
  expect(manifest).toEqual(m);
  expect(m.key_fingerprint).not.toContain(ctx.deps.config.secretKey!.toString('hex'));
});
test('rows are logical values', ...);
  // tables/users.jsonl line → created_at typeof 'number', email_verified ∈ {0, 1}; versions.meta typeof 'string'; every key is a column of its table
test('every table in the schema is backed up or deliberately skipped', async () => {
  const names = (await ctx.deps.db.db.introspection.getTables()).map((t) => t.name).filter((n) => !isSkippedTable(n));
  expect(names.sort()).toEqual([...BACKUP_TABLES].sort());
});
test('the lease is held from before the snapshot until the archive ends', ...);
  // afterSnapshot: leases.isHeld(BACKUP_LEASE) → true; after createBackup resolves → false
test('a version deleted during the backup is in the archive and its files stay until the sweep', ...);
  // afterSnapshot: deleteVersion(v1) → archive has blobs/<secretSha> and versions.jsonl has number 1;
  // right after the backup blobs.has(secretSha) is true; sweepBlobs(ctx.deps) → 1 or more; blobs.has(secretSha) false
test('a backup is refused while another holds the lease', ...);
  // leases.acquire(BACKUP_LEASE, 'other', 60_000) → rejects { status: 409, message: t('backup.busy') }
test('a damaged blob fails the backup and leaves nothing behind', ...);
  // overwrite the local file of photo.bin's sha with same-length other bytes → rejects with t('backup.blobBad', { sha });
  // isHeld false; readdir(<dataDir>/tmp) has no 'backup-*' entry
```

  `version.test.ts`: `PINWALL_VERSION` equals `JSON.parse(readFileSync(<repo>/package.json)).version`.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/ops/backup test/version`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** `createBackup` follows these steps, in this order. The order is what makes it safe next to blob GC:
  1. `holdMaintenanceLease(deps, 'backup')` **before** the snapshot. A deletion that commits after the snapshot then finds the lease held, so its blobs are deferred.
  2. Create the spool dir `mkdtemp(<dataDir>/tmp/backup-)`.
  3. Take the snapshot.
     - Postgres: `db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only')`.
     - SQLite: a plain `db.transaction()`. WAL gives a snapshot from its first read. Its one connection makes the lease renewal wait until the snapshot ends; the TTL covers that.
     - In the snapshot: read the applied names from `kysely_migration` (ordered by name). Then for each table, read keyset pages of 1000 rows by `TABLE_KEYS` and write each row as `JSON.stringify(row) + '\n'` to `<spool>/<table>.jsonl`, counting rows and bytes and hashing as you write.
     - `blobs` rows are written only when `exists (select 1 from version_files where sha256 = blobs.sha256)`. Their `{ sha256, size }` are the blob list.
  4. End the snapshot, then `hooks.afterSnapshot?.()`.
  5. Pack with tar-stream into `out` (entry mode `0o644`, mtime = `created_at`):
     - `manifest.json` first. Every value is known by now: `created_at = deps.clock.now()` when the snapshot opened, `source`, `key_fingerprint`, `tables`, `blobs`.
     - Each spool file.
     - Each blob, sorted: `blobs.get(sha)` through a SHA-256 pass-through into `pack.entry({ name, size })`. A missing blob or a digest mismatch → `new Error(t('backup.blobBad', { sha }))`.
     - Before each entry, `lease.assertHeld()`.
     - `pack.finalize()`, then await `out`'s `finish`.
  6. `finally`: release the lease and remove the spool dir. On error, also destroy `pack`.
- [ ] **Step 4: Run** the Step 2 command, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS on both dialects.
- [ ] **Step 5: Commit** `feat(server): write self-contained backup archives under the maintenance lease`.

### Task 2: Restore into any storage setup (model: opus)

**Files:**
- Create: `apps/server/src/ops/backup/restore.ts`
- Modify: `apps/server/test/helpers/backup.ts` (adds `storageCombos`, `storageContext`, `rowCounts`), `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/ops/restore.test.ts`

**Interfaces:**
- Consumes: Task 1 (all of it); M4a `DEFAULT_PROJECT_ID`, `ensureDefaultProject`, `indexArtifact`, `extractVersionText`; M1 `searchQuery`, `encryptString`, `deriveKey`; M2 `createSignedInUser`, `apiInit`; M3 `IDP_REFRESH_TOKEN_PURPOSE`.
- Produces:

```ts
export class RestoreError extends Error {}               // message is what the CLI prints
export interface RestoreHooks { beforeInsert?(): Promise<void> }   // tests only
export interface RestoreSummary { manifest: Manifest; warnings: string[] }
export function assertEmptyTarget(deps: AppDeps): Promise<void>;   // throws RestoreError(t('restore.notEmpty', { found }))
export function restoreBackup(deps: AppDeps, input: Readable, hooks?: RestoreHooks): Promise<RestoreSummary>;
// test/helpers/backup.ts (adds)
export type StorageCombo = 'sqlite+local' | 'postgres+s3';
export const storageCombos: StorageCombo[];              // postgres+s3 only when PINWALL_TEST_POSTGRES_URL and PINWALL_TEST_S3_ENDPOINT are set (skip noted once)
export function storageContext(combo: StorageCombo, env?: Record<string, string>): Promise<TestContext>;
  // postgres: createTestContext({ dialect: 'postgres' }); s3: PINWALL_STORAGE=s3 with the PINWALL_TEST_S3_* values,
  // PINWALL_S3_FORCE_PATH_STYLE=true, PINWALL_S3_PREFIX=`restore-${random}/`
export function rowCounts(deps: AppDeps): Promise<Record<BackupTable, number>>;
export function readAll(s: Readable | Promise<Readable>): Promise<Buffer>;
```

  The `DAMAGE` table's edits are small functions local to the test file, each an `edit` callback for `rewriteArchive`: `flipByte`, `renameUser`, `dropFirst`, `renameFirst`, `editManifest` and `keep`.

  en.json (`{{found}}` is a comma list such as `2 users, 1 artifact, 14 stored files`):
  - `"restore.notEmpty": "The target is not empty ({{found}}). Restore into a new installation: an empty data directory, or an empty database and bucket prefix."`
  - `"restore.notBackup": "This is not a Pinwall backup archive."`
  - `"restore.newerFormat": "This backup was made by a newer Pinwall (backup format {{version}}). Upgrade Pinwall, then restore."`
  - `"restore.unknownMigrations": "This backup comes from a Pinwall with database migrations this version does not have ({{names}}). Upgrade Pinwall, then restore."`
  - `"restore.damaged": "The archive is damaged or incomplete: {{detail}}. Nothing was restored."`
  - `"restore.changed": "The target gained data while the restore was running. Nothing was restored."`
  - `"restore.keyChanged": "The secret key differs from the one that made this backup, so its identity-provider refresh tokens cannot be read. {{count}} single sign-on users must sign in again. To keep them signed in, restore with the original PINWALL_SECRET_KEY (on a SQLite install it is the secret.key file in the old data directory)."`

  `{{detail}}` is one of:
  - `manifest.json must come first`;
  - `<name> does not match its checksum`;
  - `blob <sha> does not match its SHA-256`;
  - `expected <n> blobs, found <m>`;
  - `<name> is missing`;
  - `unexpected entry "<first 100 chars>"`;
  - `<name> line <n> has unknown column <c>`;
  - `the archive ends early`.

- [ ] **Step 1: Write the failing tests**:

```ts
describe.each(storageCombos.flatMap((a) => storageCombos.map((b) => [a, b] as const)))('round trip %s → %s', (from, to) => {
  test('everything comes back', async () => {            // with sqlite+local → postgres+s3 this is acceptance 6
    const key = randomBytes(32).toString('hex');
    const src = await storageContext(from, { PINWALL_SECRET_KEY: key });
    const seeded = await seedInstallation(src);
    const { buf } = await backupToBuffer(src.deps);
    const dst = await storageContext(to, { PINWALL_SECRET_KEY: key });
    expect((await restoreBackup(dst.deps, Readable.from(buf))).warnings).toEqual([]);
    expect(await dumpLogical(dst.deps)).toEqual(await dumpLogical(src.deps));
    for (const s of await referencedShas(src.deps)) expect(await readAll(dst.deps.blobs.get(s))).toEqual(await readAll(src.deps.blobs.get(s)));
    expect(await searchQuery(dst.deps.db, 'chup anh', 10)).toEqual([seeded.artifactId]);
    // POST /api/v1/auth/password/sign-in with seeded.ownerPassword → 200; Bearer seeded.apiToken → GET /api/v1/me 200
    // GET /a/<artifactId>/raw → 302, followed → body equals seeded.files['index.html']; GET /a/<deletedArtifactId>/raw → 410
    // GET /api/v1/share/<shareToken> → 401 password_required; POST …/unlock { password: seeded.sharePassword } → 204
  });
});
const DAMAGE: [string, (good: Buffer) => Promise<Buffer>, RegExp][] = [
  ['cut in half', async (b) => b.subarray(0, Math.floor(b.length / 2)), /damaged or incomplete/],
  ['a blob byte flipped', (b) => rewriteArchive(b, flipByte('blobs/', 100)), /does not match its SHA-256/],
  ['a table row edited', (b) => rewriteArchive(b, renameUser('Mallory')), /tables\/users\.jsonl does not match its checksum/],
  ['a blob dropped', (b) => rewriteArchive(b, dropFirst('blobs/')), /expected \d+ blobs, found \d+/],
  ['the manifest dropped', (b) => rewriteArchive(b, dropFirst('manifest.json')), /manifest\.json must come first/],
  ['a path escaping the archive', (b) => rewriteArchive(b, keep, [{ name: '../../etc/passwd', data: Buffer.from('x') }]), /unexpected entry/],
  ['a blob name that is not a SHA-256', (b) => rewriteArchive(b, renameFirst('blobs/', 'blobs/xyz')), /unexpected entry/],
  ['not a tar at all', async () => Buffer.from('hello'), /damaged or incomplete/],
  ['a newer format', (b) => rewriteArchive(b, editManifest({ format_version: 2 })), /newer Pinwall/],
  ['an unknown migration', (b) => rewriteArchive(b, editManifest((m) => ({ ...m, migrations: [...m.migrations, '0099_future'] }))), /0099_future/],
];
test.each(DAMAGE)('%s is refused and leaves the target untouched', async (_name, damage, message) => {
  await expect(restoreBackup(dst.deps, Readable.from(await damage(good)))).rejects.toThrow(message);
  expect(Object.values(await rowCounts(dst.deps)).every((n) => n === 0)).toBe(true);
  expect(await Array.fromAsync(dst.deps.blobs.list())).toEqual([]);
  expect(await dst.deps.leases.isHeld(BACKUP_LEASE)).toBe(false);
  await restoreBackup(dst.deps, Readable.from(good));    // the same target still takes the good archive
});
test('a non-empty target is refused before the archive is read', ...);
  // createSignedInUser(dst) → rejects /not empty \(1 user/; the input is a Readable whose read() throws if called
test('a freshly started target counts as empty', ...);   // ensureDefaultProject(dst.deps) first → restore ok; projects equal the source's
test('gzip-compressed archives restore', ...);           // restoreBackup(dst, Readable.from(gzipSync(good))) → ok
test('a different secret key clears IdP refresh tokens with a warning', ...);
  // source: an oidc user with idp_refresh_token = encryptString(deriveKey(key1, IDP_REFRESH_TOKEN_PURPOSE), 'rt') and idp_checked_at set;
  // restore into a context with key2 → that user's idp_refresh_token and idp_checked_at are null; warnings ===
  // [t('restore.keyChanged', { count: 1 })]; with key1 → the token is kept and warnings []
test('a restore is refused while the lease is held', ...);          // leases.acquire(BACKUP_LEASE, 'b', 60_000) → rejects t('backup.busy')
test('a target that gains data during the restore is left alone', ...);
  // hooks.beforeInsert: createSignedInUser(dst) → rejects t('restore.changed'); no restored row exists; every written blob deleted
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/ops/restore`. Expected: FAIL.
- [ ] **Step 3: Implement `restoreBackup`.** `deps` comes from `createDeps`, so the target is already migrated. Steps:
  1. `holdMaintenanceLease(deps, 'restore')`, then `assertEmptyTarget`. "Empty" means:
     - every `BACKUP_TABLES` table has 0 rows, except `projects`, which may hold the single row `DEFAULT_PROJECT_ID`;
     - and `blobs.list()` yields nothing.
  2. Peek two bytes. `1f 8b` → pipe through `createGunzip()`. Then iterate a tar-stream `extract()`.
  3. **Manifest.** The first entry must be `manifest.json` (≤ 1 MiB). Check, in order:
     - `format !== 'pinwall-backup'` → `notBackup`;
     - `format_version > 1` → `newerFormat`;
     - `ManifestSchema.parse`;
     - `migrations` must be a prefix of `Object.keys(migrations)`, else `unknownMigrations` naming the extras.
  4. **Entries.**
     - `tables/<t>.jsonl`: `t` must be in `BACKUP_TABLES` and not seen before. Stream it to `<dataDir>/tmp/restore-*/<t>.jsonl` while hashing, then compare `bytes` and `sha256` with the manifest.
     - `blobs/<sha>`: `isSha256(sha)` and not seen before. `blobs.put(sha, entry, header.size)` verifies the bytes; record each sha in `written`.
     - Anything else (another name, or a non-file type) → `unexpected entry`.
     - An extract error → `the archive ends early`.
     - Before each entry, `lease.assertHeld()`.
  5. **At the end:** every manifest table must have been seen, and the blob count and bytes must match. Each JSONL line must parse to an object whose keys are columns of its target table (`introspection.getTables()`). Each line count must equal `rows`. Every `version_files.sha256` must be in `written`.
  6. **One transaction.**
     1. `hooks.beforeInsert?.()`, then re-check emptiness inside the transaction → `changed`.
     2. Delete the lone default project.
     3. When `manifest.key_fingerprint !== keyFingerprint(secretKey)`, set `idp_refresh_token` and `idp_checked_at` to null on user rows that had a token, and add the `keyChanged` warning (only when count > 0).
     4. Insert the tables in `BACKUP_TABLES` order, in chunks of `Math.floor(30_000 / columnCount)` rows. Insert `comments` with roots (`parent_id` null) first.
     5. Rebuild search. For each artifact with a `current_version_id`, `indexArtifact({ db: trx, dialect }, artifact, tags, await extractVersionText(txDeps, current))`, where `txDeps = { ...deps, db: { ...deps.db, db: trx } }`.
  7. **On any error after step 1:** delete every sha in `written` (log failures at warn), remove the spool, release the lease. Rethrow a `RestoreError`; wrap anything that is not one with `restore.damaged` or the original message.
- [ ] **Step 4: Run** the Step 2 command, plain and with `pnpm test:integration`'s env. Expected: PASS. With the env set, the four ordered pairs run, including `sqlite+local → postgres+s3`.
- [ ] **Step 5: Commit** `feat(server): restore backups into any storage setup, verified before anything is written`.

### Task 3: `pinwall backup`, `pinwall restore`, `pinwall version` (model: sonnet)

**Files:**
- Create: `apps/server/src/ops/backup/cli.ts`
- Modify: `apps/server/src/main.ts` (commands, options, USAGE, stderr logger for backup/restore)
- Test: `apps/server/test/ops/backup-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; M1 `createDeps`, `closeDeps`, `createLogger(level, destination)`, `loadConfig`.
- Produces:

```ts
export function runBackupCommand(config: Config, logger: Logger, out: string): Promise<void>;
  // '-' → process.stdout; else open `${out}.partial` with flag 'wx', rename to `out` on success, unlink on failure; an existing `out` → Error('… already exists')
export function runRestoreCommand(config: Config, logger: Logger, input: string): Promise<void>;   // '-' → process.stdin
```

  Command line (`node:util` `parseArgs`): commands `serve` (default), `migrate`, `backup --out <file|->`, `restore --in <file|->`, `version`, and `--version`/`-v`. `--out` belongs only to backup and `--in` only to restore; a missing or misplaced option is a usage error (exit 2). For `backup` and `restore` the logger is `createLogger(level, pino.destination({ dest: 2, sync: true }))`. Success logs `'backup complete'` or `'restore complete'` with `{ rows, blobs, bytes }` (plus `warnings` for a restore), and exits 0. Failure prints one line `Backup failed: <message>` or `Restore failed: <message>` on stderr and exits 1. USAGE adds:

```
  backup --out <file|->   Write a backup archive to a file, or to stdout with -
  restore --in <file|->   Restore an archive into an empty installation (- reads stdin)
  version                 Print the Pinwall version
```

- [ ] **Step 1: Write the failing tests.** Each spawns `process.execPath --import tsx src/main.ts …` with `cwd: apps/server` and a temp `PINWALL_DATA_DIR`. The data is seeded by `seedInstallation` on a context over the same data dir.

```ts
test('backup --out - writes only the archive to stdout', ...);   // Review Focus 1
  // stdout parses with readArchive, first entry 'manifest.json'; stdout contains no '{"level"'; stderr has a JSON line msg 'backup complete'
test('backup --out file writes atomically and never overwrites', ...);
  // file exists, no '.partial'; a 2nd run → exit 1 and stderr /already exists/; with a damaged blob → exit 1, neither file nor .partial left
test('restore --in - restores into a fresh data dir', ...);   // pipe the archive into stdin → exit 0; a context on that dir: dumpLogical equals the source
test('restore into a non-empty data dir exits 1 with the reason', ...);   // stderr 'Restore failed: The target is not empty (…'
test('a backup next to a busy server is consistent', ...);   // Review Focus 2, SQLite
  // while the child runs, this process publishes 20 versions (publishFiles) and deletes 5 (deleteVersion) on the same dir;
  // the archive restores (restoreBackup ok) and in the restored target every artifacts.current_version_id is a versions.id
test('usage errors exit 2', ...);   // ['backup'], ['restore', '--in'], ['backup', '--in', 'x'], ['serve', '--out', 'x'] → exit 2, stderr has USAGE
test('version prints the version', ...);   // ['version'] and ['--version'] → stdout `${PINWALL_VERSION}\n`, exit 0
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/ops/backup-cli test/cli`. Expected: FAIL.
- [ ] **Step 3: Implement.** Both commands build deps with `createDeps(config, { logger })` and close them in `finally`. A restore warning is logged at warn level and is also printed on stderr as plain text. M1's `test/cli.test.ts` keeps passing.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add backup, restore and version commands`.

### Task 4: Prometheus metrics (model: sonnet)

**Files:**
- Create: `apps/server/src/ops/{metrics.ts,metrics-server.ts}`
- Modify:
  - `apps/server/src/deps.ts`: `AppDeps.metrics = overrides.metrics ?? createMetrics(db, clock)`; `scheduler = instrumentScheduler(overrides.scheduler ?? new InProcessScheduler(…), metrics)`.
  - `apps/server/src/app.ts`: `app.use(httpMetrics(deps.metrics, deps.config))` right after the deps-injection middleware, before `mountContent`.
  - `apps/server/src/main.ts`: `serve` calls `enableProcessMetrics` and `startMetricsServer`, and closes the listener before `closeDeps`.
  - `apps/server/src/publish/ingest.ts`, `apps/server/src/domain/versions.ts`: the counters below.

  The roadmap's `AppDeps` line already lists `metrics: Metrics`; it was edited together with this plan.
- Test: `apps/server/test/ops/metrics.test.ts`

**Interfaces:**
- Consumes: M1 `AppDeps`, `Scheduler`, `AppError`; M4a `ingestUpload`/`ingestFiles`/`ingestInline`, `commitVersion`, `restoreVersion`, `publishFiles`, `makeTar`; M4b `createGrant`; M5 `createShareLink`.
- Produces:

```ts
// ops/metrics.ts
export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;   // pinwall_http_requests_total
  httpDuration: Histogram<'method' | 'route'>;            // pinwall_http_request_duration_seconds (until the handler returns),
                                                          //   buckets [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]
  publishes: Counter<'source'>;                           // pinwall_publishes_total (versions committed; source = versions.source)
  uploadBytes: Counter<'source'>;                         // pinwall_upload_bytes_total (request bytes read by ingest, accepted or not)
  uploadsRejected: Counter<'reason'>;                     // pinwall_uploads_rejected_total
  jobRuns: Counter<'job' | 'outcome'>;                    // pinwall_job_runs_total, outcome 'ok' | 'error'
  // read from the DB at scrape time: pinwall_active_sessions (sessions with expires_at > now),
  // pinwall_storage_blobs and pinwall_storage_blob_bytes (blobs rows: count, sum(size)), pinwall_build_info{version} 1
}
export function createMetrics(h: DbHandle, clock: Clock): Metrics;     // own Registry per call; a failing DB collect keeps the previous value
export function enableProcessMetrics(m: Metrics): void;                // collectDefaultMetrics({ register: m.registry }); serve only
export function routeLabel(c: Context, config: Config): string;
export function httpMetrics(m: Metrics, config: Config): MiddlewareHandler<AppEnv>;
export function rejectionReason(err: unknown): string | null;
  // AppError with status 400–499 → String(details.limit ?? details.reason ?? code) when it matches /^[a-z_]{1,40}$/, else 'other'; anything else → null
export function instrumentScheduler(s: Scheduler, m: Metrics): Scheduler;   // wraps each job fn: ok/error counted, the error rethrown
// ops/metrics-server.ts
export function startMetricsServer(deps: AppDeps, opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> } | null>;
  // null when config.metrics.port is 0; listens on config.listen.host and opts.port ?? config.metrics.port;
  // GET /metrics → 200 with Content-Type registry.contentType; everything else 404 text
```

  `routeLabel` rules, in order:
  1. In content-domain mode, a hostname under the content host → `'content'`.
  2. The pattern of the route that responded: `matchedRoutes(c)[c.req.routeIndex]?.path`.
  3. For `*`, `/*` or none: `'spa'` when the status is below 400, else `'unmatched'`.

  Counter placement:
  - In each ingest function, `try/catch/finally`: `finally` adds the bytes read (the counting transform for uploads; the summed buffer sizes for files and inline). `catch` increments `uploadsRejected` when `rejectionReason` is non-null, then rethrows.
  - `publishes` is incremented once per version, after the commit transaction (also for `restoreVersion`, whose `source` is `restore`).

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; `scrape()` is `await ctx.deps.metrics.registry.metrics()`):

```ts
test('counts requests by route pattern, never by raw path', async () => {   // Review Focus 5
  // publishFiles → artifact; grant = createGrant(v1, raw); share = createShareLink(...)
  // GET /c/<grant.token>/index.html, GET /s/<share.token>, POST /upload/<newSecret()>, GET /api/v1/artifacts/<id> (cookie), GET /x/<random>
  const text = await scrape();
  expect(text).toContain('route="/c/:token/*"');
  expect(text).toContain('route="/api/v1/artifacts/:id"');
  expect(text).toMatch(/route="\/s\/:[A-Za-z]+"/);
  expect(text).toContain('route="unmatched"');
  for (const secret of [grant.token, share.token, id, random]) expect(text).not.toContain(secret);
});
test('unknown paths share one series', ...);   // 200 GETs of /<random>/<random> → lines starting 'pinwall_http_requests_total{' grow by at most 1
test('content-domain hosts are labelled content', ...);
  // PINWALL_ISOLATION=content-domain, PINWALL_CONTENT_ORIGIN=https://pw-content.test → GET https://<token>.pw-content.test/ → route="content"; no token in the scrape
test('the SPA fallback is labelled spa', ...);   // PINWALL_WEB_DIR with index.html → GET /projects/x (accept text/html) → route="spa"
test('publishes, upload bytes and rejections', ...);
  // publishFiles → pinwall_publishes_total{source="api"} 1; ingestUpload of a 3 KB tar → pinwall_upload_bytes_total{source="api"} >= 3072;
  // PINWALL_MAX_FILES=1 and a 2-file tar → pinwall_uploads_rejected_total{reason="max_files"} 1; a '../x' entry → reason="dot_segment"
test('job runs and failures', ...);   // instrumentScheduler over a fake Scheduler; the job fn throws once then succeeds →
  // pinwall_job_runs_total{job="j",outcome="error"} 1 and {outcome="ok"} 1; the error reaches the inner scheduler
test('gauges read the database at scrape time', ...);
  // 2 sessions (one expired) → pinwall_active_sessions 1; blobs rows of sizes 1, 2, 3 → pinwall_storage_blobs 3, pinwall_storage_blob_bytes 6;
  // pinwall_build_info{version="<PINWALL_VERSION>"} 1
test('the metrics listener serves /metrics only, never the app port', ...);
  // startMetricsServer(deps, { port: 0 }) → GET /metrics 200, content-type starts 'text/plain; version=0.0.4'; GET / → 404;
  // ctx.request('/metrics', { headers: { accept: 'application/json' } }) → 404
test('PINWALL_METRICS_PORT=0 starts no listener', ...);   // startMetricsServer → null
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/ops/metrics`. Expected: FAIL.
- [ ] **Step 3: Implement** with named imports from `@prometheus-io/client`. Metrics are registered on `m.registry`, never on the global registry.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with the Postgres env. Expected: PASS, including every earlier suite.
- [ ] **Step 5: Smoke.**
  1. Start `PINWALL_DATA_DIR=$(mktemp -d) pnpm --filter @pinwall/server exec tsx src/main.ts serve`, then `curl -s localhost:9464/metrics | grep -E '^pinwall_(build_info|http_requests_total)'`. Expected: both present.
  2. `curl -s -o /dev/null -w '%{http_code}' localhost:8080/metrics`. Expected: `404`.
- [ ] **Step 6: Commit** `feat(server): expose Prometheus metrics on a separate listener`.

### Task 5: No secret in a log line or on the metrics page (model: opus)

**Files:**
- Modify: `apps/server/test/helpers/context.ts` (optional `logger` in `createTestContext` options, passed to `createDeps`), `apps/server/src/lib/logger.ts` and any module the test finds leaking
- Test: `apps/server/test/ops/secret-hygiene.test.ts`

**Interfaces:**
- Consumes:
  - M1: `createLogger(level, destination)`.
  - M2: `setupOwner`, `createUserToken`, `apiInit`.
  - M3: `startTestIdp`, `signInOidcUser`.
  - M4: `createPublishSession` (M4b), `publishFiles`, `createGrant`.
  - M5: `createShareLink`.
  - M6: the OAuth client helper in `test/helpers/mcp.ts` (register, authorize with PKCE, token, refresh).
  - Task 4: `Metrics`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test** (in `describe.each(dialects)`). Capture every log line at level `trace`, through a `Writable` destination, into `lines: string[]`. Run against `startTestIdp()`, with env `PINWALL_SECRET_KEY` and `PINWALL_OIDC_CLIENT_SECRET=oidc-secret-<random>` set (and, on Postgres, a `PINWALL_DATABASE_URL` whose password is `db-pass-<random>`):

```ts
test('no secret reaches a log line or the metrics page', async () => {
  // collect in `secrets`: the setup token; owner password; session cookie value; API token; a wrong-password attempt's text;
  // a bogus bearer 'pw_' + newSecret(); upload URL token (used, then retried → 409, then an expired one → 410);
  // content grant token (fetched); share token and share password (opened, unlocked, wrong password once);
  // OAuth code, access and refresh tokens (refreshed once); the OIDC authorization code and state (from idp.authorizationRequests / the callback URL);
  // PINWALL_SECRET_KEY hex; the OIDC client secret; on Postgres the database password
  const all = lines.join('\n') + '\n' + (await ctx.deps.metrics.registry.metrics());
  for (const s of secrets) {
    const hits = lines.filter((l) => l.includes(s));
    if (s === setupToken) expect(hits).toEqual([expect.stringContaining('"setup_url"')]);   // the M2 setup line, once, by design
    else expect(hits).toEqual([]);
    if (s !== setupToken) expect(all).not.toContain(s);
  }
  expect(lines.some((l) => /"(authorization|cookie|set-cookie)":"(?!\[redacted\])/i.test(l))).toBe(false);
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/ops/secret-hygiene`. Expected: FAIL, at least on the missing `logger` option.
- [ ] **Step 3: Fix what leaks.** Change the leaking module so it logs ids or `loggablePath`-style placeholders. Widen `REDACT_PATHS` only for structured keys. Never redact `setup_url`. Note each fix in the commit body.
- [ ] **Step 4: Run** the Step 2 command, plain and with the Postgres env, then `pnpm --filter @pinwall/server test`. Expected: PASS.
- [ ] **Step 5: Commit** `test(server): prove no secret reaches logs or metrics`, as `fix(server): …` when the test found a leak.

### Task 6: Configuration catalog and generated `docs/configuration.md` (model: sonnet)

**Files:**
- Create: `apps/server/src/config/catalog.ts`, `apps/server/scripts/config-doc.ts`, `docs/configuration.md` (generated)
- Modify: `apps/server/package.json` (`"docs:config": "tsx scripts/config-doc.ts"`), root `package.json` (`"docs:config": "pnpm --filter @pinwall/server docs:config"`)
- Test: `apps/server/test/config/catalog.test.ts`

**Interfaces:**
- Consumes: M1 `loadConfig`; M7b `describeConfig`, `ConfigSection` (`@pinwall/shared`).
- Produces:

```ts
export interface ConfigVar {
  name: string;                    // e.g. 'PINWALL_MAX_UPLOAD_BYTES'
  section: ConfigSection;          // the AdminConfig sections: general, isolation, database, storage, sign_in, access, limits, lifetimes
  secret: boolean;                 // read with EnvReader.secret, so NAME_FILE works too
  default: string | null;          // the env value equal to the default ('95000000', '12h', 'single-domain'); null when none or not expressible
  defaultNote?: string;            // prose default, e.g. 'generated into <data dir>/secret.key (SQLite only)'
  description: string;             // original wording, at most 400 characters
}
export const CONFIG_VARS: readonly ConfigVar[];   // roadmap Configuration-table order
export function renderConfigurationDoc(vars: readonly ConfigVar[]): string;
```

  The rendered doc contains:
  - a title;
  - an intro: environment variables are the only source of infrastructure settings, and each secret also reads `<NAME>_FILE`, but not both;
  - the size and duration syntax from the roadmap;
  - one `##` section per `ConfigSection`, with a table `| Variable | Default | Description |`, where secrets show `secret · also NAME_FILE`;
  - the last line `Generated from apps/server/src/config/catalog.ts by pnpm docs:config. Do not edit by hand.`

- [ ] **Step 1: Write the failing tests**:

```ts
const source = readFileSync(new URL('../../src/config/load.ts', import.meta.url), 'utf8');
test('the catalog names exactly the variables the loader reads', () => {
  const read = new Set([...source.matchAll(/'(PINWALL_[A-Z0-9_]+)'/g)].map((m) => m[1]!).filter((n) => !n.endsWith('_FILE')));
  expect(new Set(CONFIG_VARS.map((v) => v.name))).toEqual(read);
});
test('secret flags match the loader', () => {
  const secrets = new Set([...source.matchAll(/\.secret\('(PINWALL_[A-Z0-9_]+)'\)/g)].map((m) => m[1]!));
  expect(new Set(CONFIG_VARS.filter((v) => v.secret).map((v) => v.name))).toEqual(secrets);
});
test('every default is the real default', () => {
  const base = loadConfig({ PINWALL_DATA_DIR: '/data' });
  for (const v of CONFIG_VARS.filter((x) => x.default !== null))
    expect(loadConfig({ PINWALL_DATA_DIR: '/data', [v.name]: v.default! }), v.name).toEqual(base);
});
test('the admin page and the doc describe the same variables and defaults', () => {
  const full = describeConfig(loadConfig({ PINWALL_DATA_DIR: '/data', PINWALL_STORAGE: 's3', PINWALL_S3_BUCKET: 'b',
    PINWALL_OIDC_ISSUER: 'https://idp.example', PINWALL_OIDC_CLIENT_ID: 'c' }));
  expect(new Set(full.entries.map((e) => e.env))).toEqual(new Set(CONFIG_VARS.map((v) => v.name)));
  for (const v of CONFIG_VARS.filter((x) => x.default !== null && !x.secret))
    expect(full.entries.find((e) => e.env === v.name)?.value, v.name).toBe(v.default);   // drop a var here only if describeConfig shows it differently by design
});
test('docs/configuration.md is up to date', () => {
  expect(readFileSync(new URL('../../../../docs/configuration.md', import.meta.url), 'utf8'), 'run pnpm docs:config').toBe(renderConfigurationDoc(CONFIG_VARS));
});
test('descriptions are present and short', ...);   // every description 1..400 chars; every section has at least one variable
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/config/catalog`. Expected: FAIL.
- [ ] **Step 3: Implement** the catalog and renderer, then run `pnpm docs:config` to write `docs/configuration.md`. If a describeConfig value differs from the raw default by design (S3 values with S3 off, say), the test's full config must make them comparable; never weaken the test silently.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `docs: generate the configuration reference from a tested catalog`.


---

## M9a done when

- `pnpm lint && pnpm typecheck && pnpm test` pass.
- `pnpm test:integration` passes with the restore round trips run on all four storage pairs (SQLite + local ⇄ Postgres + S3), not skipped. That proves acceptance 6 at the service level.
- The damaged-archive cases are refused with the target left untouched. The CLI tests pass, including the busy-server backup.
- The metrics, secret-hygiene and catalog tests pass. `docs/configuration.md` is generated, and `pnpm docs:config` leaves it unchanged.
- The Task 4 smoke run shows `/metrics` on port 9464 and 404 on the app port.
