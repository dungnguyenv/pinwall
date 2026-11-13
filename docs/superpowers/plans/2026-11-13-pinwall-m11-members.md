# Pinwall M11 — Project Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `personal` mode a project's owner adds existing Pinwall users by email as editors or viewers, changes their roles and removes them, and a member can leave. Removal, leaving and demotion take effect at once on grants, live streams, upload URLs and share links, and on Postgres they take turns with every role check. `team` mode hides all of it.

**Architecture:**
- `domain/members.ts` holds the membership reads and changes. `api/members.ts` holds the four routes, which call only that module and answer like an unknown route in `team` mode.
- Each change first checks sight and role without a lock, so a stranger's request locks nothing. It then takes the project row `FOR UPDATE` (`lockProject`) for the change and its effects.
- Removal and leaving run `endProjectAccess` inside that transaction: the person's links on the project's artifacts first, then their grants. It never locks an artifact row. After commit, `finishEndedAccess` ends the revoked links' streams, makes the person's member streams check their sight at once, and drops their upload URLs into the project. Demotion revokes the person's links only.
- Every write that reads a role inside its transaction does so with `holdRoleIn`: the project `FOR SHARE`, then the role in a later statement. On Postgres a write and a membership change therefore run one after the other, never interleaved.

**Tech Stack:** unchanged: Kysely (SQLite and Postgres), Hono + `@hono/zod-openapi`, zod, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-pinwall-personal-spaces-design.md` §4.1 (project members), §4.3 (role table and "When a member is removed or leaves"), §4.4, §5 items 4–6, §10 (Members panel, API side), §11 acceptance 9, on top of `docs/superpowers/specs/2026-11-10-pinwall-design.md`.

**Roadmaps:** `docs/superpowers/plans/2026-11-13-pinwall-v1.1-roadmap.md` (M11 scope, the member routes, the `memberLookup` rule, Review Focus 2 and 5) and `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`. Names come from the M10 code (`domain/spaces.ts`, `test/spaces/fixture.ts`) and the M10 plan's "Interface handed to M11–M13".

**Depends on:** M10 on `v1.1` (4264c0b).

**Out of scope:**
- The web Members panel (M13).
- Quotas (M12). Acceptance 9's "counts toward the owner's quota" is M12's quota test. M11 asserts that an editor's artifact lands in the owner's project, which is what M12's usage sums over.
- Transfer (M12).
- MCP member tools: there are none.

**Runs in parallel with M12** (another worktree). These files are shared, so keep M11's edits to them additive and local:
- `auth/rate-limits.ts`: each milestone adds keys to `RATE_RULES`.
- `domain/shares.ts`: M11 adds `revokeProjectShareLinksOf` and `holdRoleIn` calls; M12 changes `createShareLink`.
- `packages/shared/src/i18n/en.json`: M11 adds one `spaces.members.*` block.
- the v1.1 roadmap.

## Global Constraints

Both roadmaps' Global Constraints and the M10 plan's apply. For M11:
- **Personal mode only.** In `team` mode the four member routes answer exactly as an unknown `/api/v1` route does (`404 not_found`, `t('error.notFound.message')`), before authentication. Stored memberships stay untouched. The `domain/members.ts` functions refuse a scope that `seesAll` with 404 `project.notFound`.
- **Not-found sameness (M10).** A project the caller cannot see answers like `UNKNOWN_IDS.P`, admins included. No lookup and no lock runs only for projects that exist.
- **Roles (spec §4.3).** Only the owner adds, removes and changes roles. Anyone else gets 403 `forbidden`, `details.reason = 'role'`, `t('spaces.role.manageMembers')`. Every member may list the members and may leave. Member roles are `editor` and `viewer`.
- **Add by email.**
  - An exact, case-insensitive match on active users (`hasAccess`). OIDC accounts match only with `email_verified = 1`.
  - Several matches and no `user_id` → 409 `conflict`, `details.candidates: [{ user_id, name, kind }]`.
  - No match → 404 with a message that says to ask them to sign in to Pinwall once first.
  - The owner cannot add themselves.
- **`memberLookup`:** 30 per 3 600 000 ms, keyed by user id. It counts every `POST /api/v1/projects/{id}/members`, refused ones included.
- **Removal and leaving make immediate what M10 re-checks lazily:**
  - the person's content grants for the project's artifacts are deleted and tombstoned;
  - their member streams on those artifacts end;
  - their unused upload URLs into the project or its artifacts are dropped;
  - the share links they made on its artifacts are revoked, which ends those links' grants and streams.

  Their comments stay. **Demoting an editor to viewer revokes those links and nothing else** (ruling).
- **No new direct content-table query in `api/` or `mcp/`** (`scope-guard.test.ts`). No `SYSTEM_SCOPE` in M11 source.
- **No new field in any existing response.** Member DTOs exist only behind the personal-mode routes.
- **Tests** live in `apps/server/test/spaces/` and use `describe.each(dialects)`. "With Postgres" means the same command with `PINWALL_TEST_POSTGRES_URL=postgres://pinwall:pinwall@localhost:55432/pinwall`, after `docker compose -f docker-compose.test.yml up -d --wait`. Full runs use `VITEST_MAX_WORKERS=2`.
- **i18n:** new keys sit in one block with the prefix `spaces.members.`.
- Conventional Commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commit on `v1.1` (or the M11 worktree branch), never push.

## Review Focus

1. **Losing sight with the artifact open (roadmap Review Focus 2, removal).** A removed or leaving member has a review tab, a live stream, a share link and Recent on an artifact of the project. Expected:
   - the stream ends at once, well within one `SSE_HEARTBEAT_MS` (25 000 ms);
   - the review grant answers 410 on its next request;
   - the link answers "gone";
   - Recent no longer lists the artifact;
   - the same person's things in other projects keep working.

   → Task 3 `removal ends the member's live streams on the project at once`, `removal ends the member's grants for the project at once, for good`, `removal revokes the share links the member made in the project`, `Recent forgets the project's artifacts`.
2. **One email, several accounts (roadmap Review Focus 5, member part).** The local Owner account and an OIDC account share an email. Expected: a 409 that lists both by name and sign-in method, nothing added until one is picked, and only the picked one added. → Task 2 `several accounts with one email: the owner chooses, and only that one is added`.
3. **A write racing its author's removal or demotion on Postgres (M10 review Minor 4).** Expected: a link, version or reply that commits after the membership change is refused. A link that committed first is revoked by the change. A deletion and a removal never deadlock. → Task 4 `%s by a member being removed waits, then is refused`, `a removal waits for a link in flight, then revokes it`, `a removal locks no artifact row`.
4. **Re-adding someone who was removed.** M10's lazy checks would let old grants serve again and old links reopen. Expected: grants and links ended by the removal stay ended. → Task 3 (re-add steps in the grant and link tests).
5. **An email probe by someone who is not the owner** (an editor, a viewer, a stranger, an admin). Expected:
   - the same answer for an email with an account and one without;
   - no lookup;
   - the attempt still counts against their own limit.

   → Task 2 `members, strangers and admins learn nothing about emails`, `add-by-email attempts are limited to 30 an hour per person`.

## How membership changes and writes take turns (Postgres)

SQLite transactions already run one at a time (`BEGIN IMMEDIATE`). Team mode has no membership changes. So every statement below is Postgres-only and personal-mode-only, and team mode runs exactly the 1.0 SQL.

- **A membership change** (add, role change, removal, leave):
  1. checks sight and role with `roleIn(db, …)`, without a lock;
  2. opens a transaction and takes `lockProject` (`FOR UPDATE`); the owner's changes (add, role change, removal) then read the role again with `holdRoleIn` and refuse as in step 1 when the caller no longer manages the members, since a change of owner under the same lock (M12's transfer) may have committed in between;
  3. changes the membership, then runs its effects.

  After the lock it never locks an artifact row. Links go first, one artifact at a time in id order, then grants in token order.
- **A write in a project** takes its artifact lock (if it has one), then `holdRoleIn`, before writing anything. `holdRoleIn` is the project `FOR SHARE` and then `roleIn` as a separate statement. The role read gets a fresh READ COMMITTED snapshot, so it sees a membership change that committed while the hold waited. A role read in the same statement as the lock would use the snapshot from before the wait.
  - Applies to: `createShareLink`, `revokeShareLink`, `insertArtifact`, `lockCurrent`, `updateArtifact` (both role reads), and the comment writes (`createThread`, `addReply`, `resolveThread`, `reopenThread`, `deleteComment`).
- **Deletions** (`deleteArtifact`, `deleteVersion`) call `holdProject(trx, dialect, deps.config.visibility, projectId)` right after `lockArtifact`, for every scope. A system deletion (M12's admin deletes) and a membership change then take turns on the same link, grant and tombstone rows.
- **Ending a person's access** (`revokeShareLinksOf`: "Revoke now", a block, the IdP dropping the person, and M12's moderation) is a system write too. For each artifact, in id order, it holds the artifact (`FOR SHARE`), then `holdProject`, then revokes the person's links on it. `revokeAllCredentials` ends the person's grants after that, in token order (`revokeUserGrants`).
- **`updateProject` is exempt.** It is owner-only, and a membership change never changes the owner. A `FOR SHARE` before its own `UPDATE` of the same row would deadlock two renames.
- **Why this cannot deadlock:** every transaction that touches the rows of a project's artifacts goes artifact → project → rows: writes, deletions and the ending of a person's access alike. A membership change takes the project and then only link, grant, tombstone and membership rows, never an artifact.
  - Whoever holds such a row holds its project too, so a membership change, which holds the project `FOR UPDATE`, never waits for one.
  - Whoever waits for a membership change waits at the project, before touching any of its rows.
  - Two transactions that hold artifacts never wait for each other at the project: both ask for it `FOR SHARE`, and on Postgres a `FOR SHARE` request joins the holders even while a membership change's `FOR UPDATE` waits.
  - The exception is the grants that `revokeUserGrants` ends without holding their project (the person has no link there). Every grant ending inserts its tombstones in token order: `endGrants` (removals, Revoke now), `endGrantsOf` (link revokes) and the deletions' `grantTombstones`. Two that share a grant therefore take turns at the first one they share.
  - Every pair being acyclic is not enough. An earlier `revokeShareLinksOf` went artifact → links. With a write (artifact → project) and a removal (project → links), those three formed a cycle: Revoke now held artifact b and E's link on b and waited for artifact a, the write held a and waited for the project, and the removal held the project and waited for the link on b. `members-race.test.ts` keeps that case.

## Interface handed to M12–M13

- **M12 (transfer, purge, admin moderation):**
  - Reusable pieces: `lockProject`, `holdProject`, `revokeProjectGrants`, `recheckViewerStreams`, `revokeUploadSessionsFor`.
  - Transfer ends the source owner's grants, streams and upload URLs on each moved project with these, keeping links (§8.2). It holds each moved project with `lockProject`, and deletes the target's own `project_members` row.
  - Any personal-mode `SYSTEM_SCOPE` write inside a project's artifacts that does not go through `deletion.ts` (for example an admin link revoke, or purge) calls `holdProject` after its artifact lock.
  - `RATE_RULES` gains `memberLookup`; M12 adds its rules next to it.
- **M13 (Members panel):**
  - **Routes and bodies:** `GET`/`POST /api/v1/projects/{id}/members`, `PATCH`/`DELETE /api/v1/projects/{id}/members/{user_id}`, with `ProjectMember`, `ProjectMemberList`, `AddMemberRequest`, `UpdateMemberRequest` and `MemberCandidate` from `@pinwall/shared`.
  - **The list** holds members only: the owner is `Project.owner`. `user.email` is set only in the owner's view.
  - **Refusals to show:**
    - 409 `details.reason`: `'several_accounts'` (with `candidates`) or `'already_member'`;
    - 404 with `details.field = 'email'`: no account;
    - 400 with `details.field = 'email'`: the owner picked themselves;
    - 403 `reason: 'role'`.
  - **Visibility:** show the panel only when `PublicConfig.visibility === 'personal'`.

## Roadmap refinements (made in this plan's commit)

In `2026-11-13-pinwall-v1.1-roadmap.md`:
- the "Members (M11)" block gets the real signatures below;
- `lockProject`, `holdProject` and `holdRoleIn` join the `domain/spaces.ts` block;
- `MemberCandidate` and the member-list rule join the DTOs;
- the `conflict` reasons `several_accounts` and `already_member` join Errors.

---

### Task 1: Members domain and routes: list, change role, remove, leave (model: opus)

**Files:**
- Create: `apps/server/src/domain/members.ts`, `apps/server/src/api/members.ts`, `packages/shared/src/api/members.ts`
- Modify: `apps/server/src/domain/spaces.ts` (`lockProject`), `apps/server/src/api/router.ts` (`registerMemberRoutes` after `registerProjectRoutes`), `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/spaces/members.test.ts`

**Interfaces:**
- Consumes: M10 `Scope`, `scopeOf`, `seesAll`, `roleIn`, `assertCan`, `getProject`; the fixture (`spacesContext`, `spacesFixture`, `sameAnswer`, `UNKNOWN_IDS`, `MODES`, `T`); 1.0 `notFoundHandler`, `requireAuth`, `jsonBodyLimit`, `restClient`.
- Produces:

```ts
// packages/shared/src/api/members.ts (re-exported from api/index.ts)
export const ProjectMemberRole = z.enum(['editor', 'viewer']);
export const ProjectMember = z.object({
  user: z.object({ id: z.string(), name: z.string().nullable(), /** Only in the owner's view; null otherwise. */ email: z.string().nullable() }),
  role: ProjectMemberRole,
  added_at: Timestamp,
});
/** The project's members, oldest first. The owner is not listed: see `Project.owner`. */
export const ProjectMemberList = z.object({ items: z.array(ProjectMember) });
export const AddMemberRequest = z.object({ email: z.email().max(254), role: ProjectMemberRole, user_id: z.string().min(1).max(100).optional() });
export const UpdateMemberRequest = z.object({ role: ProjectMemberRole });
export const MemberCandidate = z.object({ user_id: z.string(), name: z.string().nullable(), kind: z.enum(['owner', 'oidc']) });
// domain/spaces.ts
/** Postgres: the project row FOR UPDATE, for a membership change (see holdRoleIn). SQLite: nothing. */
export async function lockProject(trx: Transaction<Database>, dialect: DbDialect, projectId: string): Promise<void>;
// domain/members.ts
export async function listMembers(deps: AppDeps, scope: Scope, projectId: string): Promise<ProjectMember[]>;
export async function setMemberRole(deps: AppDeps, scope: Scope, projectId: string, userId: string, role: MemberRole): Promise<ProjectMember>;
/** The owner removes `userId`, or a member removes themselves (leaves). */
export async function removeMember(deps: AppDeps, scope: Scope, projectId: string, userId: string): Promise<void>;
// api/members.ts
export function registerMemberRoutes(api: OpenAPIHono<AppEnv>): void;
```

- [ ] **Step 1: Write the failing tests** (`members.test.ts`, `describe.each(dialects)`; one `personal` and one `team` context per dialect; a fresh `spacesFixture` per test).

```ts
test('team mode answers every member route as an unknown route', …);
  // team: A's GET /projects/P/members, POST { email: S.email, role: 'viewer' }, PATCH …/members/E { role: 'viewer' },
  // DELETE …/members/E: each sameAnswer the same method on /projects/P/no-such-route; GET without a cookie too (404, not 401);
  // project_members still holds E and V
test('the owner sees members with their emails, oldest first; members see names only', …);
  // personal: A GET /projects/P/members → 200 { items: [
  //   { user: { id: E.id, name: 'E', email: E.email }, role: 'editor', added_at: T },
  //   { user: { id: V.id, name: 'V', email: V.email }, role: 'viewer', added_at: T } ] sorted by user id (both added at T) }   (A not listed)
  // E and V → the same items with email: null
  // a member added later (clock + 1 s) is listed after both
test('a stranger or an admin gets the answer of an unknown project', …);
  // S and X: GET /projects/P/members sameAnswer GET /projects/<UNKNOWN_IDS.P>/members; E on Q likewise
test('the owner changes a role', …);
  // A PATCH /projects/P/members/V { role: 'editor' } → 200 { user: { id: V.id, name: 'V', email: V.email }, role: 'editor', added_at: T };
  //   V POST /publish-sessions { target: { project_id: P } } → 201
  // A PATCH E { role: 'viewer' } → 200; E POST the same → 403 { details: { reason: 'role' } }
  // A PATCH E { role: 'viewer' } again → 200, unchanged
test('only the owner manages members', …);
  // E PATCH V, V PATCH V { role: 'editor' }, E DELETE V, V DELETE E →
  //   403 { error: { code: 'forbidden', message: t('spaces.role.manageMembers'), details: { reason: 'role' } } }
test('a member leaves, and the owner removes one', …);
  // V DELETE /projects/P/members/<V.id> → 204; V GET /projects/P → 404
  // A DELETE /projects/P/members/<E.id> → 204; E GET /artifacts/p → 404; A GET members → { items: [] }
test('someone who is not a member', …);
  // A PATCH …/members/<S.id>, A DELETE …/members/<S.id>, A DELETE …/members/<A.id> → 404 { message: t('spaces.members.notMember') }
  // A PATCH …/members/<E.id> { role: 'owner' } → 400 bad_request
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/members.test`. Expected: FAIL (the routes answer 404 in personal mode).
- [ ] **Step 3: Implement.**
  - **`lockProject`:** `select id from projects where id = ? for update` on Postgres; nothing on SQLite.
  - **Every domain function** starts with a personal viewer, else 404 `project.notFound`. Then `role = await roleIn(db, scope, projectId)`, which gives a stranger 404 before any other query.
  - **`listMembers`:** `project_members` joined to `users`, ordered by `created_at`, then `user_id`. `email` is the user's only when `role === 'owner'`, else `null`.
  - **`setMemberRole`:**
    1. `assertCan(scope, role, 'manageMembers')`.
    2. In a transaction: `lockProject`, read the row (none → 404 `t('spaces.members.notMember')`).
    3. A different role is updated. Return the DTO in the owner's view.
  - **`removeMember`:**
    1. Unless `userId === viewer.id`, `assertCan(scope, role, 'manageMembers')`.
    2. In a transaction: `lockProject`, delete the row (0 rows → 404 `spaces.members.notMember`, which also covers the owner leaving their own project).
  - **Routes** (tag `members`, `security` session or bearer):
    - GET `/projects/{id}/members` → 200 `ProjectMemberList`;
    - PATCH `/projects/{id}/members/{user_id}` → 200 `ProjectMember`;
    - DELETE `/projects/{id}/members/{user_id}` → 204.

    Middleware is `[personalOnly, requireAuth]`, plus `jsonBodyLimit` on PATCH. `personalOnly` returns `notFoundHandler(c)` unless `config.visibility === 'personal'`. Params: `IdParam.extend({ user_id: z.string().min(1).max(100) })`. Each route's description says "personal mode only; in team mode it answers 404 like an unknown route". Responses carry `Cache-Control: no-store`.
  - **en.json:** `"spaces.members.notMember": "This person is not a member of this project."`
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @pinwall/server test test/spaces test/api/openapi`, plain and with Postgres. Expected: PASS, `scope-guard.test.ts` included.
- [ ] **Step 5: Commit** `feat(server): add project member routes to list, change, remove and leave`.

### Task 2: Add by email: lookup, choice of account, rate rule (model: opus)

**Files:**
- Modify: `apps/server/src/domain/members.ts`, `apps/server/src/api/members.ts` (POST), `apps/server/src/auth/rate-limits.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/spaces/members-email.test.ts`

**Interfaces:**
- Consumes: Task 1 (`lockProject`, the DTOs, `personalOnly`); 1.0 `hasAccess`, `rateLimit`, `RATE_RULES`, `conflict`, `badRequest`, `notFound`, `createSignedInUser`.
- Produces:

```ts
// auth/rate-limits.ts
RATE_RULES.memberLookup = { name: 'member-lookup', limit: 30, windowMs: 3_600_000 };
// domain/members.ts
/** Active users (hasAccess) whose email equals `email` ignoring letter case: the owner account, and OIDC accounts with a verified email. Oldest first (created_at, id). */
export async function findUsersByEmail(db: Db, email: string): Promise<UserRow[]>;
export async function addMember(deps: AppDeps, scope: Scope, projectId: string,
  p: { email: string; role: MemberRole; userId: string | null }): Promise<ProjectMember>;
```

- [ ] **Step 1: Write the failing tests** (`members-email.test.ts`, `describe.each(dialects)`, personal mode, a fresh fixture per test). To set an email, update the `users` row of a person made with `createSignedInUser`.

```ts
test('the owner adds a user by email, whatever its letter case', …);
  // A POST /projects/P/members { email: S.email.toUpperCase(), role: 'viewer' } →
  //   201 { user: { id: S.id, name: 'S', email: S.email }, role: 'viewer', added_at: T }; S GET /projects lists P with role 'viewer'
test('an email no active account uses answers not-found, saying to ask them to sign in once first', …);
  // 'nobody@example.test' → 404 { code: 'not_found', message: t('spaces.members.noAccount'), details: { field: 'email' } },
  //   message contains 'sign in to Pinwall once first'; project_members unchanged
  // the same answer for the email of: an oidc user with email_verified 0; a disabled user; role_override 'blocked'; idp_role null
  // an owner-kind account (email_verified 0) with that email is added
test('several accounts with one email: the owner chooses, and only that one is added', …);   // Review Focus 2
  // own context: O (kind 'owner', name 'Owner', email 'same@example.test'), D (oidc, verified, 'Danny', 'Same@Example.TEST', created after O),
  //   U (oidc, email_verified 0, same email)
  // A POST { email: 'same@example.test', role: 'editor' } → 409 { code: 'conflict', message: t('spaces.members.severalAccounts'),
  //   details: { reason: 'several_accounts', candidates: [{ user_id: O.id, name: 'Owner', kind: 'owner' }, { user_id: D.id, name: 'Danny', kind: 'oidc' }] } };
  //   project_members unchanged
  // with user_id: D.id → 201 for D; members of P are E, V, D (O not added); with user_id: U.id → 404 noAccount
test('the owner may be among the accounts offered, but cannot pick themselves', …);
  // D creates project R; D POST R { email: 'same@example.test', user_id: D.id } → 400 { message: t('spaces.members.self'), details: { field: 'email' } };
  //   user_id: O.id → 201
test('the owner cannot add themselves', …);   // A POST P { email: A.email } → 400 spaces.members.self
test('adding a member twice is a conflict and changes nothing', …);
  // A POST { email: E.email, role: 'viewer' } → 409 { message: t('spaces.members.already'), details: { reason: 'already_member' } }; E is still editor
test('a user_id that is not one of the matching accounts answers like no account', …);   // { email: S.email, user_id: V.id } → 404 noAccount
test('members, strangers and admins learn nothing about emails', …);   // Review Focus 5
  // E and V POST P { email: S.email } and { email: 'nobody@example.test' } → both 403 reason 'role', equal bodies
  // S and X POST P (both emails) → sameAnswer as POST /projects/<UNKNOWN_IDS.P>/members
test('add-by-email attempts are limited to 30 an hour per person', …);   // Review Focus 5
  // A: 30 POSTs mixing 201, 404 (no account), 409 (already) and 400 (body { email: 'x' }) → the 31st → 429 rate_limited with Retry-After
  // S: 30 POSTs on P (404 each) → the 31st → 429; E's first POST → 403 (counted on its own)
  // ctx.clock.advance(3_600_000) → A's next POST → not 429
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/members-email`. Expected: FAIL (POST answers 404).
- [ ] **Step 3: Implement.**
  - **`findUsersByEmail`:**
    - SQL: `lower(email) = lower(?)` and (`kind = 'owner'` or `email_verified = 1`), ordered by `created_at`, `id`.
    - Then filter with `hasAccess` in code.
    - SQLite's `lower` folds ASCII only, so other capitals match as typed there.
  - **`addMember`**, in this order. The lookup runs only for the project's owner.
    1. Personal viewer, else 404 `project.notFound`.
    2. `roleIn` (404 for strangers), then `assertCan(…, 'manageMembers')`.
    3. `findUsersByEmail`.
    4. Pick the account:
       - with `userId`, the match with that id;
       - else the only match;
       - none → 404 `notFound(t('spaces.members.noAccount'), { field: 'email' })`;
       - several and no `userId` → `conflict(t('spaces.members.severalAccounts'), { reason: 'several_accounts', candidates })`, with every match as `{ user_id, name, kind }`.
    5. The picked id is the viewer's → `badRequest(t('spaces.members.self'), { field: 'email' })`.
    6. Transaction: `lockProject`. An existing row → `conflict(t('spaces.members.already'), { reason: 'already_member' })`. Otherwise insert `{ project_id, user_id, role, added_by: viewer, created_at: now }`.
    7. Return the DTO in the owner's view.
  - **POST `/projects/{id}/members`:**
    - middleware `[personalOnly, requireAuth, rateLimit(RATE_RULES.memberLookup, (c) => authOf(c).user.id), jsonBodyLimit]`, so every attempt counts before its body is read;
    - body `AddMemberRequest`; 201 `ProjectMember`;
    - documented responses: 400, 403, 404, 409, 429.
  - **en.json:**
    - `"spaces.members.noAccount": "Nobody with this email has signed in to Pinwall yet. Ask them to sign in to Pinwall once first, then add them."`
    - `"spaces.members.severalAccounts": "More than one Pinwall account uses this email. Choose the one to add."`
    - `"spaces.members.self": "You own this project, so you cannot add yourself to it."`
    - `"spaces.members.already": "This person is already a member of this project. Change their role instead."`
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/spaces/members test/auth`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add project members by email, with a choice between accounts and a lookup limit`.

### Task 3: Removal, leaving and demotion take effect at once (model: opus)

**Files:**
- Modify:
  - `apps/server/src/domain/members.ts`;
  - `apps/server/src/domain/shares.ts` (`revokeProjectShareLinksOf`, sharing a private per-artifact step with `revokeShareLinksOf`);
  - `apps/server/src/content/grants.ts` (`revokeProjectGrants`);
  - `apps/server/src/domain/live.ts`;
  - `apps/server/src/http/sse.ts` (`checkTopic`);
  - `apps/server/src/api/events.ts`;
  - `apps/server/src/infra/one-time-store.ts` (`deleteMatching`);
  - `apps/server/src/publish/sessions.ts` (`revokeUploadSessionsFor`).
- Test: `apps/server/test/spaces/members-removal.test.ts`

**Interfaces:**
- Consumes: Task 1 `removeMember`, `setMemberRole`, `lockProject`; 1.0/M10 `endGrantsOf` (private in shares.ts), `addTombstones`, `endShareLinkStreams`, `memberStillAllowed`, `listen`, `readSse`, `fetchContent`, `SSE_HEARTBEAT_MS`, `newSecret`.
- Produces:

```ts
// content/grants.ts
/** Ends the grants made for `userId` on versions of `projectId`'s artifacts: deleted, live ones tombstoned (410). Returns how many. */
export async function revokeProjectGrants(db: Db, userId: string, projectId: string, now: number): Promise<number>;
// domain/shares.ts
/** revokeShareLinksOf for `projectId`'s artifacts, for a transaction that holds the project with lockProject: artifacts in id order,
 *  none held (a write holding one may be waiting on the project). Returns the ids revoked; end their streams after commit. */
export async function revokeProjectShareLinksOf(trx: Transaction<Database>, userId: string, projectId: string, now: number): Promise<string[]>;
// domain/live.ts
export const VIEWER_ACCESS_TOPIC = (userId: string): string => `viewer-access:${userId}`;
/** Makes `userId`'s open member streams check their sight now. Call it once the change has committed. */
export function recheckViewerStreams(deps: AppDeps, userId: string): void;
// http/sse.ts
LiveStreamOptions.checkTopic?: string;   // every event on it runs the access check at once, as a heartbeat does
// infra/one-time-store.ts
/** Removes the entries of `group` that `match` accepts; returns their keys. */
OneTimeStore.deleteMatching(group: string, match: (key: string, value: unknown) => boolean): Promise<string[]>;
// publish/sessions.ts
/** Drops `userId`'s unused upload URLs (session and receipt) into `projectId`, or for a new version of one of `artifactIds`. Returns how many. */
export async function revokeUploadSessionsFor(deps: AppDeps, userId: string, target: { projectId: string; artifactIds: readonly string[] }): Promise<number>;
// domain/members.ts
export interface EndedAccess { userId: string; projectId: string; linkIds: string[]; artifactIds: string[] }
/** Spec §4.3 removal, in the transaction that holds the project (lockProject): the person's links on its artifacts, then their grants on its versions. Locks no artifact row. */
export async function endProjectAccess(trx: Transaction<Database>, projectId: string, userId: string, now: number): Promise<EndedAccess>;
/** After commit: ends the revoked links' streams, recheckViewerStreams, revokeUploadSessionsFor. */
export async function finishEndedAccess(deps: AppDeps, ended: EndedAccess): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** (`members-removal.test.ts`, `describe.each(dialects)`, personal mode). Use a real socket and fake only the heartbeat interval, as `idor-sse.test.ts` does. Use a fresh fixture per test. Changes go through the Task 1–2 routes. "Elsewhere" is an artifact E publishes into E's own default project (`publishFiles`, `projectId: null`).

```ts
test('deleteMatching removes only the matching entries of a group', …);
  // InMemoryOneTimeStore: k1, k2 in group g match, k3 in g does not, k4 in group h matches → ['k1', 'k2']; k3 and k4 remain
test('removal ends the member's grants for the project at once, for good', …);   // Review Focus 1 and 4
  // E's review and raw grants on p and a review grant elsewhere → 200; A DELETE /projects/P/members/<E.id>
  // → p's grants 410 (renderContentErrorPage('gone')), no content_grants row of E on P's versions; elsewhere → 200
  // A POST { email: E.email, role: 'editor' } → p's old grants still 410 (M10 alone would serve them again)
test("removal ends the member's live streams on the project at once", …);   // Review Focus 1
  // fakeHeartbeat(); E streams on p and elsewhere; DELETE E → p's stream done() without advancing the heartbeat;
  // the other stays open (done(300) false)
test('removal drops the member's unused upload URLs into the project', …);
  // E's sessions: { artifact_id: p, expected_version_id: pV2 }, { project_id: P }, and no project (E's default)
  // DELETE E → the first two: POST /upload/<token> sameAnswer an upload to /upload/<newSecret()> (404 publish.session.unknown);
  // the third → 201
test('removal revokes the share links the member made in the project', …);   // Review Focus 1 and 4
  // tokens from createShareLink: E on e, E on p, E elsewhere, A on p; a guest stream on E's link on e
  // DELETE E → GET /api/v1/share/<E's tokens in P> → 410 { details: { reason: 'revoked' } }, revoked_at = T; the guest stream ends at once;
  // A's link and E's elsewhere → 200; re-add E → E's P links still 410
test('their comments and artifacts stay', …);   // after DELETE E: A lists p's threads incl. eThread; e is still in P, created_by E
test("Recent forgets the project's artifacts", …);   // Review Focus 1: E opens p's preview → Recent lists p → DELETE E → not listed
test('leaving has the same effects', …);   // V's grant on p and V's stream on p; V DELETE …/members/<V.id> → 410, stream ends
test('demoting an editor to a viewer revokes their links in the project and nothing else', …);
  // A PATCH E { role: 'viewer' } → E's links on e and p → 410 revoked, their guest streams end; E's grant on p → 200;
  // E's stream on p stays open; E GET /artifacts/p → 200
test('a role change that changes nothing ends nothing', …);   // PATCH E 'editor' and V → 'editor': every link still opens
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/members-removal`. Expected: FAIL (grants serve again after re-adding, the stream outlives the removal, URLs and links survive).
- [ ] **Step 3: Implement the building blocks.**
  - **`revokeProjectGrants`:** as `revokeUserGrants`, limited to `version_id in (select versions.id from versions join artifacts on artifacts.id = versions.artifact_id where artifacts.project_id = ?)`.
  - **`revokeProjectShareLinksOf`:**
    - distinct `artifact_id` of the person's unrevoked links on the project's artifacts (join `artifacts`), sorted;
    - for each artifact, the per-artifact step that `revokeShareLinksOf` also runs after its `holdIfPresent`: update `revoked_at`, then `endGrantsOf`;
    - no artifact hold.
  - **`liveStream`:** with `checkTopic`, `start` subscribes `() => void check()` next to `endTopic`.
  - **`api/events.ts`:** the member stream passes `checkTopic: VIEWER_ACCESS_TOPIC(auth.user.id)`.
  - **`recheckViewerStreams`:** publishes `{ type: 'access.changed' }` on that topic.
  - **`deleteMatching`:** a scan like `deleteGroup`.
  - **`revokeUploadSessionsFor`:**
    - `deleteMatching(userGroup(userId).group, …)` on keys starting `upload:` whose `UploadSession.target` is `{ kind: 'new_artifact', projectId }` or `{ kind: 'new_version' }` with an id in `artifactIds`;
    - then deletes the receipt `upload-receipt:<h>` of each, so the URL answers as unknown.
    - An upload already running is not "unused": its commit is refused by M10's re-check.
- [ ] **Step 4: Implement the composition.**
  - **`endProjectAccess`:**
    1. `linkIds = revokeProjectShareLinksOf(…)`;
    2. `revokeProjectGrants(trx, …)`;
    3. `artifactIds` = the project's artifact ids.

    Links come first, as in `revokeAllCredentials`.
  - **`finishEndedAccess`:** `endShareLinkStreams` per link, `recheckViewerStreams`, `await revokeUploadSessionsFor`.
  - **`removeMember`:** runs `endProjectAccess` in its transaction after the delete, and `finishEndedAccess` after commit.
  - **`setMemberRole`:** from `editor` to `viewer`, runs `revokeProjectShareLinksOf` in its transaction and `endShareLinkStreams` after commit. Nothing else (ruling).
- [ ] **Step 5: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/spaces test/api/events test/api/share test/publish test/infra test/auth/revoke`, plain and with Postgres. Expected: PASS (1.0 tests unchanged).
- [ ] **Step 6: Commit** `feat(server): end a removed member's grants, streams, upload URLs and links at once`.

### Task 4: Writes and membership changes take turns on Postgres (model: opus)

**Files:**
- Modify:
  - `apps/server/src/domain/spaces.ts` (`holdProject`, `holdRoleIn`);
  - `apps/server/src/domain/shares.ts`, `versions.ts` (`insertArtifact`, `lockCurrent`), `artifact-edit.ts`, `comments.ts` (`assertMayComment` gains `dialect`), `deletion.ts`.
- Test: `apps/server/test/spaces/members-race.test.ts`, `apps/server/test/spaces/scope-guard.test.ts` (one test)

**Interfaces:**
- Consumes: Task 1 `lockProject`, `removeMember`, `setMemberRole`; Task 3 `endProjectAccess`; test helper `untilWaitingOnALock(db, settled)`.
- Produces:

```ts
// domain/spaces.ts
/** Postgres in personal mode: the project row FOR SHARE, for any scope (the system's deletions too); a membership change (lockProject) and this transaction take turns. Otherwise nothing. Call it after the artifact lock, before writing. */
export async function holdProject(trx: Transaction<Database>, dialect: DbDialect, visibility: Visibility, projectId: string): Promise<void>;
/** roleIn for a write in `trx`: holdProject for a personal viewer, then roleIn as a later statement, so a membership change that committed during the wait is seen. Team mode and the system: 'owner', no query. */
export async function holdRoleIn(trx: Transaction<Database>, dialect: DbDialect, scope: Scope, projectId: string): Promise<ProjectRole>;
```

- [ ] **Step 1: Write the failing tests.**

```ts
// members-race.test.ts
test('holdRoleIn runs no query in team mode or for the system', …);
  // a trx stub whose every method throws: holdRoleIn(stub, 'postgres', teamScope, 'prj_x') and (…, SYSTEM_SCOPE, …) → 'owner'
describe.runIf(dialects.includes('postgres'))('membership changes on Postgres', () => {   // personal context, fresh fixture per test
  test.each([
    ['a share link', (fx) => createShareLink(deps, E.user, fx.ids.p, { versionId: null, password: null, expiresAt: null, allowComments: true })],
    ['a new version', (fx) => publishFiles(ctx, E.user, files, { kind: 'new_version', artifactId: fx.ids.p, expectedVersionId: fx.ids.pV2 })],
    ['a reply', (fx) => addReply(deps, { kind: 'member', user: E.user }, fx.ids.pThread, 'x')],
  ])('%s by a member being removed waits, then is refused', …);   // Review Focus 3
    // held = transaction: lockProject(trx, 'postgres', P); delete E's project_members row; await gate
    // write = the case; await untilWaitingOnALock(db, write); open the gate; await held
    // → write rejects with status 404; no share link, version 3 or reply by E exists
  test('a removal waits for a link in flight, then revokes it', …);   // Review Focus 3
    // held = transaction: holdRoleIn(trx, 'postgres', scopeForUser(deps, E.user), P); insert a share_links row by E on p; await gate
    // removal = removeMember(deps, scopeForUser(deps, A.user), P, E.user.id); untilWaitingOnALock(db, removal); open the gate
    // → removal resolves; the link's revoked_at is set
  test('a demotion waits for a link in flight, then revokes it', …);   // the same with setMemberRole(…, E.user.id, 'viewer')
  test('a removal locks no artifact row', …);
    // held = transaction: lockArtifact(trx, 'postgres', SYSTEM_SCOPE, p) (as a deletion does); await gate
    // removeMember(… E) resolves while held is open; then in held: holdProject(trx, 'postgres', 'personal', P) succeeds; commit
});
// scope-guard.test.ts
test('writes read roles with holdRoleIn', …);
  // no file under src matches /\broleIn\(trx\b/ except domain/spaces.ts (holdRoleIn itself) and domain/projects.ts
  // (updateProject: owner-only, and a FOR SHARE before its own UPDATE would deadlock two renames)
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/members-race test/spaces/scope-guard` with Postgres. Expected: FAIL (`holdRoleIn` is not exported; the writes do not wait).
- [ ] **Step 3: Implement.**
  - `holdProject`: `select id from projects where id = ? for share` when `dialect === 'postgres'` and `visibility === 'personal'`.
  - `holdRoleIn`: when `personalViewer(scope) !== null`, run `holdProject(…, 'personal', …)`; then `return roleIn(trx, scope, projectId)`.
  - Replace each `roleIn(trx, …)` with `holdRoleIn(trx, dialect, …)` in:
    - shares: `createShareLink`, `revokeShareLink`;
    - versions: `insertArtifact`, `lockCurrent`;
    - `updateArtifact`, both role reads;
    - comments: `deleteComment`, `resolveThread`, `reopenThread`, and `assertMayComment`, which serves `createThread` and `addReply`.
  - `deleteArtifact` and `deleteVersion`: `await holdProject(trx, dialect, deps.config.visibility, artifact.project_id)` right after `lockArtifact`, before `assertCanDelete`.
- [ ] **Step 4: Run** the Step 2 command with Postgres, then `VITEST_MAX_WORKERS=2 pnpm --filter @pinwall/server test`, plain and with Postgres. Expected: PASS; plain runs list the Postgres-only block as skipped.
- [ ] **Step 5: Commit** `fix(server): serialize membership changes with role checks on Postgres`.

### Task 5: Member cases in the IDOR suite and acceptance 9 (model: sonnet)

**Files:**
- Modify: `apps/server/test/spaces/fixture.ts` (`Case['send']` also receives `people`)
- Test: `apps/server/test/spaces/idor-members.test.ts`, `apps/server/test/spaces/members-acceptance.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 routes; the fixture.
- Produces:
  - `Case['send']: (api: RestApi, ids: CaseIds, people: Record<Who, Person>) => Promise<Reply>`.
  - `expectCase` passes `fx.people` to both of its calls.
  - Existing tables are unchanged: their sends ignore the third argument.

- [ ] **Step 1: Write the failing tests.**

```ts
// idor-members.test.ts — describe.each(dialects) × MODES, a fresh fixture per case; team: every route 404, like an unknown route
const MEMBERS: Case[] = [   // c(who, name, send, team, personal, reason?); send builds its path from (ids, people)
  c('A', 'list P', get(P members), 404, 200), c('E', 'list P', …, 404, 200), c('V', 'list P', …, 404, 200),
  c('S', 'list P', …, 404, 404), c('X', 'list P', …, 404, 404), c('E', 'list Q', get(Q members), 404, 404),
  c('A', 'add S to P', post(P members, { email: S.email, role: 'viewer' }), 404, 201), c('E', 'add S to P', …, 404, 403),
  c('V', 'add S to P', …, 404, 403), c('S', 'add S to P', …, 404, 404), c('X', 'add X to P', …, 404, 404), c('E', 'add S to Q', …, 404, 404),
  c('A', 'make V an editor', patch(P members/V, { role: 'editor' }), 404, 200), c('E', 'make V an editor', …, 404, 403),
  c('V', 'make V an editor', …, 404, 403), c('S', 'make V an editor', …, 404, 404),
  c('A', 'remove E', del(P members/E), 404, 204), c('V', 'remove E', …, 404, 403), c('S', 'remove E', …, 404, 404), c('X', 'remove E', …, 404, 404),
  c('E', 'leave P', del(P members/E), 404, 204), c('V', 'leave P', del(P members/V), 404, 204),
  c('S', 'leave P', del(P members/S), 404, 404), c('E', 'leave Q', del(Q members/E), 404, 404),
];
test.each(MEMBERS)('$who: $name', (c) => expectCase(ctx, fx, mode, c));
// members-acceptance.test.ts — describe.each(dialects), personal, real socket; spec §11 acceptance 9 through the API only
test('a viewer sees that project only, comments, and cannot publish', …);
  // A POST P members { email: S.email, role: 'viewer' } → 201
  // S: GET /projects lists P (role 'viewer') and not Q; GET /artifacts/p 200, /artifacts/q 404;
  //   POST /artifacts/p/comments 201; POST /publish-sessions into P and POST /publish/inline into P → 403 reason 'role'
test("an editor publishes there, into the owner's space", …);
  // A PATCH S → 'editor'; S POST /publish/inline into P → 201; the new artifact's project is P, owned by A (M12 counts it for A)
test('after removal the review tab, the stream and the links in that project are gone', …);
  // as editor S: preview grant on p (200), stream on p, a link on p (GET /api/v1/share/<token> 200), Recent lists p
  // A DELETE S → content 410; the stream ends without a heartbeat; the link 410 reason 'revoked'; Recent omits p
test("none of it reaches the owner's other project", …);
  // S as editor of P: GET /artifacts/q, POST /publish-sessions into Q, POST /artifacts/q/share-links, GET /projects/Q/members
  // → each sameAnswer the same request on UNKNOWN_IDS
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/spaces/idor-members test/spaces/members-acceptance`. Expected: FAIL (`people` is undefined inside the sends until `expectCase` passes it). Once Step 3 is done they pass against Tasks 1–4. A case that passes at once is still kept: these tests pin the behavior.
- [ ] **Step 3: Implement** the fixture change: `send` gains `people`, and `expectCase` passes `fx.people`.
- [ ] **Step 4: Run** `VITEST_MAX_WORKERS=2 pnpm test`, `pnpm lint && pnpm typecheck`, and `pnpm test:integration` (Postgres and S3). Expected: PASS.
- [ ] **Step 5: Commit** `test(server): add project member cases to the IDOR suite and automate acceptance 9`.

---

## M11 done when

- `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=2 pnpm test` pass.
- `pnpm test:integration` passes, so `idor-members`, `members-*` and the Postgres block of `members-race` run on SQLite and Postgres.
- Spec acceptance 9 is automated at the API level and passes (`members-acceptance.test.ts`), apart from the quota clause, which M12's quota test owns.
- Roadmap Review Focus 2 (removal) and 5 (member part) pass: Task 3 and Task 2. M10 review Minor 4 is closed by Task 4.
- No 1.0 test file changed. `git diff --stat 4264c0b -- apps/server/test ':!apps/server/test/spaces'` is empty, and `scope-guard.test.ts` passes with no new allow-list entry.
