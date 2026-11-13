# Pinwall M10 — Spaces Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `PINWALL_VISIBILITY=personal`, every read and write — REST, MCP, search, Recent, live events, content grants, raw links, publishing and share-link management — reaches only projects the viewer owns or is a member of, with project roles deciding changes; the default `team` mode keeps 1.0's behavior and responses exactly.

**Architecture:**
- Migration `0003_spaces` gives every project an owner (backfilled as spec §8.1 says) and adds `project_members`, the user columns M12 needs and `instance_settings`.
- `domain/spaces.ts` defines `Scope`. Every content lookup by id and every list takes one, or derives it from the acting user it already takes, and adds one SQL condition — two `IN` subqueries — inside its own query.
- In `team` mode and for `SYSTEM_SCOPE` the condition is absent and `roleIn` answers `'owner'` without a query, so team mode runs the 1.0 queries and the 1.0 permission rules.
- Writes in `personal` mode check the viewer's role with `can`, which encodes spec §4.3. Grants, member streams, upload commits and share-link makers check sight again when used.
- The IDOR suite in `apps/server/test/spaces/` exercises every surface in both modes on both databases.

**Tech Stack:** unchanged: Kysely (SQLite and Postgres), Hono + `@hono/zod-openapi`, zod, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-pinwall-personal-spaces-design.md` (§3, §4, §5, §8.1, and the warning fix in §13) on top of `docs/superpowers/specs/2026-11-10-pinwall-design.md`.

**Roadmaps:** `docs/superpowers/plans/2026-11-13-pinwall-v1.1-roadmap.md` (M10 scope, shared names, access inventory, Global Constraints) and `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md` (Global Constraints, security model). Where the real code differs from the v1.1 roadmap's names, this plan follows the code and updates the roadmap in the same commit ("Roadmap refinements").

**Depends on:** 1.0.0 (tag `v1.0.0`), on branch `v1.1`.

**Out of scope (later milestones):** the member management API and removal effects (M11); share approval, quotas, rate rules, admin routes, transfer, purge and D8 (M12); every web change (M13). M10 inserts memberships directly in tests.

## Global Constraints

Both roadmaps' Global Constraints apply. For M10:
- **`PINWALL_VISIBILITY`** is `team` (default) or `personal`. Changing it takes a restart. Going from `personal` to `team` is refused at startup while the last recorded mode is `personal` and more than one person owns a project, until `pinwall visibility team --confirm` has run.
- **Not-found sameness.** An id the viewer cannot see answers exactly like an id that does not exist: `404 not_found` with the same JSON body, the same MCP error text, the same HTML page (apart from its request id). Never 403. The condition goes inside the lookup query; no query runs only for ids that exist.
- **Role refusals:** a role that sees but may not change gets `403 forbidden` with `details.reason = 'role'`.
- **`SYSTEM_SCOPE`** may be imported only by: `domain/spaces.ts`, `domain/share-access.ts`, `domain/comments.ts` (guest branch), `api/share-public.ts`, `domain/search.ts` (index maintenance), `domain/deletion.ts`, `domain/blobs.ts`, `ops/backup/*`, `domain/spaces-startup.ts`, `publish/startup.ts`. `test/spaces/scope-guard.test.ts` enforces it; M12 adds its transfer, purge and admin files.
- **Team mode is 1.0.** `whereVisible` adds nothing, `roleIn` runs no query, the 1.0 permission rules apply, error bodies keep their 1.0 messages, and responses carry no new field. **New response fields are sent only in `personal` mode; absent means 1.0 behavior.**
- **Admins see nothing extra in `personal` mode** (§4.3: "Anyone else (admins included): no (not found)").
- **One migration**, `0003_spaces`, holds all of 1.1's schema.
- **Tests:** DB tests run in `describe.each(dialects)`; the IDOR suite also runs in `describe.each(MODES)`. "With Postgres" means the same command with `PINWALL_TEST_POSTGRES_URL=postgres://pinwall:pinwall@localhost:55432/pinwall` after `docker compose -f docker-compose.test.yml up -d --wait`. Full runs use `VITEST_MAX_WORKERS=2`. At most 2 implementer agents at once.
- **New tests live in `apps/server/test/spaces/`.** 1.0 test files change only as "The 1.0 suite" below lists.
- **i18n:** every message a person or operator reads goes through `t()`. New keys sit in one block with prefix `spaces.`, plus `web.config.section.spaces` and `web.config.help.PINWALL_VISIBILITY`.
- Conventional Commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commit on `v1.1`, never push.

## Review Focus

1. **Search crowding.** Person A has 1,200 artifacts that match "report"; person S has two. Expected: S's search returns S's two on the first page, in the order they have without A's matches. → Task 8 `another space's matches neither crowd out nor reorder a person's results`.
2. **A cursor or upload URL made before a mode switch or a removal.** Expected: a team-mode cursor used in personal mode returns only visible items; an upload URL whose editor was removed is refused at commit with no version and no orphaned blob. → Task 6 `an upload URL whose editor was removed is refused at commit, leaving nothing`; Task 8 `a list cursor minted in team mode returns only visible items in personal mode`, `a search cursor minted in team mode returns only visible items in personal mode`.
3. **Another space's id versus an id that never existed.** Any difference in status, JSON body, MCP text or HTML page (request id aside) tells a stranger the id exists. → every not-found case of Tasks 4–7 compares with the same request on `UNKNOWN_IDS` (`expectCase`); Task 9 `raw links answer an invisible artifact like a missing one, in the browser and to an agent`; Task 10 `%s on Q: personal answers as for an unknown id`.
4. **Losing sight while something is open** (the checks M11 and M12 build on). Expected: the review grant answers 410 on its next request, the member stream ends within one `SSE_HEARTBEAT_MS` (25 000 ms), the person's share link answers like a revoked one, and Recent forgets the artifact. → Task 9 `a member grant stops serving once its holder cannot see the artifact`, `a member's stream ends within one heartbeat of losing sight`, `a share link stops opening when its maker can no longer see the artifact`; Task 4 `Recent forgets an artifact its viewer can no longer see`.
5. **1.0 data meeting 1.1:** a 1.0 database, a 1.0 backup, and a fresh 1.1 team install whose shared default project was never owned, later switched to personal. Expected: owners as §8.1 says, and no project holding artifacts is left unowned or adoptable by a stranger. → Task 1 `a 1.0 database gets its owners as spec §8.1 says`, `a 1.0 archive restores and gets its owners`; Task 2 `startSpaces gives an unowned default project to the owner account`; Task 3 `an unowned default project holding artifacts is never adopted`.

## How a content function learns whose view it serves

The compiler makes every caller say whose view it is, in one of two ways:
- **It gains `scope: Scope`** after `deps` or `db` (after `trx, dialect` for the hold and lock helpers) when it finds or lists content and has no acting user: `getArtifact`, `holdArtifact`, `lockArtifact`, `listArtifacts`, `listRecent` (`ViewerScope`), `getProject`, `listProjects`, `updateProject`, `updateArtifact`, `listVersions`, `checkTarget`, `listThreads`, `getThread`, `getComment`, `listShareLinks`, `diffVersionFiles`, `diffTextFile`, `diffMarkdownFile`, `toArtifactSummary` (after `deps`), and `searchQuery(h, q, limit, scope)` (last, Task 8).
- **It keeps its signature and starts with `scopeForUser(deps, actor)`** when it already takes the acting person: `createProject`, `commitVersion`, `restoreVersion`, `deleteArtifact`, `deleteVersion`, `createThread`, `addReply`, `editComment`, `deleteComment`, `resolveThread`, `reopenThread`, `createShareLink`, `revokeShareLink`, `ingestUpload`, `ingestFiles`, `ingestInline`, `createPublishSession`. A guest `CommentActor` acts under `SYSTEM_SCOPE`, bound to its share link, which `holdCommentLink` checks again in the same transaction.

Unchanged: functions handed a row their caller found through a scoped lookup (`getVersionByNumber`, `getCurrentVersion`, `versionOf`, `listVersionFiles`, `getTags`, `getTagsByArtifact`, `recordView`, `countOpenThreads`, `countActiveShareLinks`, `withArtifactCounts`, `toShareLinks`, `indexArtifact`). Counts in summaries count inside an artifact or project the viewer already sees, so they need no change.

Routes pass `scopeOf(c)`. MCP tools pass `scopeForUser(ctx.deps, ctx.auth.user)` on every call (`ToolContext` is unchanged; `test/mcp/results.test.ts` builds one). `content/raw-links.ts` passes `scopeForUser(deps, auth.user)`.

**Permissions.** In `personal` mode a write calls `assertCan(scope, await roleIn(db, scope, projectId), action, ctx)` right after its scoped lookup, in the write's transaction when it has one. "Own" means `artifacts.created_by` for renaming, moving or deleting an artifact, `versions.created_by` for deleting a version, and `share_links.created_by` for revoking a link. In `team` mode and for `SYSTEM_SCOPE`, `assertCan` returns and each module's 1.0 rule applies unchanged: `canDelete` (admin or publisher), `canDeleteComment` (author, publisher or admin), `canRevoke` (creator, publisher or admin). Editing a comment stays author-only in both modes, with its 1.0 message.

**A tombstoned id answers 410 to whoever asks, as in 1.0.** Tombstones keep no owner and ids are unguessable, so 410 tells only someone who already held the id that it was deleted.

## The 1.0 suite

The default configuration is `team`, so every query is the 1.0 query (search runs the 1.0 SQL text when `seesAll(scope)`), every permission rule and error body is 1.0's, `config.warnings` is unchanged (the open-admission warning is logged by `startSpaces`, because `test/config/load.test.ts:582` expects `[]` for that configuration), and no response or MCP result gains a field (`test/api/config.test.ts:30`, `test/api/artifacts.test.ts:76` and `test/mcp/tools-library.test.ts:98,128` compare whole bodies).

The only changes allowed in 1.0 test files, all mechanical:
- **A scope argument at call sites of functions whose signature changes** (`SYSTEM_SCOPE`, or `scopeForUser(ctx.deps, user)` where a viewer is needed): `test/domain/projects.test.ts`, `test/domain/commit.test.ts`, `test/domain/diff.test.ts`, `test/api/artifacts.test.ts`, `test/api/preview.test.ts`, `test/api/comments.test.ts`, `test/api/share-links.test.ts` (Task 4); `test/db/search.test.ts`, `test/publish/ingest.test.ts`, `test/ops/restore.test.ts`, `test/domain/commit.test.ts` (Task 8).
- **The new columns in typed row literals and whole-row expectations:** `test/domain/projects.test.ts` (`owner_id`), `test/auth/guards.test.ts` and `test/auth/oidc/gate.test.ts` (`share_approved: 0, quota_bytes: null, quota_artifacts: null`), `test/db/migrate.test.ts` (`0003_spaces` and the graph rows) (Task 1).
- **Lists of everything:** `test/api/admin-config.test.ts:136` gains the line `'spaces PINWALL_VISIBILITY'` (Task 2); `test/helpers/backup.ts` seeds one row in each new table (Task 1).

No expected status, message, body field or value changes anywhere else, and `apps/web` does not change.

## Interface handed to M11–M13

- **Spaces:** `domain/spaces.ts` (Task 3): `Scope`, `ViewerScope`, `SYSTEM_SCOPE`, `scopeOf`, `scopeForUser`, `seesAll`, `visibleCondition`, `whereVisible`, `roleIn`, `rolesIn`, `can` (including `'manageMembers'`), `forbiddenRole`, `assertCan`, `teamDefaultProject`, `defaultProjectFor`. `MemberRole` and `ProjectMembersTable` in `db/schema.ts` (Task 1).
- **Startup and settings:** `domain/spaces-startup.ts` (Task 2): `readSetting`, `writeSetting`, `checkVisibility`, `confirmTeamVisibility`, `startSpaces`.
- **The IDOR suite:** `test/spaces/fixture.ts` (`spacesContext`, `spacesFixture`, `addMember`, `removeMember`, `CaseIds`, `UNKNOWN_IDS`, `Case`, `expectCase`, `sameAnswer`, `withVisibility`). M11 adds its member cases to the same files and replaces `addMember`/`removeMember` in new tests with its routes.
- **M11:** removing a member must end what Task 9 re-checks lazily: its grants are already refused at use, streams end within a heartbeat, and the maker's links answer as revoked. `endProjectAccess` makes those immediate and revokes the links.
- **M12:** the user columns `share_approved`, `quota_bytes` and `quota_artifacts` exist and are typed. Transfer uses `teamDefaultProject`/`defaultProjectFor` for the "Default (from <name>)" rule and must keep each owner at one `is_default = 1` project (`projects_owner_default_idx`). New `PublicConfig` and `Me` fields follow the personal-only, absent-at-default rule.
- **M13:** absent `PublicConfig.visibility` means `team`. Absent `Project.role`, `Project.owner` and `ArtifactSummary.can_manage` (team mode) mean the 1.0 rules (`admin || created_by === me`). The SPA must not assume `prj_00000000000000000000` is the viewer's default: publish without `project_id`, or use the listed project with `is_default` and `role: 'owner'`.

## Roadmap refinements (made in this plan's commit)

In `2026-11-13-pinwall-v1.1-roadmap.md`: the `SYSTEM_SCOPE` allow-list above; the personal-only rule for new response fields; the `domain/spaces.ts` block with the real signatures; "Domain signatures (M10)" replaced by the two ways above; `searchQuery(h, q, limit, scope)`; the `forbidden` reason `other_space`; the open-admission warning logged by `startSpaces`; MCP `role`/`owner` in personal mode only.

---

### Task 1: Migration `0003_spaces`, owner backfill, backup and restore (model: opus)

**Files:**
- Create: `apps/server/src/db/migrations/0003_spaces.ts`
- Modify: `apps/server/src/db/migrations/index.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/domain/projects.ts` (rows written by `createProject` and `ensureDefaultProject` carry `owner_id`), `apps/server/src/auth/setup.ts:115` (the `UserRow` literal), `apps/server/src/ops/backup/format.ts`, `apps/server/src/ops/backup/restore.ts`
- Modify (1.0 tests, mechanical): `apps/server/test/db/migrate.test.ts`, `test/domain/projects.test.ts`, `test/auth/guards.test.ts`, `test/auth/oidc/gate.test.ts`, `test/helpers/backup.ts`
- Test: `apps/server/test/spaces/migration.test.ts`, `apps/server/test/spaces/restore-v10.test.ts`, `apps/server/test/spaces/v10-archive.ts` (helper)

**Interfaces:**
- Consumes (1.0): `bigintCol`, `MigrationDb`, `runMigrations`, `migrateToLatest`, `createBackup`, `restoreBackup`, `rewriteArchive`, `readArchive`, `backupToBuffer`, `seedInstallation`, `dumpLogical`, `dialects`.
- Produces:

```ts
// db/schema.ts
export type MemberRole = 'editor' | 'viewer';
ProjectsTable.owner_id: string | null;
UsersTable.share_approved: Generated<DbBool>; UsersTable.quota_bytes: number | null; UsersTable.quota_artifacts: number | null;   // read by M12
export interface ProjectMembersTable { project_id: Fixed<string>; user_id: Fixed<string>; role: MemberRole; added_by: string | null; created_at: Fixed<number> }
export interface InstanceSettingsTable { key: Fixed<string>; value: string; updated_at: number }
// Database gains project_members, instance_settings; rows ProjectMemberRow, InstanceSettingRow
// db/migrations/0003_spaces.ts
export async function up(db: MigrationDb, dialect: DbDialect): Promise<void>;
/** Spec §8.1: owner_id = created_by; else the owner account, else the earliest active admin, else the earliest user. Rows changed. */
export async function backfillProjectOwners(db: MigrationDb): Promise<number>;
// ops/backup/format.ts
BACKUP_TABLES: 'users', 'instance_settings', 'password_credentials', …, 'projects', 'project_members', 'artifacts', …
TABLE_KEYS.project_members = ['project_id', 'user_id']; TABLE_KEYS.instance_settings = ['key'];
/** The migration that added each table newer than the first archive format; older archives lack them. */
export const TABLE_SINCE: Partial<Record<BackupTable, string>>;   // { project_members: '0003_spaces', instance_settings: '0003_spaces' }
// test/spaces/v10-archive.ts
/** A 1.1 archive made into what 1.0 wrote: no new tables or columns, migrations 0001–0002, stats recomputed. */
export async function toV10Archive(buf: Buffer): Promise<Buffer>;
```

- [ ] **Step 1: Write the failing tests.**

```ts
// migration.test.ts — describe.each(dialects); h migrated with runMigrations(h, { '0001_initial', '0002_publishing' } only)
test('a 1.0 database gets its owners as spec §8.1 says', async () => {
  // users: usr_m (oidc member, created T), usr_a (oidc, idp_role 'admin', T+1), usr_o (kind 'owner', T+2)
  // projects: prj_00000000000000000000 (is_default 1, created_by null), prj_mine (created_by usr_m), prj_lost (created_by null)
  expect(await migrateToLatest(h)).toEqual(['0003_spaces']);
  expect(await owners(h)).toEqual({ prj_00000000000000000000: 'usr_o', prj_mine: 'usr_m', prj_lost: 'usr_o' });
  expect(await user(h, 'usr_m')).toMatchObject({ share_approved: 0, quota_bytes: null, quota_artifacts: null });
  expect(await h.db.selectFrom('instance_settings').selectAll().execute()).toEqual([]);
});
test.each([
  ['no owner account: the earliest active admin', { owner: false }, 'usr_a'],
  ['the only admin is disabled: the earliest user', { owner: false, adminDisabled: true }, 'usr_m'],
  ['the only admin is blocked: the earliest user', { owner: false, adminOverride: 'blocked' }, 'usr_m'],
])('%s', …);   // prj_lost goes to the expected user
test('an empty instance leaves the default project unowned', …);   // prj_000… only, no users → owner_id null
test('each owner has at most one default project', …);
  // a second is_default=1 row with the same owner_id rejects; another owner, is_default 0, or two unowned defaults are accepted
test('memberships go with their project and their user', …);
  // deleting an empty project or a user who owns nothing removes their rows; a second (project_id, user_id) row rejects
// restore-v10.test.ts — describe.each(dialects)
test('a 1.0 archive restores and gets its owners', …);
  // source = seedInstallation; restore toV10Archive(backup) into a fresh target:
  // every project has owner_id = created_by, and prj_000… (created_by null) belongs to the owner account;
  // project_members and instance_settings are empty; users have share_approved 0 and null quotas;
  // every other table and column equals dumpLogical(source)
test('an archive that lists 0003_spaces must carry both new tables', …);
  // drop tables/project_members.jsonl from a 1.1 archive → RestoreError matching /tables\/project_members\.jsonl is missing/
test("a target that has started once takes the archive's settings", …);
  // target holds instance_settings visibility.last = 'personal' → restore succeeds; target settings equal the archive's
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/migration test/spaces/restore-v10`. Expected: FAIL (`0003_spaces` unknown).
- [ ] **Step 3: Implement the migration and the backfill.** `up`, in this order:
  - `projects.owner_id text` referencing `users.id`, nullable. Index `projects_owner_id_idx`. Partial unique index `projects_owner_default_idx` on `(owner_id)` `where is_default = 1`.
  - `project_members` (STRICT on SQLite):
    - `project_id` references `projects.id` on delete cascade, not null;
    - `user_id` references `users.id` on delete cascade, not null;
    - `role text not null`;
    - `added_by` references `users.id` on delete set null;
    - `created_at` big not null;
    - primary key `project_members_pkey (project_id, user_id)`; index `project_members_user_id_idx`.
  - `users.share_approved integer not null default 0`, `users.quota_bytes` big nullable, `users.quota_artifacts integer` nullable.
  - `instance_settings` (STRICT): `key text` primary key not null, `value text not null`, `updated_at` big not null.
  - Last, `await backfillProjectOwners(db)`.

  `backfillProjectOwners` runs three statements:
  1. `owner_id = created_by` where `owner_id is null and created_by is not null`.
  2. Find the fallback, in this order (ties by `created_at, id`):
     - `kind = 'owner'`;
     - else `kind = 'oidc' and disabled_at is null and idp_role is not null and coalesce(role_override, idp_role) = 'admin'`;
     - else any user.
  3. Give the fallback every project still unowned, except an `is_default = 1` row when the fallback already owns a default (the unique index).

  `ensureDefaultProject` inserts `owner_id: null`; `createProject` writes `owner_id: actor.id`.
- [ ] **Step 4: Implement backup and restore.**
  - `format.ts`: the tables, `TABLE_KEYS` and `TABLE_SINCE` above. `BACKUP_FORMAT_VERSION` stays 1: a 1.0 Pinwall already refuses an archive listing `0003_spaces` as an unknown migration.
  - `readManifest`: before `ManifestSchema`, fill each `TABLE_SINCE` table whose migration is missing from `migrations`, and that `tables` lacks, with `{ rows: 0, bytes: 0, sha256: <hex SHA-256 of empty> }`. Return those tables as `absent`.
  - `unpack`, `verifyRows` and `insertEverything` skip the `absent` tables.
  - `NOUNS`: `project_members: ['project member', 'project members']`, `instance_settings: ['instance setting', 'instance settings']`.
  - `targetContents` with `defaultProject: true` also ignores `instance_settings`, because a first start writes `visibility.last`. `takeTarget` deletes the target's `instance_settings` rows.
  - After the last insert and before `rebuildSearch`: `await backfillProjectOwners(trx)`.
  - `toV10Archive`: with `rewriteArchive`, drop both new `tables/*.jsonl`, strip `owner_id` from project rows and `share_approved`, `quota_bytes`, `quota_artifacts` from user rows, and rewrite the manifest (stats of the changed entries, the two tables removed, `migrations: ['0001_initial', '0002_publishing']`).
- [ ] **Step 5: Make the mechanical 1.0 test edits** listed in "The 1.0 suite".
  - `migrate.test.ts`: `ALL_MIGRATIONS` gains `'0003_spaces'`; `graph()` gains `owner_id: 'usr_1'` on the project, the three user columns, one `project_members` row and one `instance_settings` row.
  - `projects.test.ts`: `owner_id: null` in the default project's expected row, `owner_id: actor.id` in the created one.
  - `guards.test.ts`, `gate.test.ts`: the three user columns in the `UserRow` literals.
  - `helpers/backup.ts` `seedInstallation`:
    - insert a member user `Bình` (oidc, no session);
    - give them a `project_members` row (`viewer`, `added_by` the owner) on project "Ảnh";
    - insert `instance_settings` `('visibility.last', 'team', now)`.
- [ ] **Step 6: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/db test/ops test/domain/projects test/auth`, plain and with Postgres. Expected: PASS.
- [ ] **Step 7: Commit** `feat(server): add migration 0003_spaces with project owners, members and instance settings`.

### Task 2: `PINWALL_VISIBILITY`, the mode guard and its CLI, startup warnings (model: sonnet)

**Files:**
- Create: `apps/server/src/domain/spaces-startup.ts`, `apps/server/test/spaces/fixture.ts` (first part)
- Modify:
  - server: `apps/server/src/config/types.ts`, `config/load.ts`, `config/catalog.ts`, `api/admin-config.ts`, `api/config.ts`, `main.ts`, `auth/oidc/sign-in.ts:229-239`;
  - shared: `packages/shared/src/api/admin-config.ts`, `packages/shared/src/api/config.ts`, `packages/shared/src/i18n/en.json`;
  - docs: `docs/configuration.md` (regenerated with `pnpm docs:config`).
- Modify (1.0 test, one line): `apps/server/test/api/admin-config.test.ts:136`
- Test: `apps/server/test/spaces/visibility.test.ts`, `apps/server/test/spaces/visibility-cli.test.ts`, `apps/server/test/spaces/warnings.test.ts`

**Interfaces:**
- Consumes: Task 1 `instance_settings`, `backfillProjectOwners`; 1.0 `ensureDefaultProject`, `ConfigError`, `connectDb`, `migrateToLatest`.
- Produces:

```ts
// config/types.ts
export type Visibility = 'team' | 'personal';
Config.visibility: Visibility;
// packages/shared
ConfigSection: 'general' | 'isolation' | 'database' | 'storage' | 'sign_in' | 'access' | 'spaces' | 'limits' | 'lifetimes';
PublicConfig.visibility?: 'team' | 'personal';   // sent only in personal mode
// domain/spaces-startup.ts
export const LAST_VISIBILITY = 'visibility.last';
export async function readSetting(db: Db, key: string): Promise<string | null>;
export async function writeSetting(db: Db, key: string, value: string, now: number): Promise<void>;   // upsert
export async function countProjectOwners(db: Db): Promise<number>;   // distinct non-null owner_id
/** Refuses team after personal while more than one person owns a project; otherwise records config.visibility. */
export async function checkVisibility(deps: AppDeps): Promise<void>;   // throws new ConfigError([t('spaces.guard.refused', { owners })])
export async function confirmTeamVisibility(db: Db, now: number): Promise<number>;   // records 'team', returns the owner count
export function openAdmissionWarning(config: Config): string | null;
/** `serve`, before it listens: checkVisibility, ensureDefaultProject, backfillProjectOwners, then logs openAdmissionWarning. */
export async function startSpaces(deps: AppDeps): Promise<void>;
// test/spaces/fixture.ts
export const MODES: readonly Visibility[];   // ['team', 'personal']
export function withVisibility(deps: AppDeps, visibility: Visibility): AppDeps;   // { ...deps, config: { ...deps.config, visibility } }
```

- [ ] **Step 1: Write the failing tests.**

```ts
// visibility.test.ts — describe.each(dialects)
test('the loader reads PINWALL_VISIBILITY', () => {
  expect(loadConfig({}).visibility).toBe('team');
  expect(loadConfig({ PINWALL_VISIBILITY: 'personal' }).visibility).toBe('personal');
  expect(() => loadConfig({ PINWALL_VISIBILITY: 'private' })).toThrow(/PINWALL_VISIBILITY: must be "team" or "personal"/);
});
test('a fresh instance records the mode it runs in', …);   // checkVisibility → readSetting(LAST_VISIBILITY) === 'team'
test('team after personal with two owners is refused until confirmed', async () => {
  // personal context; createProject by A and by B; await checkVisibility(ctx.deps)
  const team = withVisibility(ctx.deps, 'team');
  await expect(checkVisibility(team)).rejects.toThrow(ConfigError);
  await expect(checkVisibility(team)).rejects.toThrow(/pinwall visibility team --confirm/);
  expect(await readSetting(db, LAST_VISIBILITY)).toBe('personal');
  expect(await confirmTeamVisibility(db, T)).toBe(2);
  await checkVisibility(team);
  expect(await readSetting(db, LAST_VISIBILITY)).toBe('team');
});
test('one owner may go back to team without confirmation', …);
test('going to personal needs no confirmation', …);
test('startSpaces gives an unowned default project to the owner account', …);
  // team context: ensureDefaultProject (unowned), then an owner account; startSpaces → prj_000… owner_id = the owner's id
test('public config names the mode only in personal mode', …);
  // GET /api/v1/config/public: team → no 'visibility' key; personal → visibility 'personal'
// warnings.test.ts
test('team mode with open admission is warned about at start', …);
  // openAdmissionWarning(loadConfig({ PINWALL_OIDC_ISSUER: 'https://idp.example', PINWALL_OIDC_CLIENT_ID: 'c' }))
  //   matches /anyone the identity provider signs in .*every project/, and that config's warnings stay [];
  // null with PINWALL_MEMBER_DOMAINS=example.com, with PINWALL_OIDC_MEMBER_GROUPS (+ ROLES_CLAIM), with PINWALL_VISIBILITY=personal, without OIDC;
  // startSpaces logs it once through deps.logger.warn
test('a token without the roles claim is not logged when no member group rule exists', …);
  // startTestIdp; env PINWALL_OIDC_ROLES_CLAIM=groups, PINWALL_OIDC_ADMIN_GROUPS=pinwall-admins, no member groups;
  // an account without groups signs in (302, a member); no logger.warn call mentions 'roles claim'
// visibility-cli.test.ts — spawns src/main.ts as test/cli.test.ts does (own copy of its small spawn helper)
test('serve refuses team after personal and names the confirmation', …);
  // data dir migrated with two owners and visibility.last 'personal'; PINWALL_VISIBILITY=team serve → exit 2,
  // stderr contains 'pinwall visibility team --confirm'
test('visibility team --confirm records team, and serve then starts', …);   // exit 0, stdout t('spaces.guard.confirmed', { owners: 2 }); serve logs "listening"
test('visibility needs team and --confirm', …);
  // ['visibility'] → 2, 'visibility needs "team"'; ['visibility', 'team'] → 2, '--confirm'; ['serve', '--confirm'] → 2, '--confirm belongs to the visibility command'
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/visibility test/spaces/warnings test/spaces/visibility-cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`load.ts`:** `visibility: r.read('PINWALL_VISIBILITY', z.enum(['team', 'personal'], { error: 'must be "team" or "personal"' })) ?? 'team'`. The open-admission warning is not added to `config.warnings`.
  - **`openAdmissionWarning`:** non-null when `visibility === 'team'`, `oidc !== null`, and `oidc.memberGroups`, `access.memberEmails` and `access.memberDomains` are all empty. Copy: `PINWALL_VISIBILITY is team and no member rule is set (PINWALL_OIDC_MEMBER_GROUPS, PINWALL_MEMBER_EMAILS or PINWALL_MEMBER_DOMAINS): anyone the identity provider signs in becomes a member and sees every project. Set a member rule, or PINWALL_VISIBILITY=personal.`
  - **Catalog:** section `spaces` after `access`, titled `Spaces and sharing`, with the intro `Whether every member sees every project, or each person has a space of their own. Changing it takes a restart.`. Variable `PINWALL_VISIBILITY`, default `team`, description: `team: every member sees every project, as in Pinwall 1.0. personal: each person sees only the projects they own or were added to. Going from personal back to team needs pinwall visibility team --confirm once.`
  - **`CONFIG_SETTINGS`:** a `spaces` entry reading `c.visibility`.
  - **`main.ts`:**
    - `Command` gains `{ name: 'visibility' }`, parsed as `visibility team --confirm`. `--confirm` with any other command is an error. Usage line: `visibility team --confirm  Allow team mode after personal mode: every member sees every project`.
    - The command runs `connectDb`, `migrateToLatest`, `confirmTeamVisibility`, prints `t('spaces.guard.confirmed', { owners })`, then closes.
    - `runServer` awaits `startSpaces(deps)` right after `createDeps`, before `serve`. On failure it runs `closeDeps` and rethrows; `main` already turns a `ConfigError` into stderr text and exit 2.
  - **`sign-in.ts` `logMissingRolesClaim`:** returns at once unless `(deps.config.oidc?.memberGroups.length ?? 0) > 0`. `lacksGroupsClaim` and the re-check are unchanged.
  - **`api/config.ts`:** adds `visibility: 'personal'` only in personal mode.
  - **en.json:**
    - `"spaces.guard.refused": "PINWALL_VISIBILITY is team, but Pinwall last ran in personal mode and {{owners}} people own projects. In team mode every member would see all of their projects. To allow that, run pinwall visibility team --confirm once and start Pinwall again, or set PINWALL_VISIBILITY=personal."`
    - `"spaces.guard.confirmed": "Team mode confirmed: at the next start every member sees the projects of all {{owners}} owners."`
    - `"web.config.section.spaces": "Spaces and sharing"`
    - `"web.config.help.PINWALL_VISIBILITY": "team: every member sees every project, as in Pinwall 1.0. personal: each person sees only the projects they own or were added to. Takes a restart."`
  - Run `pnpm docs:config`, and add `'spaces PINWALL_VISIBILITY'` after the `access` lines in `admin-config.test.ts:136`.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @pinwall/server test test/config test/api/admin-config test/api/config test/auth/oidc test/cli` and `pnpm --filter @pinwall/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add PINWALL_VISIBILITY with a guarded switch back to team mode`.

### Task 3: `domain/spaces.ts` — scope, condition, roles, default projects; fixture and scope guard (model: opus)

**Files:**
- Create: `apps/server/src/domain/spaces.ts`, `apps/server/test/spaces/spaces.test.ts`, `apps/server/test/spaces/scope-guard.test.ts`
- Modify: `apps/server/test/spaces/fixture.ts` (the IDOR fixture), `packages/shared/src/i18n/en.json` (`spaces.role.*`)

**Interfaces:**
- Consumes: Task 1 `MemberRole`, `owner_id`, `project_members`; Task 2 `Visibility`; 1.0 `authOf`, `effectiveRole`, `ensureDefaultProject`, `forbidden`, `notFound`, `newId`, `createSignedInUser`, `createUserToken`, `publishFiles`, `createProject`, `createThread`, `addReply`, `createShareLink`, `restClient`.
- Produces:

```ts
// domain/spaces.ts
export type ProjectRole = 'owner' | MemberRole;
export type ViewerScope = { kind: 'viewer'; user: UserRow; visibility: Visibility; admin: boolean };
export type Scope = ViewerScope | { kind: 'system' };
export const SYSTEM_SCOPE: Scope;
export function scopeForUser(deps: AppDeps, user: UserRow): ViewerScope;   // visibility: deps.config.visibility; admin: effectiveRole(user) === 'admin'
export function scopeOf(c: Context<AppEnv>): ViewerScope;                  // scopeForUser(c.var.deps, authOf(c).user)
/** Team mode or SYSTEM_SCOPE: no condition, every role 'owner', the 1.0 rules. */
export function seesAll(scope: Scope): boolean;
/** "The project in projectIdColumn is owned by or shared with the viewer"; null when seesAll. */
export function visibleCondition(scope: Scope, projectIdColumn: string): RawBuilder<SqlBool> | null;
export function whereVisible<QB extends { where(e: Expression<SqlBool>): QB }>(qb: QB, scope: Scope, projectIdColumn: string): QB;
export async function roleIn(db: Db, scope: Scope, projectId: string): Promise<ProjectRole>;   // not visible → notFound(t('project.notFound'))
export async function rolesIn(db: Db, scope: Scope, projectIds: readonly string[]): Promise<Map<string, ProjectRole>>;
export type SpaceAction = 'comment' | 'publish' | 'editArtifact' | 'deleteArtifact' | 'deleteOthersComment'
  | 'createShareLink' | 'revokeShareLink' | 'manageProject' | 'manageMembers';
export function can(role: ProjectRole, action: SpaceAction, ctx?: { publishedBy?: string | null; userId?: string }): boolean;
export function forbiddenRole(action: SpaceAction): AppError;   // forbidden(t(`spaces.role.${action}`), { reason: 'role' })
/** seesAll: returns (the module's 1.0 rule applies); personal: throws forbiddenRole(action) unless can(). */
export function assertCan(scope: Scope, role: ProjectRole, action: SpaceAction, ctx?: { publishedBy?: string | null; userId?: string }): void;
/** The oldest is_default = 1 project (created_at, id): team mode's shared default. */
export async function teamDefaultProject(db: Db): Promise<ProjectRow | undefined>;
export async function defaultProjectFor(deps: AppDeps, scope: Scope): Promise<ProjectRow>;
// test/spaces/fixture.ts (adds)
export type Who = 'A' | 'E' | 'V' | 'S' | 'X';
export interface Person { user: UserRow; cookie: string; token: string }
export interface CaseIds { P: string; Q: string; p: string; q: string; e: string; pV1: string; pV2: string; qV2: string;
  pThread: string; pReply: string; qThread: string; eThread: string; pLink: string; qLink: string; eLink: string }
export const UNKNOWN_IDS: CaseIds;   // same prefixes, 20 × 'z', e.g. 'art_zzzzzzzzzzzzzzzzzzzz' (never prj_000…)
export interface SpacesFixture { people: Record<Who, Person>; ids: CaseIds }
export function spacesContext(dialect: DbDialect, visibility: Visibility): Promise<TestContext>;   // FixedClock(T), env PINWALL_VISIBILITY
export async function spacesFixture(ctx: TestContext): Promise<SpacesFixture>;
export async function addMember(ctx: TestContext, projectId: string, userId: string, role: MemberRole, addedBy: string): Promise<void>;
export async function removeMember(ctx: TestContext, projectId: string, userId: string): Promise<void>;
export type RestApi = ReturnType<typeof restClient>;
export interface Case { name: string; who: Who; send: (api: RestApi, ids: CaseIds) => Promise<Reply>; team: number; personal: number;
  /** details.reason of a personal-mode 403: 'role' unless given; null for a 1.0 refusal (editing someone else's comment). */
  reason?: 'role' | 'other_space' | null }
/** `c(who, name, send, team, personal, reason?)`: the shorthand the case tables use. */
export function c(who: Who, name: string, send: Case['send'], team: number, personal: number, reason?: Case['reason']): Case;
/** Sends the case as its person and expects the status for the mode. A 404 must equal (sameAnswer) the same `send` on
 *  UNKNOWN_IDS; a personal 403 carries `reason`; a team 403 carries no details.reason (the 1.0 body). */
export async function expectCase(ctx: TestContext, fx: SpacesFixture, mode: Visibility, c: Case): Promise<void>;
export function sameAnswer(actual: { status: number; body: unknown }, missing: { status: number; body: unknown }): void;   // HTML bodies compared without the request id <code>
```

The condition, for a personal viewer `u`, is: `(<col> in (select id from projects where owner_id = u) or <col> in (select project_id from project_members where user_id = u))`. There is no join, so it works under `FOR UPDATE`/`FOR SHARE` and inside raw SQL. `whereVisible` returns `qb.where(condition)`, or `qb` when the condition is null. `roleIn` in personal mode is one query: `projects` left-joined to the viewer's `project_members` row.

`can` encodes spec §4.3 as this table:

| Action | owner | editor | viewer |
| --- | --- | --- | --- |
| `comment` | yes | yes | yes |
| `publish` | yes | yes | no |
| `editArtifact` | yes | own only | no |
| `deleteArtifact` | yes | own only | no |
| `deleteOthersComment` | yes | no | no |
| `createShareLink` | yes | yes | no |
| `revokeShareLink` | yes | own only | no |
| `manageProject` | yes | no | no |
| `manageMembers` | yes | no | no |

"Own" is `ctx.publishedBy === ctx.userId`.

`defaultProjectFor`:
- **System scope or team mode:** `teamDefaultProject(db)`, else `ensureDefaultProject(deps)`.
- **Personal viewer:**
  1. the viewer's own `is_default = 1` project;
  2. else adopt the oldest unowned default project that holds no artifact, with a conditional update on `owner_id is null`, and return it if the update won;
  3. else insert `{ id: newId('prj'), name: t('project.defaultName'), is_default: 1, owner_id: u, created_by: u }` with `onConflict((oc) => oc.column('owner_id').where('is_default', '=', 1).doNothing())`, then read the own default again.

The fixture, built through the actor-taking domain functions:
- **People:** A, E, V and S are oidc members; X is an oidc admin. Each has a cookie and an API token.
- **Projects:** A creates P and Q. E is added to P as editor and V as viewer *before* any content.
- **Artifacts:**
  - `p` in P and `q` in Q, by A, each with two versions. Files: `index.html` with `<meta property="og:image" content="cover.png">`, `cover.png` (a PNG signature plus bytes, as `test/api/preview.test.ts` makes it), and `notes.md`. `index.html` and `notes.md` change in version 2.
  - Each has a thread by A on version 1 with one reply by A, and a share link by A (no password, follows current, comments allowed).
  - `e` in P, by E: one version and a link by E. E also writes a thread on `p` (`eThread`).
- **Persistence:** each call builds new people and projects, so several fixtures can share one context.

- [ ] **Step 1: Write the failing tests.**

```ts
// spaces.test.ts — describe.each(dialects)
test('whereVisible keeps a personal viewer to owned and shared projects', …);
  // projects P, Q (A), R (B); E member of P → visible ids: E [P], A [P, Q], B [R]; a team scope and SYSTEM_SCOPE: all three
test('whereVisible adds nothing in team mode', …);   // compiled SQL of whereVisible(qb, teamScope, 'projects.id') === qb.compile().sql
test('roleIn answers owner, editor or viewer, and not-found for a stranger', …);   // S on P → { status: 404, code: 'not_found' }; team: S 'owner'
test.each(CAN_TABLE)('can(%s, %s) is %s', …);   // every row of the table above, own and other for the "own only" cells
test('assertCan refuses with reason role in personal mode only', …);   // V publish → 403 { reason: 'role' }; team scope → no throw
test('each person gets a default project of their own', …);
  // personal: S and E → two rows, is_default 1, owned, named t('project.defaultName'); Promise.all of 3 calls per person → one row each
test('the first person on an empty instance adopts the unowned default project', …);   // ensureDefaultProject; S → prj_000…, owner S; E → a new id
test('an unowned default project holding artifacts is never adopted', …);   // prj_000… unowned with an artifact row → S gets a new id
test('team mode shares the oldest default project', …);   // two defaults (T, T+1) → both scopes get the older; none → prj_000… is created
test('scopes carry the configured visibility and the admin flag', …);
// scope-guard.test.ts — reads every .ts file under apps/server/src
test('only the allow-list imports SYSTEM_SCOPE', …);   // files whose text matches /\bSYSTEM_SCOPE\b/ ⊆ the Global Constraints list
test('nobody but spaces.ts builds a scope by hand', …);   // /kind:\s*'(system|viewer)'/ only in domain/spaces.ts
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/spaces test/spaces/scope-guard`. Expected: FAIL (`domain/spaces.ts` missing).
- [ ] **Step 3: Implement** `domain/spaces.ts` and the fixture as above. en.json:
  - `"spaces.role.comment": "Only people in this project can comment on it."`
  - `"spaces.role.publish": "You can view this project but not publish to it. Ask its owner to make you an editor."`
  - `"spaces.role.editArtifact": "Only the project's owner, or the editor who published this artifact, can change it."`
  - `"spaces.role.deleteArtifact": "Only the project's owner, or the editor who published it, can delete this."`
  - `"spaces.role.deleteOthersComment": "Only the comment's author or the project's owner can delete this comment."`
  - `"spaces.role.createShareLink": "Viewers cannot create share links. Ask the project's owner to make you an editor."`
  - `"spaces.role.revokeShareLink": "Only the project's owner, or the editor who made this link, can revoke it."`
  - `"spaces.role.manageProject": "Only the project's owner can rename or archive it, or change its instructions."`
  - `"spaces.role.manageMembers": "Only the project's owner can add, remove or change members."`
- [ ] **Step 4: Run** the Step 2 command, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add spaces scope, visibility condition, project roles and default projects`.

### Task 4: The scope on every lookup (model: opus)

**Files:**
- Modify (domain): `apps/server/src/domain/artifacts.ts`, `projects.ts`, `versions.ts`, `artifact-edit.ts`, `deletion.ts` (rename its local `type Scope` to `DeletionTarget`), `comments.ts`, `shares.ts`, `diff.ts`, `search.ts`
- Modify (callers):
  - REST: `apps/server/src/api/artifacts.ts`, `projects.ts`, `versions.ts`, `content.ts`, `diff.ts`, `comments.ts`, `shares.ts`, `events.ts`, `share-public.ts`;
  - content: `apps/server/src/content/raw-links.ts`;
  - MCP: `apps/server/src/mcp/tools/library.ts`, `review.ts`;
  - publishing: `apps/server/src/publish/sessions.ts`, `ingest.ts`.
- Modify (1.0 tests, scope argument only): `test/domain/projects.test.ts`, `test/domain/commit.test.ts`, `test/domain/diff.test.ts`, `test/api/artifacts.test.ts`, `test/api/preview.test.ts`, `test/api/comments.test.ts`, `test/api/share-links.test.ts`
- Test: `apps/server/test/spaces/idor-rest.test.ts` (reads)

**Interfaces:**
- Consumes: Task 3 `Scope`, `ViewerScope`, `SYSTEM_SCOPE`, `scopeOf`, `scopeForUser`, `whereVisible`, the fixture.
- Produces (every later task and M11–M13 call these):

```ts
getArtifact(db: Db, scope: Scope, id: string, now: number): Promise<ArtifactRow>
holdArtifact(trx: Transaction<Database>, dialect: DbDialect, scope: Scope, id: string, now: number): Promise<ArtifactRow>
lockArtifact(trx: Transaction<Database>, dialect: DbDialect, scope: Scope, id: string): Promise<ArtifactRow | undefined>
listArtifacts(deps: AppDeps, scope: Scope, p: { projectId?; tag?; q?; limit; cursor }): Promise<{ items: ArtifactRow[]; nextCursor: string | null }>
listRecent(deps: AppDeps, scope: ViewerScope, limit: number): Promise<ArtifactRow[]>
getProject(db: Db, scope: Scope, id: string): Promise<ProjectRow>
listProjects(deps: AppDeps, scope: Scope, p: { archived: boolean; limit: number; cursor: string | null })
updateProject(deps: AppDeps, scope: Scope, id: string, p: { name?; instructions?; archived? }): Promise<ProjectRow>
updateArtifact(deps: AppDeps, scope: Scope, id: string, p: { name?; projectId?; tags? }): Promise<ArtifactRow>
listVersions(deps: AppDeps, scope: Scope, artifactId: string, p: { limit; cursor })
checkTarget(deps: AppDeps, scope: Scope, target: PublishTarget): Promise<void>
listThreads(deps: AppDeps, scope: Scope, artifactId: string, f: ThreadFilter)
getThread(deps: AppDeps, scope: Scope, threadId: string); getComment(db: Db, scope: Scope, id: string)
listShareLinks(deps: AppDeps, scope: Scope, artifactId: string, p: { includeRevoked; limit; cursor })
diffVersionFiles(deps, scope, artifactId, from, to); diffTextFile(deps, scope, artifactId, from, to, path); diffMarkdownFile(deps, scope, artifactId, from, to, path?)
toArtifactSummary(deps: AppDeps, scope: Scope, rows: readonly ArtifactRow[]): Promise<ArtifactSummary[]>
```

- [ ] **Step 1: Write the failing tests** (`idor-rest.test.ts`, reads). There is one context per `(dialect, mode)` and one fixture in `beforeAll`, since reads change nothing.

```ts
const READS: [string, (ids: { artifact: string; project: string }) => string][] = [
  ['artifact', (i) => `/artifacts/${i.artifact}`], ['versions', (i) => `/artifacts/${i.artifact}/versions`],
  ['version', (i) => `/artifacts/${i.artifact}/versions/2`], ['files', (i) => `/artifacts/${i.artifact}/versions/2/files`],
  ['threads', (i) => `/artifacts/${i.artifact}/comments`], ['share links', (i) => `/artifacts/${i.artifact}/share-links`],
  ['diff', (i) => `/artifacts/${i.artifact}/diff?from=1&to=2`],
  ['text diff', (i) => `/artifacts/${i.artifact}/diff/file?from=1&to=2&path=index.html`],
  ['markdown diff', (i) => `/artifacts/${i.artifact}/diff/markdown?from=1&to=2&path=notes.md`],
  ['preview grant', (i) => `/artifacts/${i.artifact}/versions/2/preview?mode=review`],
  ['thumbnail', (i) => `/artifacts/${i.artifact}/thumbnail`],
  ['project', (i) => `/projects/${i.project}`], ['project filter', (i) => `/artifacts?project_id=${i.project}`],
];
test.each(READS)("%s of Q: E, V, S and X read it in team mode and get not-found in personal mode", …);
  // ids { artifact: q, project: Q }; team → 200; personal → sameAnswer(r, same path on UNKNOWN_IDS)
test.each(READS)('%s of P: E and V read it in both modes; S and X only in team mode', …);
test('lists leave out what the viewer cannot see', …);
  // S: GET /artifacts → personal: none of p, q, e; team: contains all three. GET /projects → personal: S's own projects only; team: contains P and Q
test('Recent forgets an artifact its viewer can no longer see', …);
  // E opens p's preview; GET /artifacts/recent lists p; removeMember(P, E) → personal: not listed; team: listed
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/idor-rest`. Expected: FAIL (personal reads answer 200).
- [ ] **Step 3: Implement the lookups.**
  - `getArtifact`, `holdArtifact`, `lockArtifact`: `whereVisible(qb, scope, 'artifacts.project_id')` in the same select. A miss goes through the 1.0 tombstone check (410 or 404).
  - `getProject`: `whereVisible(qb, scope, 'projects.id')`.
  - `listArtifacts`: its `filtered()` query and its project check take the scope. The search post-filter is therefore correct already; Task 8 moves the condition inside `searchQuery`.
  - `listProjects`, `listRecent`: `whereVisible` on their list queries.
  - `listVersions`, `listThreads`, `listShareLinks`, the diff functions (`versionPair`): first a scoped `getArtifact`.
  - `getComment`: joins `artifacts` with `whereVisible`; `holdComment` passes the scope.
  - `getShareLink` (revoke path): joins `artifacts` with `whereVisible`.
  - `thumbnailFile(deps, scope, artifactId)`: a scoped `getArtifact`.
- [ ] **Step 4: Implement the scope sources.**
  - Actor-taking functions start with `scopeForUser(deps, actor)`: `commitVersion` and `restoreVersion` (through `lockCurrent`), `deleteArtifact`/`deleteVersion` (from `auth.user`), shares, publish sessions, and ingest's `checkTarget`.
  - Comments use a private `actorScope(deps, actor)`: `scopeForUser` for a member, `SYSTEM_SCOPE` for a guest.
  - `api/share-public.ts` lists threads with `SYSTEM_SCOPE`: the resolved link is the capability.
  - `search.ts` `reindexArtifact` locks with `SYSTEM_SCOPE`.
  - Routes use `scopeOf(c)`; MCP tools use `scopeForUser(deps, auth.user)`; raw links use `scopeForUser(deps, auth.user)` after the sign-in check; the member stream checks at open with `scopeOf(c)` (the heartbeat comes in Task 9).
  - The 1.0 tests: insert `SYSTEM_SCOPE` (or `scopeForUser(ctx.deps, member.user)` for `listRecent`) at the call sites listed in "The 1.0 suite".
- [ ] **Step 5: Run** `pnpm --filter @pinwall/server test test/spaces` and `VITEST_MAX_WORKERS=2 pnpm test`, then `pnpm lint && pnpm typecheck`, plain and with Postgres. Expected: PASS; `git diff --stat v1.0.0 -- apps/server/test` shows only the files this task may change.
- [ ] **Step 6: Commit** `feat(server): pass the viewer's scope to every content lookup`.

### Task 5: Projects and artifacts — owners, default projects, roles, DTO fields (model: opus)

**Files:**
- Modify:
  - domain: `apps/server/src/domain/projects.ts`, `artifact-edit.ts`, `deletion.ts`, `versions.ts` (`planNewArtifact`);
  - REST and MCP: `apps/server/src/api/projects.ts`, `api/artifacts.ts`, `mcp/tools/library.ts`;
  - shared: `packages/shared/src/api/projects.ts`, `packages/shared/src/api/artifacts.ts`, `packages/shared/src/i18n/en.json`.
- Test: `apps/server/test/spaces/idor-rest.test.ts` (project and artifact writes), `apps/server/test/spaces/projects.test.ts`

**Interfaces:**
- Consumes: Task 3 `roleIn`, `rolesIn`, `assertCan`, `can`, `seesAll`, `defaultProjectFor`, `teamDefaultProject`; Task 4's signatures.
- Produces:

```ts
// packages/shared — personal mode only; absent in team mode
Project.owner?: { id: string; name: string | null } | null;   Project.role?: 'owner' | 'editor' | 'viewer';
ArtifactSummary.can_manage?: boolean;
// domain/deletion.ts
export function canDelete(scope: Scope, role: ProjectRole, auth: AuthContext, publishedBy: string | null): boolean;   // seesAll: 1.0 (admin or artifact publisher); personal: can(role, 'deleteArtifact', …)
// api/projects.ts
export async function toProjects(deps: AppDeps, scope: Scope, rows: readonly ProjectWithCount[]): Promise<Project[]>;   // toProject, plus owner and role in personal mode
```

- [ ] **Step 1: Write the failing tests.** Each write case gets a fresh fixture in the shared context. In the case tables of Tasks 5–7, `P`, `p`, `pV2`, … stand for `ids.P`, `ids.p`, `ids.pV2`, …, and `patch`/`post`/`del`/`multipart(path, body)` are local shorthands returning `(api, ids) => …`. Each `send` builds its path from the `CaseIds` it is given, so `expectCase` can replay it on `UNKNOWN_IDS`.

```ts
const WRITES: Case[] = [   // c(who, name, send, team, personal, reason?)
  c('A', 'rename P', patch(`/projects/${P}`, { name: 'x' }), 200, 200), c('E', 'rename P', …, 200, 403), c('V', 'rename P', …, 200, 403),
  c('S', 'rename P', …, 200, 404), c('E', 'rename Q', …, 200, 404),
  c('A', 'rename p', patch(`/artifacts/${p}`, { name: 'x' }), 200, 200), c('E', 'rename p', …, 200, 403), c('V', 'rename p', …, 200, 403),
  c('S', 'rename p', …, 200, 404), c('E', 'rename e', …, 200, 200), c('A', 'move p to Q', patch(`/artifacts/${p}`, { project_id: Q }), 200, 200),
  c('E', 'delete p', del(`/artifacts/${p}`), 403, 403), c('V', 'delete p', …, 403, 403), c('S', 'delete p', …, 403, 404),
  c('X', 'delete p', …, 204, 404), c('A', 'delete p', …, 204, 204), c('E', 'delete e', del(`/artifacts/${e}`), 204, 204),
  c('A', 'delete e', …, 403, 204),   // team: neither publisher nor admin; personal: the project's owner
  c('E', 'delete version 1 of p', del(`/artifacts/${p}/versions/1`), 403, 403), c('A', 'delete version 1 of p', …, 204, 204),
];
test.each(WRITES)('$who: $name', (c) => expectCase(ctx, fx, mode, c));
// projects.test.ts — describe.each(dialects)
test('the project DTO names owner and role only in personal mode', …);
  // E GET /projects/P → personal: role 'editor', owner { id: A, name: 'A' }; V: role 'viewer'; team: no 'role' or 'owner' key
test('can_manage only in personal mode', …);   // personal: A on p true, E on p false, E on e true, V on p false; team: key absent
test('personal: listing projects gives each person a default project of their own, listed first', …);
  // S GET /projects → first item is S's default (is_default true, role 'owner'); E's list: E's default first, then P (role 'editor')
test("personal: a publish without a project lands in the publisher's own default project", …);   // publishFiles(S, default target) → project owner S
test('team mode lists the oldest default first and later defaults as ordinary projects', …);
  // prj_000… (T) and a default owned by S (T+1): team GET /projects → [prj_000… (is_default true), …, S's default (is_default false)] in creation order;
  // PATCH S's default { archived: true } → 409 project.defaultArchive (an is_default row never archives)
test('an artifact moves only between projects of one owner', …);
  // personal: E moves e to E's own default → 403 { reason: 'other_space' }; A moves p to a project of S → 404 (same as UNKNOWN); team: both 200
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/idor-rest test/spaces/projects`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`listProjects` ordering:** the cursor key `d` is 1 for exactly one project, the viewer's default.
    - Team mode: `case when projects.id = <teamDefaultProject id> then 1 else 0 end`, and the returned rows' `is_default` is 1 only for that project.
    - Personal mode: `case when projects.owner_id = <viewer> and projects.is_default = 1 then 1 else 0 end`; rows keep `is_default`.
    - The cursor shape `{ d, c, i }` is unchanged.
  - **Project routes:**
    - Listing active projects first runs `defaultProjectFor(deps, scope)`, which replaces 1.0's `ensureDefaultProject`.
    - GET and PATCH `/projects/{id}` call `ensureDefaultProject` for `DEFAULT_PROJECT_ID` only when `seesAll(scope)`.
    - Responses go through `toProjects`, which in personal mode makes one users query for owner names and one `rolesIn`.
  - **`updateProject`:** `assertCan(scope, await roleIn(trx, scope, id), 'manageProject')` after the scoped read. The 1.0 rule that an `is_default = 1` row never archives stays.
  - **`updateArtifact`:**
    - `assertCan(…, 'editArtifact', { publishedBy: current.created_by, userId })`.
    - A move reads the target with `whereVisible` and `forShare`; a miss is 404 `project.notFound`.
    - In personal mode, a target whose `owner_id` differs from the source project's gets `forbidden(t('spaces.move.otherSpace'), { reason: 'other_space' })`, and the target also needs `assertCan(…, 'publish')`.
  - **`deleteArtifact` and `deleteVersion`:** use `canDelete`.
    - Team refusal: 1.0 `artifact.deleteForbidden` with no reason. Personal refusal: `forbiddenRole('deleteArtifact')`.
    - A version delete in personal mode checks `version.created_by`, after `getVersionByNumber` in the transaction.
  - **`toArtifactSummary`:** in personal mode, `rolesIn` for the rows' projects, then `can_manage = can(role, 'editArtifact', { publishedBy: row.created_by, userId })`.
  - **`planNewArtifact`:** `projectId ?? (await defaultProjectFor(deps, scope)).id`. `checkTarget` still skips a null project, as 1.0 did.
  - **MCP `readProject`:** no id → `defaultProjectFor`; `DEFAULT_PROJECT_ID` with `seesAll` → `ensureDefaultProject`; any other id → scoped `getProject`. `list_projects` (active) runs `defaultProjectFor` first.
  - **en.json:** `"spaces.move.otherSpace": "An artifact can only move between projects that have the same owner."`
- [ ] **Step 4: Run** the Step 2 command and `VITEST_MAX_WORKERS=2 pnpm --filter @pinwall/server test`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): give projects owners, per-person default projects and role checks`.

### Task 6: Publishing under the scope, checked again at commit (model: opus)

**Files:**
- Modify: `apps/server/src/domain/versions.ts` (`checkTarget`, `insertArtifact`, `lockCurrent`, `restoreVersion`)
- Test: `apps/server/test/spaces/idor-publish.test.ts`

**Interfaces:**
- Consumes: Task 3 `roleIn`, `assertCan`, `whereVisible`; Task 4 `checkTarget(deps, scope, target)`, `lockArtifact(…, scope, …)`; 1.0 `runUpload`, `referencedShas`.
- Produces:
  - `checkTarget` refuses a viewer with `forbiddenRole('publish')` and a stranger with not-found.
  - `commitVersion` and `restoreVersion` check visibility and the `publish` role again inside their transaction, against the configuration and memberships of that moment.

- [ ] **Step 1: Write the failing tests.** Bodies go as `test/api/publish-rest.test.ts` sends them.

```ts
const PUBLISH: Case[] = [
  c('E', 'session for a new artifact in P', post('/publish-sessions', { target: { project_id: P } }), 201, 201),
  c('V', …same, 201, 403), c('S', …same, 201, 404), c('E', 'session for a new artifact in Q', …, 201, 404),
  c('E', 'session for a new version of p', post('/publish-sessions', { target: { artifact_id: p, expected_version_id: pV2 } }), 201, 201),
  c('V', …same, 201, 403), c('S', …same, 201, 404),
  c('V', 'inline into P', post('/publish/inline', …), 201, 403), c('S', 'inline into P', …, 201, 404),
  c('V', 'web upload into P', multipart('/publish/upload', …), 201, 403), c('S', 'web upload into P', …, 201, 404),
  c('E', 'restore version 1 of p', post(`/artifacts/${p}/versions/1/restore`, { expected_version_id: pV2 }), 201, 201),
  c('V', …same, 201, 403), c('S', …same, 201, 404),
];
test('an upload URL whose editor was removed is refused at commit, leaving nothing', …);   // Review Focus 2
  // E gets a session for a new version of p; removeMember(P, E); POST /upload/<token> with Content-Type text/html
  // → personal: 404 not_found, same body as a session on an unknown artifact; p's versions unchanged; no new artifact;
  //   the blob store holds exactly referencedShas(deps); team: the same steps publish (201)
test('an upload URL of an editor made a viewer is refused at commit with reason role', …);   // role set to 'viewer' → 403 { reason: 'role' }, nothing written
test('the commit checks again after the target check passed', …);
  // domain: checkTarget(deps, scopeForUser(E), target) passes; removeMember; commitVersion(deps, E, target, staged) → 404, no rows
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/idor-publish`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`checkTarget`:** the scoped `getProject` or `getArtifact`, then `assertCan(scope, await roleIn(db, scope, projectId), 'publish')`, then the 1.0 archive, tag and current-version checks.
  - **`insertArtifact`:** its `forShare` project read gains `whereVisible` (a miss is 404 `project.notFound`) and `assertCan(…, 'publish')`.
  - **`lockCurrent`:** after the scoped lock, `assertCan(scope, await roleIn(trx, scope, artifact.project_id), 'publish')`.
  - **Upload URLs:** `runUpload` already reads the actor fresh and runs `checkTarget` and `commitVersion` with `scopeForUser`, so an upload URL is judged at use. A refused commit leaves no row, and ingest's staging cleanup removes its blobs, as in 1.0.
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/api/publish test/publish test/domain/commit`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): check space and role on every publish path, again at commit`.

### Task 7: Comments and share links under project roles (model: opus)

**Files:**
- Modify: `apps/server/src/domain/comments.ts` (`canDeleteComment`, the `comment` check), `apps/server/src/domain/shares.ts` (`createShareLink`, `canRevoke`)
- Test: `apps/server/test/spaces/idor-rest.test.ts` (comment and share cases)

**Interfaces:**
- Consumes: Task 3 `roleIn`, `assertCan`, `can`; Task 4 `holdComment`/`getShareLink` with scope.
- Produces:
  - `canDeleteComment(scope, role, user, comment, artifact)`: author always; otherwise team 1.0, personal `can(role, 'deleteOthersComment')`.
  - `canRevoke(scope, role, user, link, artifact)`: team 1.0; personal `can(role, 'revokeShareLink', { publishedBy: link.created_by, userId })`.
  - `createShareLink` refuses `forbiddenRole('createShareLink')`.

- [ ] **Step 1: Write the failing tests.**

```ts
const REVIEW: Case[] = [
  c('V', 'comment on p', post(`/artifacts/${p}/comments`, { body: 'x', anchor: sampleAnchor() }), 201, 201), c('S', 'comment on p', …, 201, 404),
  c('V', "reply to A's thread", post(`/comments/${pThread}/replies`, { body: 'x' }), 201, 201), c('S', "reply to A's thread", …, 201, 404),
  c('E', "edit A's comment", patch(`/comments/${pThread}`, { body: 'x' }), 403, 403, null),   // author only, 1.0 message, no reason
  c('S', "edit A's comment", …, 403, 404),
  c('E', "delete A's reply", del(`/comments/${pReply}`), 403, 403), c('S', "delete A's reply", …, 403, 404), c('X', "delete A's reply", …, 204, 404),
  c('A', "delete E's thread on p", del(`/comments/${eThread}`), 204, 204),
  c('V', "resolve A's thread", post(`/comments/${pThread}/resolve`, {}), 200, 200), c('S', "resolve A's thread", …, 200, 404),
  c('S', "reopen A's thread", post(`/comments/${pThread}/reopen`, {}), 200, 404),
  c('E', 'create a link on p', post(`/artifacts/${p}/share-links`, { allow_comments: false }), 201, 201),
  c('V', 'create a link on p', …, 201, 403), c('S', 'create a link on p', …, 201, 404),
  c('E', "revoke A's link", del(`/share-links/${pLink}`), 403, 403), c('S', "revoke A's link", …, 403, 404), c('X', "revoke A's link", …, 204, 404),
  c('E', "revoke E's link", del(`/share-links/${eLink}`), 204, 204), c('A', "revoke E's link", …, 403, 204),
];
test('guests keep reading and commenting through a share link in personal mode', …);
  // A's link on p: GET /api/v1/share/<token> 200; a guest POST …/comments 201; GET …/comments lists it — 1.0 behavior
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/idor-rest`. Expected: FAIL (the personal-mode role cases).
- [ ] **Step 3: Implement.**
  - **Member comments:** `createThread`, `addReply`, `resolveThread`, `reopenThread` call `assertCan(…, 'comment')`; every role passes, so this only fixes the order of checks.
  - **`deleteComment`:** uses `canDeleteComment`. Team refusal: 1.0 `comment.deleteForbidden`. Personal refusal: `forbiddenRole('deleteOthersComment')`.
  - **Links:** `createShareLink` calls `assertCan(…, 'createShareLink')` inside its transaction after `holdArtifact`. `revokeShareLink` uses `canRevoke`; team refusal `share.revokeForbidden`, personal `forbiddenRole('revokeShareLink')`.
  - **Guests** skip the role checks; their link is checked as in 1.0.
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/api/comments test/api/share test/mcp/tools-review`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): apply project roles to comments and share links`.

### Task 8: Search inside the index query, and cursors across a mode switch (model: opus)

**Files:**
- Modify: `apps/server/src/db/dialect.ts` (`searchQuery`), `apps/server/src/domain/artifacts.ts` (`listArtifacts` passes its scope)
- Modify (1.0 tests, scope argument only): `test/db/search.test.ts`, `test/publish/ingest.test.ts`, `test/ops/restore.test.ts`, `test/domain/commit.test.ts`
- Test: `apps/server/test/spaces/search.test.ts`

**Interfaces:**
- Consumes: Task 3 `visibleCondition`, `seesAll`, `withVisibility`; 1.0 `searchUpsert`.
- Produces: `searchQuery(h: DbScope, q: string, limit: number, scope: Scope): Promise<string[]>`. When `seesAll(scope)`, it runs the 1.0 SQL text unchanged. Otherwise it joins `artifacts` and applies `visibleCondition(scope, 'a.project_id')` before `LIMIT`, in both the FTS5 and the Postgres query.

- [ ] **Step 1: Write the failing tests** (`describe.each(dialects)`).

```ts
test("another space's matches neither crowd out nor reorder a person's results", …);   // Review Focus 1
  // personal: 1,200 artifact rows of A in one of A's projects, indexed with searchUpsert ('report n'), inserted in bulk;
  // S publishes two: 'report report report' (short) and 'report' inside a long body.
  // S GET /artifacts?q=report → exactly S's two, in the order an instance without A's 1,200 gives, next_cursor null;
  // searchQuery(h, 'report', 1, scopeOfS) → [S's short one]
test('search finds nothing of another space', …);   // personal S q=<a word only q's page has> → []; team → [q]
test('team mode runs the 1.0 search', …);   // a team scope returns what SYSTEM_SCOPE returns, the 1,000-match cap included
test('a list cursor minted in team mode returns only visible items in personal mode', …);   // Review Focus 2
  // listArtifacts(withVisibility(deps, 'team'), team scope of S, { limit: 1 }) → cursor;
  // listArtifacts(withVisibility(deps, 'personal'), personal scope of S, { limit: 100, cursor }) → ids ⊆ S's artifacts
test('a search cursor minted in team mode returns only visible items in personal mode', …);   // the same with q and the { o } cursor
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/search`. Expected: FAIL (the crowding case: S's results fall outside the first 1,000).
- [ ] **Step 3: Implement.**
  - **SQLite:** `select s.artifact_id from search_index s join artifacts a on a.id = s.artifact_id where s.search_index match ${match} and ${condition} order by s.rank, s.artifact_id limit ${limit}`.
  - **Postgres:** the 1.0 query with `join artifacts a on a.id = s.artifact_id` and `and ${condition}`.
  - **`listArtifacts`:** passes its scope. Its post-filter (project, tag, archived) stays as in 1.0.
  - **The 1.0 tests:** append `SYSTEM_SCOPE` to each `searchQuery` call.
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/db/search test/api/artifacts test/publish/ingest test/ops/restore test/domain/commit`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): filter search by space inside the index query`.

### Task 9: Sight checked again at use — grants, raw links, member streams, share-link makers (model: opus)

**Files:**
- Modify: `apps/server/src/content/grants.ts` (`resolveGrant`), `apps/server/src/api/events.ts` (`memberStillAllowed`), `apps/server/src/domain/share-access.ts` (`assertMakerCurrent`)
- Test: `apps/server/test/spaces/idor-content.test.ts`, `apps/server/test/spaces/idor-sse.test.ts`

**Interfaces:**
- Consumes: Task 3 `scopeForUser`, `whereVisible`, `seesAll`; 1.0 `SSE_HEARTBEAT_MS`, `listen`, `readSse`, `fetchContent`.
- Produces:
  - **`resolveGrant`:** a grant made for a user serves only while that user's scope sees the version's artifact. Otherwise it answers 410 `content.gone.message`, like a deleted version.
  - **`memberStillAllowed`:** also requires sight, at every heartbeat.
  - **`assertMakerCurrent`:** in personal mode also requires the maker to see the link's artifact. Otherwise the link answers like a revoked one; this suspends the link, it does not revoke it.

- [ ] **Step 1: Write the failing tests.**

```ts
// idor-content.test.ts — describe.each(dialects) × MODES
test('a member grant stops serving once its holder cannot see the artifact', …);   // Review Focus 4
  // E: preview grant (review) and raw grant on p → content 200; removeMember(P, E) → next request 410 (personal), 200 (team);
  // addMember again → 200 (personal: the grant was refused, not deleted)
test('raw links answer an invisible artifact like a missing one, in the browser and to an agent', …);   // Review Focus 3
  // S cookie, Accept: text/html, GET /a/<q>/raw → personal: 404 page equal to /a/<UNKNOWN>/raw without its request id; team: 302
  // S bearer GET /a/<q>/v/1/raw → personal: 404 JSON equal to the unknown one; team: 302
test('a share link stops opening when its maker can no longer see the artifact', …);   // Review Focus 4
  // E's link on p; GET /s/<token> opens; removeMember(P, E) → personal: answers as a revoked link
  // (/api/v1/share/<token> 410 { reason: 'revoked' }); addMember again → opens; team: always opens
// idor-sse.test.ts — real socket as test/api/events.test.ts; only setInterval faked
test("a stranger cannot follow another space's artifact", …);   // S GET /api/v1/artifacts/<p>/events → personal: 404 equal to unknown; team: 200 stream
test("a member's stream ends within one heartbeat of losing sight", …);   // Review Focus 4
  // E stream on p; removeMember(P, E); vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS) → stream closed (personal), open (team)
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/idor-content test/spaces/idor-sse`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`resolveGrant`**, for `grant.user_id !== null`: the version read becomes `versions` joined to `artifacts`, with `whereVisible(scopeForUser(deps, user), 'artifacts.project_id')`. It stays two queries, as in 1.0. Share grants (`user_id` null) keep their 1.0 path.
  - **`memberStillAllowed`:** its artifact query takes `whereVisible(scopeForUser(deps, user), 'artifacts.project_id')`.
  - **`assertMakerCurrent`:** after the access test, unless `seesAll`, an `exists` query on the link's artifact with the maker's condition. A miss throws `linkGone('revoked')`. It covers `resolveShare`, `holdCommentLink` and `shareGrant`.
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/content test/api/events test/api/share`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): check sight again for grants, member streams and share-link makers`.

### Task 10: MCP tools in personal mode (model: sonnet)

**Files:**
- Modify: `apps/server/src/mcp/tools/library.ts`, `apps/server/src/mcp/schemas.ts`
- Test: `apps/server/test/spaces/idor-mcp.test.ts`

**Interfaces:**
- Consumes: Tasks 4–9; 1.0 `connectMcp`, `toolText`.
- Produces: `ProjectOut` gains optional `role` and `owner` (`{ id, name }`), set in personal mode only. Tool descriptions stay as they are; M14 rewords them.

- [ ] **Step 1: Write the failing tests** (`describe.each(dialects)` × `MODES`, bearer tokens from the fixture).

```ts
const TOOLS: [string, (ids: CaseIds) => Record<string, unknown>][] = [
  ['get_artifact', (i) => ({ artifact_id: i.q })], ['list_comments', (i) => ({ artifact_id: i.q })],
  ['list_share_links', (i) => ({ artifact_id: i.q })], ['get_project', (i) => ({ project_id: i.Q })],
  ['reply_to_comment', (i) => ({ comment_id: i.qThread, body: 'x' })], ['resolve_comment', (i) => ({ comment_id: i.qThread })],
  ['create_share_link', (i) => ({ artifact_id: i.q })], ['revoke_share_link', (i) => ({ share_link_id: i.qLink })],
  ['create_publish_session', (i) => ({ target: { project_id: i.Q } })],
  ['publish_inline', (i) => ({ target: { project_id: i.Q }, files: [{ path: 'index.html', content: '<p>x</p>' }] })],
];   // argument names as each tool's input schema (TargetIn, ReplyToCommentIn, …) has them
test.each(TOOLS)('%s on Q: personal answers as for an unknown id; team as 1.0', …);   // Review Focus 3
  // E and S: personal → isError, toolText equal to the same call on UNKNOWN_IDS; team → not isError
test('list_artifacts and search_artifacts leave out other spaces', …);   // S personal: neither lists p, q or e
test('a viewer is told why it cannot publish or share', …);
  // V personal: publish_inline into P → toolText contains t('spaces.role.publish'); create_share_link on p → t('spaces.role.createShareLink'); team: both succeed
test('list_projects and get_project show role and owner in personal mode only', …);
  // E personal: P has role 'editor', owner { id: A.id, name: 'A' }; team: structuredContent has no role or owner key
test("get_project without an id is the caller's own default project", …);   // personal S → S's default, is_default true
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/idor-mcp`. Expected: FAIL (role and owner missing).
- [ ] **Step 3: Implement.** In personal mode, `toProjectOut(row, extra?)` adds `role` and `owner` from `rolesIn` and one users query. Everything else already comes from the domain. Refusals reach the agent through `toolError` with the domain message.
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/mcp`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): show project role and owner in MCP tools in personal mode`.

---

## M10 done when

- `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=2 pnpm test` pass, and `pnpm test:integration` passes, so the IDOR suite (`test/spaces/idor-*.test.ts`) runs in both modes on SQLite and Postgres.
- Every 1.0 test passes, and `git diff --stat v1.0.0 -- apps/server/test ':!apps/server/test/spaces' apps/web` lists only the files in "The 1.0 suite". A reviewer reading `git diff v1.0.0 -- <those files>` finds only scope arguments, the new columns, the one list line and the seed rows.
- A 1.0 SQLite database migrates and a 1.0 backup restores with owners as spec §8.1 says (Task 1). The guard refuses `personal` → `team` until `pinwall visibility team --confirm` (Task 2; spec acceptance 7).
- `scope-guard.test.ts` passes, and every Review Focus test above passes.
