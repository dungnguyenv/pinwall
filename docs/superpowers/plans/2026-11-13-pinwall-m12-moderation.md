# Pinwall M12 — Exposure Approval, Quotas, Rate Limits, Moderation, Transfer, D8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make open sign-up safe to run. Only admins and approved members may expose content outside Pinwall (`PINWALL_SHARE_LINKS=approved`). Every publish path checks a per-person quota. Fixed per-person rate rules cover publishing, grants, links and projects. Admins get usage, approval, quota overrides, purge, an instance-wide share-link list, look-up of reported URLs and takedown, all without reading private work. The operator moves a space with `pinwall transfer`, and the abuse contact appears where people look for it.

**Architecture:**
- **One predicate decides exposure.** `domain/exposure.ts` holds `mayExpose(config, user)`. It is checked:
  - when a link is created;
  - on every link open, in `assertMakerCurrent`;
  - on raw links;
  - on every content request of a member grant, in `resolveGrant`, which marks the grant `framedOnly`.
- **Usage and quota.** `domain/usage.ts` counts usage by space owner (`personal`) or by publisher (`team`).
  - `checkTarget` runs a pre-check without locks.
  - Inside the commit transaction, after the target is held, `assertQuota` takes `lockUser` on the space owner and checks again.
- **Moderation works on metadata.** It runs through domain functions that take a `SystemScope` argument, so every caller appears on the scope guard's allow-list. Deletions reuse 1.0's deletion and revoke transactions.
- **Transfer is one transaction** in `domain/transfer.ts`, run only by the CLI. Streams, upload URLs and Recent rely on M10's re-checks at use; grants of the person who lost sight are ended in the transaction.

**Tech Stack:** unchanged: Kysely (SQLite and Postgres), Hono + `@hono/zod-openapi`, zod, Vitest. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-pinwall-personal-spaces-design.md` §6, §7, §8.2, §9, §10 (server side) and §12 D8, on top of `docs/superpowers/specs/2026-11-10-pinwall-design.md`.

**Roadmaps:** `docs/superpowers/plans/2026-11-13-pinwall-v1.1-roadmap.md` (M12 scope, Configuration, Data model, Routes, Rate rules, Errors, Review Focus 2, 3, 5) and `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md` (Security model: content responses, share links). Names consumed come from the real code at `4264c0b` and the M10 plan's "Interface handed to M11–M13".

**Depends on:** M10, on `v1.1` at `4264c0b`; the branch starts from `v1.1` at `8af7f06` or later. M11 runs in parallel in another worktree: see "Parallel with M11".

**Out of scope:**
- every web change (M13);
- docs other than the generated `docs/configuration.md`, the skill and tool wording, and the version bump (M14);
- member management (M11).

## Global Constraints

Both roadmaps' Global Constraints apply. For M12:
- **Defaults are 1.0.** `PINWALL_SHARE_LINKS=members`, `PINWALL_QUOTA_BYTES=0`, `PINWALL_QUOTA_ARTIFACTS=0` and no D8 setting give 1.0 behavior. With them, `Me`, `PublicConfig` and `whoami` carry no new key.
  - New `Me`, `PublicConfig` and `whoami` fields are sent only in `personal` mode or when their setting is not at its default; absent means 1.0 behavior.
  - The admin user additions are the exception: they are always sent, because spec §7 shows them in both modes. The 1.0 test `test/api/admin-users.test.ts:76` compares the response's keys with `AdminUser.shape`, and those keys are optional in the schema, so it still passes.
- **Exact values:**
  - Rate rules, keyed by user id:
    - `publish` 60 per 600 000 ms;
    - `grant` 600 per 3 600 000 ms;
    - `shareLinkCreate` 30 per 3 600 000 ms;
    - `projectCreate` 30 per 3 600 000 ms.
  - Error `quota_exceeded`, HTTP 413.
  - A policy refusal is `forbidden` with `details.reason = 'share_links_not_approved'`.
  - A framed-only response carries `Content-Security-Policy: frame-ancestors 'self' <app origin>`.
  - The renamed default is `Default (from <name>)`.
- **Not-found sameness (M10) holds.** A refusal that does not depend on the id (policy, rate) comes before the lookup, so a stranger's id and an unknown id get the same answer.
- **Lock order: artifact, then project, then user row.** This matches M11's plan ("writes go artifact → project") and the 1.0 rule that `setRoleOverride` and `revokeShareLinksOf` hold artifacts before they write the user row.
  - `assertQuota` runs after `insertArtifact`'s project read or after `lockCurrent`, where M11 adds `holdRoleIn`.
  - `updateUserModeration` revokes links before it writes the user row.
  - Transfer locks the moved projects `FOR UPDATE` and never an artifact row, as an M11 membership change does.
- **`SYSTEM_SCOPE`** gains three importers, each listed with a reason in `test/spaces/scope-guard.test.ts`: `api/admin-users.ts` (admin purge), `api/admin-moderation.ts` (moderation routes), `api/me.ts` (a person's purge of their own projects).
  - Moderation functions take `scope: SystemScope`, so a caller cannot reach them without importing `SYSTEM_SCOPE`.
  - No new direct content-table query appears in `api/` or `mcp/`. One that does needs a `DIRECT_QUERIES_ALLOWED` entry with its reason.
- **Moderation logging:** every admin route here logs `deps.logger.info({ admin_id, action, target }, 'moderation')`.
  - Actions: `user.update`, `user.purge`, `share_link.revoke`, `artifact.delete`, `version.delete`, `version.end_grants`, `lookup`.
  - `target` holds ids only, never tokens or URLs. A looked-up URL is logged as its kind and the artifact id.
- **No admin route moves content.** Transfer exists only as the CLI.
- **i18n:** every message goes through `t()`. New keys sit in one block after the `spaces.` block, with these prefixes: `spaces.exposure.`, `quota.`, `purge.`, `transfer.`, `moderation.`, `content.framedOnly.`, `pages.reportAbuse`, `mcp.hint.quota_exceeded`, `mcp.whoami.*`. Each new variable also gets `web.config.help.<VAR>`.
- **Tests:**
  - New tests live in `apps/server/test/moderation/`, run `describe.each(dialects)`, and run `describe.each(MODES)` where the mode matters.
  - "With Postgres" means the same command with `PINWALL_TEST_POSTGRES_URL=postgres://pinwall:pinwall@localhost:55432/pinwall` after `docker compose -f docker-compose.test.yml up -d --wait`.
  - Full runs use `VITEST_MAX_WORKERS=2`.
- Conventional Commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commit on the M12 branch, never push.

## Review Focus

1. **Two publishes at the quota edge at once,** for example an owner and their editor in the same space. Each fits alone; together they go over.
   - Expected: exactly one commits. The other gets `quota_exceeded` and leaves no version and no orphaned blob.
   - Test: Task 2, `two publishes at the edge of the quota at once: exactly one commits`.
2. **The source loses sight while the artifact is open (transfer).**
   - Expected: A's member stream closes within one `SSE_HEARTBEAT_MS` (25 000 ms), A's review grant answers 410, and A's Recent drops the artifact. In `team` mode all three stay.
   - Test: Task 5, `A loses sight while the artifact is open: stream, grant and Recent`.
3. **One email belongs to two accounts** (the owner account and an OIDC account).
   - Expected: `pinwall transfer --to <email>` exits 1, lists both ids, and moves nothing.
   - Test: Task 5, `an email shared by two accounts is refused with both ids, and nothing moves`.
4. **An existing instance switches to `approved` before anyone is approved.**
   - Expected: at their next open, the links of members who are not approved answer exactly like revoked links: the HTML 410 page, and 410 `reason: 'revoked'` from the share API. Admins' links keep opening, and approval brings the others back.
   - Test: Task 1, `a link stops opening once its maker is not approved, and opens again after approval`.
5. **A framed-only grant inside the viewer.** The page's own loads must keep working: images, scripts, nested frames, `fetch`, and the annotator. Only top-level loads are refused.
   - Expected: `Sec-Fetch-Dest` `iframe`, `image`, `script` and `empty` are served. `document`, or no fetch metadata at all, gets 403. Every response for the grant carries `frame-ancestors`. This holds in both isolation modes.
   - Test: Task 1, `a grant of a person who is not approved serves only inside a frame`.

## The 1.0 suite

The default configuration keeps 1.0 behavior. The only edits allowed in 1.0 test files are mechanical:
- `test/api/admin-config.test.ts:136` gains these lines:
  - `'spaces PINWALL_SHARE_LINKS'` (Task 1);
  - `'limits PINWALL_QUOTA_BYTES'` and `'limits PINWALL_QUOTA_ARTIFACTS'` (Task 2);
  - `'spaces PINWALL_ABUSE_CONTACT'`, `'spaces PINWALL_TERMS_URL'` and `'spaces PINWALL_PRIVACY_URL'` (Task 7).
- `test/mcp/skill.test.ts:20` gains `quota_exceeded: true` in its `satisfies Record<ErrorCode, true>` object (Task 2).

Nothing else in a 1.0 test file changes. `PUBLISH_SESSION_RATE` disappears, but its limit stays the same, so `test/api/publish-sessions.test.ts:550` and `test/mcp/tools-publish.test.ts:452` pass unchanged. `docs/configuration.md` is regenerated with `pnpm docs:config` (Tasks 1, 2, 7).

## Parallel with M11

M11 (plan `2026-11-13-pinwall-m11-members.md`, committed at `8af7f06`) edits some of the same files in its own worktree. On merge, keep both sides:
- `auth/rate-limits.ts` (`RATE_RULES`: M11 adds `memberLookup`);
- `domain/spaces.ts` (M11 adds `lockProject`, `holdProject` and `holdRoleIn`; M12 adds `SystemScope`);
- `domain/shares.ts` (M11 adds `holdRoleIn` calls and `revokeProjectShareLinksOf`; M12 changes `createShareLink` and adds `systemRevokeShareLink`);
- `domain/deletion.ts` (M11 adds `holdProject`; M12 adds the system deletions on the same bodies);
- `content/grants.ts` (M11 adds `revokeProjectGrants`; M12 adds `framedOnly`);
- `packages/shared/src/i18n/en.json`, `api/router.ts`, `packages/shared/src/api/index.ts`, `test/spaces/scope-guard.test.ts`.

M12 does not call M11 code, because it is not in the M12 worktree. M11's "Interface handed to M12" asks for three things:
1. **`holdProject` after the artifact hold in every personal-mode `SYSTEM_SCOPE` write outside `deletion.ts`.** Here that means `systemRevokeShareLink` and `endVersionGrants`. The merge adds those two calls. The system deletions get it from M11's `deletion.ts` change, since they share its bodies.
2. **Transfer holds the moved projects with `lockProject`.** Transfer's `FOR UPDATE` on them is that same lock.
3. **Transfer ends the source's grants, streams and upload URLs with M11's helpers.** Its grant step is `revokeProjectGrants` limited to the source user. M11's stream and upload-URL helpers act on the server process's memory, which the `pinwall transfer` process cannot reach, so M10's re-checks at use end those.

If M11 has merged into `v1.1` before Task 5 or Task 6 starts, merge `v1.1` into the M12 branch first and call M11's helpers directly at these points.

## Interface handed to M13 and M14

- **`PublicConfig`:**
  - `share_links?: 'approved'` (absent means `members`);
  - `abuse_contact?`, `terms_url?`, `privacy_url?` (absent means unset).
- **`Me`:**
  - `can_create_share_links?: boolean`, sent only with `approved`; absent means true.
  - `usage?: { bytes, artifacts }` and `limits?: { bytes: number | null; artifacts: number | null }`, sent when `quotaApplies`. `null` means no limit.
- **`AdminUser`:** `usage`, `share_approved`, `quota_bytes` and `quota_artifacts`, always sent. M13 updates `apps/web/src/test/admin.ts` fixtures to carry them.
- **Admin routes** (Task 4, Task 6):
  - `PATCH /admin/users/{id}`;
  - `POST /admin/users/{id}/purge`;
  - `POST /me/purge`;
  - `GET /admin/share-links`;
  - `DELETE /admin/share-links/{id}`;
  - `POST /admin/lookup`;
  - `DELETE /admin/artifacts/{id}`;
  - `DELETE /admin/artifacts/{id}/versions/{n}`;
  - `POST /admin/versions/{id}/end-grants`.

  Purge routes answer 404 in `team` mode; M13 hides them there.
- **Errors M13 shows:**
  - `quota_exceeded` (413), whose `details` carry `space_owner: { id, name }`;
  - `forbidden` with `reason: 'share_links_not_approved'`. The share dialog shows the reason, and "Open original" explains the refusal.
- **M14:** the `whoami` text and the tool descriptions get the "your space" wording. The operator guide documents `pinwall transfer` and the approval order ("approve people before switching to `approved`").

## Roadmap refinements (made with this plan)

These changes are in `2026-11-13-pinwall-v1.1-roadmap.md`:
- `SystemScope` in the `domain/spaces.ts` block;
- `space_owner: { id, name }` in the `quota_exceeded` details;
- the `domain/usage.ts` names;
- `whoami` uses `quota`, not `limits`, for the quota, because 1.0's `limits` already holds the publishing limits;
- `POST /me/purge` is `personal`-only;
- removing approval revokes links only with `approved`;
- the look-up response shape;
- the admin user fields are always sent.

---

### Task 1: Exposure policy — links, raw links, framed-only grants (model: opus)

**Files:**
- Create: `apps/server/src/domain/exposure.ts`, `apps/server/test/moderation/helpers.ts`, `apps/server/test/moderation/exposure.test.ts`, `apps/server/test/moderation/framed-only.test.ts`
- Modify:
  - config: `apps/server/src/config/types.ts`, `config/load.ts`, `config/catalog.ts`, `api/admin-config.ts`;
  - domain: `domain/shares.ts` (`createShareLink`), `domain/share-access.ts` (`assertMakerCurrent`);
  - content: `content/raw-links.ts`, `content/grants.ts`, `content/serve.ts`, `content/error-page.ts`;
  - shared and docs: `packages/shared/src/i18n/en.json`, `docs/configuration.md`.
- Modify (1.0 test, one line): `apps/server/test/api/admin-config.test.ts:136`

**Interfaces:**
- Consumes: M10 `scopeForUser`, `spacesFixture`, `UNKNOWN_IDS`, `sameAnswer`, `MODES`, `T`; 1.0 `effectiveRole`, `resolveGrant`, `contentHeaders`, `fetchContent`, `connectMcp`, `toolText`, `buildApp`.
- Produces:

```ts
// config/types.ts
Config.shareLinks: 'members' | 'approved';
// domain/exposure.ts
/** `members`: everyone; `approved`: admins (effectiveRole) and users with share_approved = 1. */
export function mayExpose(config: Config, user: UserRow): boolean;
/** 403 forbidden, details { reason: 'share_links_not_approved' }, message t(`spaces.exposure.${what}`). */
export function notApproved(what: 'shareLink' | 'rawLink'): AppError;
// content/grants.ts
export interface ResolvedGrant { grant: ContentGrantRow; version: VersionRow; framedOnly: boolean }
// content/serve.ts
export function contentHeaders(config: Config, status?: number, framedOnly?: boolean): Record<string, string>;
// content/error-page.ts
export type ContentErrorKind = 'not_found' | 'gone' | 'expired' | 'error' | 'framed_only';   // framed_only → 403
// test/moderation/helpers.ts
export function moderationContext(dialect: DbDialect, visibility: Visibility, env?: Record<string, string>): Promise<TestContext>;   // FixedClock(T)
/** The same database and infrastructure under another configuration: a new app over `{ ...deps, config: { ...config, ...patch } }`; `close` stays ctx's. */
export function contextWith(ctx: TestContext, patch: Partial<Config>): TestContext;
// Convention for every M12 test: ctx runs with PINWALL_SHARE_LINKS=members, so spacesFixture(ctx) can make its links
// (A and E are not approved); `ap = contextWith(ctx, { shareLinks: 'approved' })` plays the approved instance.
export async function approve(ctx: TestContext, userId: string, approved?: boolean): Promise<void>;   // writes users.share_approved
```

- [ ] **Step 1: Write the failing tests.**

```ts
// exposure.test.ts — describe.each(dialects) × describe.each(MODES); ctx = moderationContext(d, mode); fx = spacesFixture(ctx); ap = contextWith(ctx, { shareLinks: 'approved' })
test('the loader reads PINWALL_SHARE_LINKS', () => {
  expect(loadConfig({}).shareLinks).toBe('members');
  expect(loadConfig({ PINWALL_SHARE_LINKS: 'approved' }).shareLinks).toBe('approved');
  expect(() => loadConfig({ PINWALL_SHARE_LINKS: 'admins' })).toThrow(/PINWALL_SHARE_LINKS: must be "members" or "approved"/);
});
test('mayExpose lets everyone with members, and admins and approved members with approved', …);
  // members: E true; approved: E false, X true, an owner-kind user true, E after approve true
test('a member who is not approved cannot create a share link, on REST or MCP', …);
  // in ap: E POST /artifacts/<e>/share-links → 403 { code: 'forbidden', message: t('spaces.exposure.shareLink'), details: { reason: 'share_links_not_approved' } }
  // sameAnswer with the same POST on UNKNOWN_IDS.e (the check comes before the lookup)
  // MCP (connected through ap) create_share_link by E → isError, toolText contains t('spaces.exposure.shareLink')
  // in ap: X → 201; approve(E) → 201; in ctx (members) with E unapproved → 201
test('links a person made before still list and can be revoked', …);   // in ap: E GET /artifacts/<e>/share-links lists eLink; DELETE /share-links/<eLink> → 204
test('a link stops opening once its maker is not approved, and opens again after approval', …);   // Review Focus 4
  // in ctx every fixture link opens; in ap:
  // GET /s/<eLink token> → 410 HTML with t('share.gone.title'); GET /api/v1/share/<token> → 410 details { reason: 'revoked' };
  // A's link (A is a member, not approved) answers the same; a link X made opens (200);
  // approve(E) → E's link opens again (nothing was revoked)
test('raw links explain the restriction to a person who is not approved', …);
  // in ap: E cookie, Accept text/html, GET /a/<p>/raw → 403 HTML containing t('spaces.exposure.rawLink');
  //   sameAnswer with /a/<UNKNOWN_IDS.p>/raw (the check comes before the lookup)
  // in ap: E bearer GET /a/<p>/v/1/raw → 403 JSON details { reason: 'share_links_not_approved' }
  // in ap: approve(E) → 302, X → 302; in ctx → 302
// framed-only.test.ts — describe.each(dialects) × describe.each(['single-domain', 'content-domain']), personal; requests through ap
// (content-domain env: PINWALL_ISOLATION=content-domain, PINWALL_CONTENT_ORIGIN=https://pw-content.test:8443)
const dest = (d?: string) => ({ headers: d === undefined ? {} : { 'sec-fetch-dest': d } });
test('a grant of a person who is not approved serves only inside a frame', …);   // Review Focus 5
  // E: GET /artifacts/<p>/versions/2/preview?mode=review → token; via fetchContent:
  //   ('', dest('document')) → 403, body contains t('content.framedOnly.title'); ('', dest()) → 403
  //   ('', dest('iframe')) → 200, CSP contains "frame-ancestors 'self' https://pinwall.test"
  //   ('cover.png', dest('image')) → 200; ('__pinwall/annotator.js', dest('script')) → 200; ('notes.md', dest('empty')) → 200
  //   single-domain: CSP === `${CONTENT_SANDBOX_CSP}; frame-ancestors 'self' https://pinwall.test`
  //   content-domain: CSP === "frame-ancestors 'self' https://pinwall.test"
  //   a 404 path inside the grant ('missing.html', dest('iframe')) also carries the frame-ancestors policy
test('a raw grant from the preview API is framed-only too', …);   // mode=raw: document → 403, iframe → 200
test('approval takes effect on the next content request', …);
  // approve(E) → document 200, no frame-ancestors; approve(E, false) → document 403 again (same grant)
test("an approved person's grants and share-link grants carry no frame-ancestors", …);
  // X preview grant: document 200, CSP without frame-ancestors; X's link with comments: share info content URL, document 200
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/moderation/exposure test/moderation/framed-only`. Expected: FAIL (`shareLinks` unknown, `domain/exposure.ts` missing).
- [ ] **Step 3: Implement.**
  - **`load.ts`:** `shareLinks: r.read('PINWALL_SHARE_LINKS', z.enum(['members', 'approved'], { error: 'must be "members" or "approved"' })) ?? 'members'`.
  - **Catalog:** `PINWALL_SHARE_LINKS` in section `spaces`, after `PINWALL_VISIBILITY`, default `members`. Description: `members: any member may make share links and open raw links, as in Pinwall 1.0. approved: only admins and the members an admin approved in Admin → Users may; everyone else's pages open only inside Pinwall's viewer. Approve people before switching: links made by others stop opening.`
  - **`CONFIG_SETTINGS`:** `setting('spaces', 'PINWALL_SHARE_LINKS', (c) => c.shareLinks)`. Regenerate `docs/configuration.md`.
  - **`createShareLink`:** throw `notApproved('shareLink')` when `!mayExpose(deps.config, actor)`. This is its first check, before the password hash and the lookup.
  - **`assertMakerCurrent`:** the condition becomes `gate.ok && hasAccess(gate.user) && mayExpose(deps.config, gate.user) && (await makerSees(…))`. The miss stays `linkGone('revoked')`. It covers `resolveShare`, `holdCommentLink`, `shareGrant` and the share stream's heartbeat.
  - **`redirectToRaw`:** right after the sign-in check, throw `notApproved('rawLink')` when `!mayExpose(deps.config, auth.user)`. The app's error handler renders it as a page for browsers and as JSON for agents.
  - **`resolveGrant`:** for a member grant, `framedOnly = !mayExpose(deps.config, user)`, using the user row it already reads. A share grant has `framedOnly: false`.
  - **`serve.ts`:**
    - `contentHeaders(config, status, framedOnly)` adds `frame-ancestors 'self' ${config.publicOrigin}`. In single-domain mode it joins the sandbox policy as `${CONTENT_SANDBOX_CSP}; frame-ancestors …`; in content-domain mode it is the whole policy.
    - `serveContent` and `redirectToGrantRoot` pass `resolved.framedOnly` to every reply for the grant.
    - When `framedOnly`, a request whose `sec-fetch-dest` is missing or `document` gets `contentErrorResponse(c, 'framed_only')` (403) before any file lookup.
    - Every grant mode is covered: a raw grant from the preview API would otherwise be the same top-level URL.
  - **en.json:**
    - `"spaces.exposure.shareLink": "You cannot create share links yet: an admin of this Pinwall has to allow it for your account first. Links you already made still list and can be revoked."`
    - `"spaces.exposure.rawLink": "Raw links are not available to your account yet: an admin of this Pinwall has to allow you to share pages outside Pinwall first. You can still review the artifact in Pinwall."`
    - `"content.framedOnly.title": "Open this page in Pinwall"`, `"content.framedOnly.message": "This page can only be viewed inside Pinwall's viewer."`
    - `"web.config.help.PINWALL_SHARE_LINKS": "members: anyone may share, as in Pinwall 1.0. approved: only admins and the people you approve in Users may make share links and raw links."`
  - Add `'spaces PINWALL_SHARE_LINKS'` after `'spaces PINWALL_VISIBILITY'` in `admin-config.test.ts:136`.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @pinwall/server test test/content test/api/share test/spaces test/config test/api/admin-config`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): let only approved people expose content with PINWALL_SHARE_LINKS=approved`.

### Task 2: Usage and quota on every publish path (model: opus)

**Files:**
- Create: `apps/server/src/domain/usage.ts`, `apps/server/src/lib/format.ts`, `apps/server/test/moderation/quota.test.ts`
- Modify:
  - config: `config/types.ts`, `config/load.ts`, `config/catalog.ts`, `api/admin-config.ts`;
  - errors and formatting: `lib/errors.ts`, `mcp/format.ts` (`formatBytes` moves to `lib/format.ts` and is re-exported);
  - domain: `domain/versions.ts` (`checkTarget`, `insertArtifact`, `commitVersion`, `restoreVersion`);
  - shared and docs: `packages/shared/src/i18n/en.json`, `docs/configuration.md`;
  - test helper: `test/moderation/helpers.ts` (`setQuota`).
- Modify (1.0 tests, one line each): `test/api/admin-config.test.ts:136`, `test/mcp/skill.test.ts:20`

**Interfaces:**
- Consumes: 1.0 `lockUser` (`auth/account.ts`), `effectiveRole`, `ingest`'s staging cleanup; M10 `checkTarget(deps, scope, target)`, `insertArtifact`, `lockCurrent`, `scopeForUser`; Task 1 helpers.
- Produces:

```ts
// config/types.ts
Config.quota: { bytes: number; artifacts: number };   // 0 = no limit
// lib/errors.ts
ErrorCode: … | 'quota_exceeded';
// domain/usage.ts
export interface Usage { bytes: number; artifacts: number }
/** null = no limit. */
export interface QuotaLimits { bytes: number | null; artifacts: number | null }
/** personal: Σ versions.total_bytes and count(artifacts) in projects with owner_id = userId; team: versions/artifacts with created_by = userId. */
export async function usageOf(db: Db, config: Config, userId: string): Promise<Usage>;
/** Admins: both null. Otherwise the user's override, else the instance value; 0 means null. */
export function limitsOf(config: Config, user: UserRow): QuotaLimits;
/** Whose space a publish fills, and what it adds. projectId null: the publisher's own default. */
export interface QuotaNeed { projectId: string | null; actor: UserRow; bytes: number; artifacts: number }
/** Without locks: for checkTarget and restore's early check. */
export async function checkQuota(db: Db, config: Config, need: QuotaNeed): Promise<void>;
/** In the commit transaction, after the target is held and before the first insert. Reads the subject's row; only when a
 *  limit applies does it take lockUser(subject) and then read usage, so the default configuration takes no new lock. */
export async function assertQuota(trx: Transaction<Database>, dialect: DbDialect, config: Config, need: QuotaNeed): Promise<void>;
// test/moderation/helpers.ts
export async function setQuota(ctx: TestContext, userId: string, q: { bytes?: number | null; artifacts?: number | null }): Promise<void>;
```

**Whose quota:** in `personal` mode, the owner of `need.projectId`, when that project has an owner. Otherwise, and in `team` mode always, the publisher. Nothing is checked when the subject's `limitsOf` is null for both counts; the usage query is skipped too.

**The check:** artifacts first, then bytes, each as `used + need ≤ limit`.
- Bytes refusal: `new AppError('quota_exceeded', 413, msg, { used_bytes, limit_bytes, needed_bytes, space_owner: { id, name } })`.
- Artifacts refusal: details `{ used_artifacts, limit_artifacts, space_owner }`.
- `msg` is `quota.<bytes|artifacts>.<own|other>`, with sizes from `formatBytes`. `other` names the owner when the subject is not the actor.

**The pre-check needs no bytes yet** (`bytes: 0`), so it refuses exactly when no version could fit.

- [ ] **Step 1: Write the failing tests.**

```ts
// quota.test.ts — describe.each(dialects) × describe.each(MODES)
test('the loader reads the quota settings', () => {
  expect(loadConfig({}).quota).toEqual({ bytes: 0, artifacts: 0 });
  expect(loadConfig({ PINWALL_QUOTA_BYTES: '500MB', PINWALL_QUOTA_ARTIFACTS: '200' }).quota).toEqual({ bytes: 500_000_000, artifacts: 200 });
  expect(() => loadConfig({ PINWALL_QUOTA_ARTIFACTS: '-1' })).toThrow(/PINWALL_QUOTA_ARTIFACTS: must be a whole number/);
});
test('usage counts by project owner in personal mode and by publisher in team mode', …);
  // fixture (p, q by A with 2 versions each; e by E in P): personal usageOf(A) = Σ all five versions, 3 artifacts; usageOf(E) = { 0, 0 }
  // team: usageOf(A) = Σ p and q versions, 2; usageOf(E) = e's bytes, 1
test('limitsOf: admins have none, an override replaces the default, 0 means none', …);
  // env 500MB/200: E → { 500_000_000, 200 }; X → { null, null }; E override bytes 0 → bytes null; E override artifacts 5 → 5
const PATHS = ['upload URL', 'inline', 'web upload', 'restore', 'MCP publish_inline'] as const;
test.each(PATHS)('%s over the bytes quota is refused with quota_exceeded and leaves nothing', …);
  // setQuota(A, { bytes: usageOf(A).bytes + 10 }); A publishes a new version of p (restore: version 1 of p) as the path does
  // → 413 { code: 'quota_exceeded', details: { used_bytes, limit_bytes, needed_bytes, space_owner: { id: A.id, name: 'A' } } }
  //   (MCP: isError, toolText contains t('mcp.hint.quota_exceeded')); p's versions unchanged;
  //   stored blobs equal referencedShas(ctx.deps)
test('a full space refuses a publish session and a web upload before any byte is read', …);
  // setQuota(A, { bytes: 1 }) below usage → POST /publish-sessions → 413, details.needed_bytes 0; web upload → 413, no blob stored
test('the artifacts quota refuses a new artifact but not a new version', …);
  // setQuota(A, { artifacts: current count }) → new artifact in Q: 413 { used_artifacts, limit_artifacts, space_owner }; new version of p: 201
test("an editor's publish counts against the owner's quota and says whose space is full", …);
  // personal: setQuota(A, full) → E's new artifact in P: 413, space_owner A, message t('quota.bytes.other', …) names 'A';
  //   E's publish without a project (E's own default) → 201
  // team: the same publish by E counts toward E → 201
test('two publishes at the edge of the quota at once: exactly one commits', …);   // Review Focus 1
  // setQuota(A, { bytes: usageOf(A).bytes + 1000 }); two upload URLs for new artifacts in P, each a distinct 600-byte page
  //   (personal: one by A, one by E; team: both by A); Promise.all of both POST /upload/<token>
  // → statuses sorted [201, 413]; exactly one new artifact; stored blobs equal referencedShas(ctx.deps)
test('admins are exempt, and a per-person override applies', …);
  // env PINWALL_QUOTA_BYTES=1: X publishes → 201; E → 413; setQuota(E, { bytes: 0 }) → 201
test('a restore counts the restored version in full', …);
  // setQuota(A, { bytes: usage + size(version 1) - 1 }) → restore of version 1 → 413 with needed_bytes = version 1's total_bytes
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/moderation/quota`. Expected: FAIL (`quota` unknown, `domain/usage.ts` missing).
- [ ] **Step 3: Implement the configuration and the error.**
  - **`load.ts`:**
    - `bytes: r.read('PINWALL_QUOTA_BYTES', custom(parseSize).pipe(z.number().min(0))) ?? 0`;
    - `artifacts: r.read('PINWALL_QUOTA_ARTIFACTS', wholeNumber(0)) ?? 0`.
  - **Catalog:** both go in section `limits`, after `PINWALL_MAX_EXPANSION_RATIO`, default `0`.
    - `PINWALL_QUOTA_BYTES`: `The most a person may store, as the total size of their versions, each counted in full. 0 means no limit. In personal mode it counts the projects a person owns, editors' publishes included; in team mode what they published. Admins have no limit, and an admin can set another value for one person.`
    - `PINWALL_QUOTA_ARTIFACTS`: `The most artifacts a person may have, counted like PINWALL_QUOTA_BYTES. 0 means no limit.`
  - **`CONFIG_SETTINGS`:** both entries, as `String(c.quota.bytes)` and `String(c.quota.artifacts)`. Regenerate `docs/configuration.md`.
  - **`ErrorCode`:** gains `'quota_exceeded'`. `skill.test.ts` gets its line.
- [ ] **Step 4: Implement the checks.**
  - **`checkTarget`:** with a viewer scope only, after the 1.0 and M10 checks, `checkQuota(db, config, need)`:
    - new artifact: `{ projectId: target.projectId, actor: scope.user, bytes: 0, artifacts: 1 }`;
    - new version: `{ projectId: artifact.project_id, actor: scope.user, bytes: 0, artifacts: 0 }`.

    This covers session creation, `/upload/:token`, inline publish and web upload, since all of them call `checkTarget` first.
  - **`insertArtifact`** gains a last parameter, `quota: { config: Config; bytes: number }`. After `assertNotArchived` and before its insert, it calls `assertQuota(trx, dialect, quota.config, { projectId: project.id, actor, bytes: quota.bytes, artifacts: 1 })`.
  - **`commitVersion`, new version:** after `lockCurrent`, `assertQuota(…, { projectId: artifact.project_id, actor, bytes: version total, artifacts: 0 })`, where the total is the sum of `input.files[].size`.
  - **`restoreVersion`:**
    - before the transaction, `checkQuota` with `old.total_bytes`, read with the version it already reads;
    - in the transaction, after `getVersionByNumber(trx, …)`, `assertQuota` with the same need.
  - **A refusal in a commit** throws before any version row. `ingest` aborts its stager, so no blob is left; a restore stores no blob.
  - **en.json:**
    - `"quota.bytes.own": "This version needs {{needed}}, but your space already holds {{used}} of its {{limit}}. Delete versions you no longer need, or ask an admin for more room."`
    - `"quota.bytes.other": "This version needs {{needed}}, but the space of {{owner}}, who owns this project, already holds {{used}} of its {{limit}}. Ask them to delete versions they no longer need, or to ask an admin for more room."`
    - `"quota.artifacts.own": "Your space already holds {{used}} of its {{limit}} artifacts. Delete artifacts you no longer need, or ask an admin for more room."`
    - `"quota.artifacts.other": "The space of {{owner}}, who owns this project, already holds {{used}} of its {{limit}} artifacts. Ask them to delete artifacts they no longer need, or to ask an admin for more room."`
    - `"mcp.hint.quota_exceeded": "Do not retry this publish. Tell the person their space is full: they can delete old versions in Pinwall, or ask an admin for more room."`
    - `web.config.help.PINWALL_QUOTA_BYTES` and `web.config.help.PINWALL_QUOTA_ARTIFACTS`, one sentence each.
- [ ] **Step 5: Run** the Step 2 command, then `pnpm --filter @pinwall/server test test/api/publish test/publish test/domain/commit test/mcp test/spaces test/config`, plain and with Postgres. On Postgres the race test must run against real row locks. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): enforce per-person storage and artifact quotas on every publish path`.

### Task 3: Per-person rate rules (model: sonnet)

**Files:**
- Modify:
  - rules: `apps/server/src/auth/rate-limits.ts`, `publish/sessions.ts` (drop `PUBLISH_SESSION_RATE`);
  - REST: `api/publish.ts`, `api/versions.ts` (restore), `api/content.ts` (preview), `api/shares.ts` (create), `api/projects.ts` (create);
  - raw links: `content/raw-links.ts`;
  - MCP: `mcp/tools/publish.ts`, `mcp/tools/review.ts` (`create_share_link`), `mcp/tools/library.ts` (`create_project`);
  - test helper: `test/moderation/helpers.ts` (`exhaustRate`).
- Test: `apps/server/test/moderation/rate-rules.test.ts`

**Interfaces:**
- Consumes: 1.0 `enforceRateLimit`, `rateLimit`, `RateRule`, `authOf`.
- Produces:

```ts
// auth/rate-limits.ts — RATE_RULES gains (M11 adds memberLookup alongside)
publish: { name: 'publish', limit: 60, windowMs: 600_000 },
grant: { name: 'grant', limit: 600, windowMs: 3_600_000 },
shareLinkCreate: { name: 'share-link-create', limit: 30, windowMs: 3_600_000 },
projectCreate: { name: 'project-create', limit: 30, windowMs: 3_600_000 },
/** Route middleware after requireAuth: one attempt of `rule` for the signed-in person (key: user id). */
export function perUser(rule: RateRule): MiddlewareHandler<AppEnv>;
// test/moderation/helpers.ts
export async function exhaustRate(ctx: TestContext, rule: RateRule, key: string, n: number): Promise<void>;   // n × rateLimiter.consume(`${rule.name}:${key}`, …)
```

Where each rule counts:
- **`publish`:**
  - `POST /publish-sessions`, `POST /publish/inline`, `POST /publish/upload` and `POST /artifacts/{id}/versions/{n}/restore`, through `perUser`, before the body is read;
  - MCP `create_publish_session` and `publish_inline`.

  `/upload/:token` is not counted again: its session was.
- **`grant`:** `GET /artifacts/{id}/versions/{n}/preview`, and the raw links (after the sign-in check, before Task 1's exposure check). Share-link grants keep their per-address `SHARE_RATES`.
- **`shareLinkCreate`:** `POST /artifacts/{id}/share-links` and MCP `create_share_link`.
- **`projectCreate`:** `POST /projects` and MCP `create_project`.

The rules apply to admins too.

- [ ] **Step 1: Write the failing tests** (`describe.each(dialects)`, fixture in `team` mode; the rules do not depend on the mode).

```ts
test('publish: 60 per 10 minutes over sessions, inline, web upload and restore together', …);
  // A: 15 sessions, 15 inline, 15 web uploads, 15 restores → all 2xx; one more of each → 429 with Retry-After ≤ 600;
  // MCP publish_inline by A → isError, toolText contains 'rate_limited'; E still publishes (201); clock.advance(600_000) → A 201
test('an upload URL is counted once, when it is made', …);   // 60 sessions; POST /upload/<first token> → 201
test('grant: 600 per hour over preview grants and raw links', …);
  // exhaustRate(ctx, RATE_RULES.grant, A.id, 599); preview → 200; preview → 429; GET /a/<p>/raw (Accept text/html) → 429 HTML page;
  // E's preview → 200
test('shareLinkCreate: 30 per hour, REST and MCP together', …);   // 20 REST + 10 MCP → created; the 31st: REST 429, MCP isError
test('projectCreate: 30 per hour, REST and MCP together', …);
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/moderation/rate-rules`. Expected: FAIL (inline, web upload and restore uncounted; grants unlimited).
- [ ] **Step 3: Implement** `RATE_RULES`, `perUser` and the call sites above. Remove `PUBLISH_SESSION_RATE` and `sessionRateLimit`; `api/publish.ts`'s session route uses `perUser(RATE_RULES.publish)`. Route descriptions that said "Limited to 60 per user per 10 minutes" now say that the limit is shared by every way to publish.
- [ ] **Step 4: Run** the Step 2 command and `VITEST_MAX_WORKERS=2 pnpm --filter @pinwall/server test`. A 1.0 test that publishes more than 60 times as one person within the fixed clock would show up here; none is expected. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add per-person rate rules for publishing, grants, share links and projects`.

### Task 4: Admin users API, purge and `/me/purge` (model: sonnet)

**Files:**
- Create: `apps/server/src/domain/purge.ts`, `apps/server/test/moderation/admin-users.test.ts`, `apps/server/test/moderation/purge.test.ts`
- Modify:
  - domain: `apps/server/src/domain/spaces.ts` (`SystemScope`), `domain/deletion.ts`, `domain/usage.ts` (`usageSummaries`);
  - auth and REST: `auth/admin-users.ts`, `api/admin-users.ts`, `api/me.ts`;
  - shared: `packages/shared/src/api/admin.ts`, `packages/shared/src/i18n/en.json`;
  - the guard: `apps/server/test/spaces/scope-guard.test.ts` (allow-list).

**Interfaces:**
- Consumes: Task 1 `mayExpose`; Task 2 `usageOf`; 1.0 `revokeShareLinksOf`, `endShareLinkStreams`, `requireAdmin`, `requireSession`, `toAdminUser`; M10 `teamDefaultProject`.
- Produces:

```ts
// domain/spaces.ts (SYSTEM_SCOPE's value is unchanged)
export type SystemScope = { readonly kind: 'system' };
export type Scope = ViewerScope | SystemScope;
export const SYSTEM_SCOPE: SystemScope;
// domain/deletion.ts — the 1.0 bodies move into private deleteArtifactAs / deleteVersionAs(deps, scope, …, authorize)
export async function systemDeleteArtifact(deps: AppDeps, scope: SystemScope, artifactId: string): Promise<void>;
export async function systemDeleteVersion(deps: AppDeps, scope: SystemScope, artifactId: string, n: number): Promise<{ artifactDeleted: boolean; currentVersionId: string | null }>;
// domain/usage.ts
export async function usageSummaries(db: Db, config: Config, userIds: readonly string[]): Promise<Map<string, AdminUsage>>;
  // projects: owner_id = user; artifacts, versions, bytes: on usageOf's basis; share_links: active links created_by user;
  // last_published_at: max(versions.created_at) created_by user. One grouped query per measure.
// domain/purge.ts
/** Deletes every project userId owns, each artifact through systemDeleteArtifact. Never deletes the user. */
export async function purgeSpace(deps: AppDeps, scope: SystemScope, userId: string): Promise<{ projects: number; artifacts: number }>;
/** 400 bad_request { field: 'confirm_email' } unless `typed`, trimmed, equals the user's email ignoring case (their id when they have no email). */
export function assertPurgeConfirmed(user: UserRow, typed: string): void;
// auth/admin-users.ts
export async function updateUserModeration(deps: AppDeps, userId: string,
  patch: { shareApproved?: boolean; quotaBytes?: number | null; quotaArtifacts?: number | null }): Promise<{ user: UserRow; shareLinks: number }>;
export function logModeration(deps: AppDeps, adminId: string, action: string, target: Record<string, unknown>): void;
// packages/shared/src/api/admin.ts
AdminUsage = z.object({ projects, artifacts, versions, bytes: int ≥ 0, share_links: int ≥ 0, last_published_at: Timestamp.nullable() });
AdminUser gains (optional in the schema, always sent): usage: AdminUsage, share_approved: boolean, quota_bytes: int ≥ 0 | null, quota_artifacts: int ≥ 0 | null;
UpdateAdminUserRequest = z.object({ share_approved?, quota_bytes?: int ≥ 0 ≤ MAX_SAFE | null, quota_artifacts?: int ≥ 0 | null }) // at least one key
PurgeRequest = z.object({ confirm_email: z.string().min(1).max(320) });
PurgeResult = z.object({ projects: int ≥ 0, artifacts: int ≥ 0 });
```

Routes, admin ones behind `requireAdmin`, each logging with `logModeration`:
- **`GET /admin/users`:** each item carries the additions; one `usageSummaries` call per page.
- **`PATCH /admin/users/{id}`** with `UpdateAdminUserRequest` returns `AdminUser`.
  - Unknown id: 404 `auth.userNotFound`. An empty body: 400.
  - It runs in one transaction. When `share_approved` goes from 1 to 0, `config.shareLinks === 'approved'` and the user is not an admin, `revokeShareLinksOf` runs first; the user row is updated after it.
  - After commit, `endShareLinkStreams` runs for each revoked link.
- **`POST /admin/users/{id}/purge`** with `PurgeRequest` returns `PurgeResult`.
  - In `team` mode it answers 404 `{ code: 'not_found', message: t('error.notFound.message') }`, the body of an unknown route.
  - It calls `assertPurgeConfirmed`, then `purgeSpace(deps, SYSTEM_SCOPE, id)`.
- **`POST /me/purge`:** `requireAuth, requireSession`, the same body and result, the same `team`-mode 404, and the signed-in person's own id. It logs `{ user_id, action: 'self.purge' }`.

`purgeSpace`, per owned project in id order:
1. Run `systemDeleteArtifact` on each artifact. An artifact already gone (404 or 410) is skipped.
2. `delete from projects where id = ? and owner_id = ? and not exists (select 1 from artifacts where project_id = projects.id)`.

When step 2 deletes nothing because a publish slipped in, step 1 runs again, at most 3 passes. After that it answers `conflict(t('purge.busy'))`.

- [ ] **Step 1: Write the failing tests.**

```ts
// admin-users.test.ts — describe.each(dialects) × describe.each(MODES)
test('the user list carries usage, approval and quota overrides in both modes', …);
  // X GET /admin/users → A: usage { projects ≥ 2, artifacts, versions, bytes, share_links: 2, last_published_at: T }
  //   (personal: artifacts 3 incl. e; team: 2), share_approved false, quota_bytes null, quota_artifacts null;
  // Object.keys(item).sort() equals Object.keys(AdminUser.shape).sort()
test('PATCH sets approval and quota overrides and logs the change', …);
  // { share_approved: true, quota_bytes: 1000, quota_artifacts: null } → 200 with those values;
  // logger.info called with { admin_id: X.id, action: 'user.update', target: { user_id: E.id } }, 'moderation'
test('PATCH refuses an empty body, a negative or fractional quota, and members', …);   // 400, 400, 403 auth.adminOnly
test("removing approval revokes the person's links when links need approval", …);
  // in ap: approve(E); E's link opens; PATCH { share_approved: false } → /s/<eLink> 410 page, share_links.revoked_at set;
  // in ctx (members): the same PATCH revokes nothing (eLink still opens)
// purge.test.ts — describe.each(dialects)
test("admin purge deletes the person's projects and artifacts; links answer gone; the user stays", …);
  // personal: X POST /admin/users/<A>/purge { confirm_email: A.email.toUpperCase() } → 200 { projects: <A's owned count before>, artifacts: 3 };
  // GET /s/<pLink> → 410 page t('share.gone.title'); E's GET /artifacts/<e> → 404; stored blobs equal referencedShas;
  // users row of A exists; logger.info { admin_id: X.id, action: 'user.purge', target: { user_id: A.id } }
test("purge leaves other people's projects alone, even ones the person edits", …);   // purge E: P and e stay
test('purge needs the email typed exactly', …);   // 'nope' → 400 details.field 'confirm_email'; owner-kind user: its id confirms
test('purge is personal-only: 404 in team mode, as an unknown route', …);   // admin and /me routes; body equals GET /api/v1/nowhere's
test('a person deletes all of their own content with /me/purge, by session only', …);
  // A cookie → 200; A bearer → 403 t('auth.sessionRequired'); afterwards A's GET /projects lists only a new default
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/moderation/admin-users test/moderation/purge test/spaces/scope-guard`. Expected: FAIL.
- [ ] **Step 3: Implement** the names and routes above.
  - `SYSTEM_SCOPE_ALLOWED` gains `'api/admin-users.ts'` (admin purge of one person's projects) and `'api/me.ts'` (a person's purge of the projects they own), each with a comment giving the reason.
  - en.json:
    - `"purge.confirm": "To confirm, type the account's email address exactly (its id, when it has no email)."`
    - `"purge.busy": "New artifacts kept arriving while this space was being deleted. Try again."`
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/api/admin-users test/api/me test/domain test/spaces`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add admin usage, approval, quota overrides and space purge`.

### Task 5: `pinwall transfer` (model: opus)

**Files:**
- Create: `apps/server/src/domain/transfer.ts`, `apps/server/test/moderation/transfer.test.ts`, `apps/server/test/moderation/transfer-cli.test.ts`
- Modify: `apps/server/src/main.ts`, `packages/shared/src/i18n/en.json`

**Interfaces:**
- Consumes: M10 `defaultProjectFor`, `roleIn`, `scopeForUser`, `addMember`, `spacesFixture`; 1.0 `addTombstones`, `createDeps`, `closeDeps`; Task 2 `usageOf`.
- Produces:

```ts
// domain/transfer.ts
export interface TransferResult {
  projects: number; artifacts: number; shareLinks: number; membershipsDropped: number;
  /** The new name of the source's default project, when the target already had one. */
  renamedDefault: string | null;
  grantsEnded: number;
}
/** `usr_…` by id; a ref with '@' by email ignoring case; anything else, 0 or >1 matches refused with AppError. */
export async function findUserByRef(db: Db, ref: string): Promise<UserRow>;
  // 0 → notFound(t('transfer.noUser', { ref })); >1 → conflict(t('transfer.ambiguous', { ref, count, ids }), { user_ids }); neither form → badRequest(t('transfer.badRef', { ref }))
export async function transferContent(deps: AppDeps, from: UserRow, to: UserRow): Promise<TransferResult>;
// main.ts
Command: … | { name: 'transfer'; from: string; to: string };
```

`transferContent` runs one transaction, in this order (the unique index `projects_owner_default_idx` needs the rename before the move):
1. `from.id === to.id` → `badRequest(t('transfer.same'))`.
2. Read the source's projects (`owner_id = from.id`, `for update` on Postgres, ordered by id).
3. If one of them has `is_default = 1` and the target owns a default, set that project's `name = t('transfer.defaultName', { name: from.name ?? from.email ?? from.id })` and `is_default = 0`.
4. Delete `project_members` rows with `user_id = to.id` and `project_id` among the moved projects.
5. Set `share_links.created_by = to.id` where `created_by = from.id` and the link's artifact is in a moved project.
6. In `personal` mode only: tombstone, then delete, `content_grants` with `user_id = from.id` whose version belongs to a moved artifact. Do this as `revokeUserGrants` does, but limited to those versions.
7. Set `projects.owner_id = to.id` and `updated_at = now` for the moved ids.

After commit it logs `{ action: 'transfer', from_id, to_id, …counts }` at `info`. Quotas are not checked: the operator moves the space. Streams end at their next heartbeat, upload URLs are refused at commit, and Recent filters by sight; all three are M10's re-checks, which a CLI process can rely on.

CLI:
- `pinwall transfer --from <id|email> --to <id|email>`. `--from` and `--to` belong to `transfer` only; each missing value exits 2 with `transfer needs --from <id|email> and --to <id|email>`.
- It runs `createDeps(config, { logger })`, `findUserByRef` for both refs, then `transferContent`.
- It prints `t('transfer.done', …)`, plus `t('transfer.renamed', …)` when a default was renamed, then runs `closeDeps`.
- An `AppError` prints `t('transfer.failed', { message })` on stderr and exits 1.
- Usage line: `transfer --from <user> --to <user>  Move every project of one user to another (id or email)`.

- [ ] **Step 1: Write the failing tests.**

```ts
// transfer.test.ts — describe.each(dialects) × describe.each(MODES); fixture; B is V unless stated
test('transfer moves every project of A to B, and B sees all of it', …);
  // result.projects = A's project count, artifacts 3; P and Q owner V;
  // personal: usageOf(V) after = usageOf(A) + usageOf(V) before, usageOf(A) after = { 0, 0 }; V GET /artifacts lists p, q, e; A lists none of them
  // team: usage unchanged (counted by publisher); both list all
test("links A made keep opening and now belong to B; others' links stay", …);
  // pLink, qLink created_by V; eLink created_by E; GET /api/v1/share/<each token> → 200 in both modes
test("members stay; B's own membership in a moved project is dropped", …);
  // E is still editor of P; no project_members row (P, V); personal roleIn(scope of V, P) = 'owner'; membershipsDropped 1
test('when both have a default project, A\'s becomes "Default (from A)"', …);
  // personal: defaultProjectFor for A and V first; after: A's old default is_default 0, name 'Default (from A)', owner V;
  // V's default unchanged; V owns exactly one is_default = 1 project; result.renamedDefault 'Default (from A)'
test("a target without a default takes A's as its own", …);   // fresh person N: A's default stays is_default 1, owner N
test("A's grants on moved artifacts end in personal mode only", …);   // A's review grant on p → personal 410, team 200
test('A loses sight while the artifact is open: stream, grant and Recent', …);   // Review Focus 2 (idor-sse.test.ts pattern)
  // A opens a member stream on p and a preview grant, and views p; transferContent(A → V); heartbeat
  // → personal: stream closed, grant 410, A's GET /artifacts/recent lacks p; team: stream open, grant 200, p listed
test('an upload URL A made before the transfer is refused at commit', …);   // personal: 404 and nothing written; team: 201
test('transfer to oneself is refused and changes nothing', …);
test('findUserByRef finds by id and by email ignoring case, and refuses unknown, malformed and shared emails', …);
// transfer-cli.test.ts — spawns src/main.ts as visibility-cli.test.ts does (own copy of its small spawn helper)
test('transfer moves the projects and prints what it did', …);   // exit 0; stdout contains t('transfer.done', …); owners changed in the DB
test('an email shared by two accounts is refused with both ids, and nothing moves', …);   // Review Focus 3
  // owner-kind and oidc users both with email 'dn@example.test'; transfer --from <third> --to DN@example.test
  // → exit 1; stderr contains both ids; every owner_id unchanged
test('transfer needs --from and --to, and they belong to it', …);
  // ['transfer'] → 2; ['transfer', '--from', 'x'] → 2; ['serve', '--from', 'x'] → 2, '--from belongs to the transfer command'
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/moderation/transfer test/moderation/transfer-cli`. Expected: FAIL (`domain/transfer.ts` missing).
- [ ] **Step 3: Implement** as above. en.json:
  - `"transfer.defaultName": "Default (from {{name}})"`
  - `"transfer.same": "The source and the target are the same user."`
  - `"transfer.noUser": "No user matches {{ref}}."`
  - `"transfer.badRef": "{{ref}} is neither a user id (usr_…) nor an email address."`
  - `"transfer.ambiguous": "{{ref}} matches {{count}} users: {{ids}}. Name one of them by its id. Nothing was moved."`
  - `"transfer.done": "Moved {{projects}} projects with {{artifacts}} artifacts from {{from}} to {{to}}. Share links handed over: {{links}}. Memberships dropped: {{memberships}}."`
  - `"transfer.renamed": "The default project of {{from}} is now named \"{{name}}\"."`
  - `"transfer.failed": "Transfer failed: {{message}}"`
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/spaces test/cli`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add pinwall transfer to move a person's projects to another user`.

### Task 6: Admin share links, look-up and takedown (model: sonnet)

**Files:**
- Create: `apps/server/src/domain/moderation.ts`, `apps/server/src/api/admin-moderation.ts`, `apps/server/test/moderation/admin-moderation.test.ts`
- Modify:
  - server: `apps/server/src/domain/shares.ts` (`systemRevokeShareLink`), `api/router.ts`;
  - shared: `packages/shared/src/api/admin.ts`, `packages/shared/src/i18n/en.json`;
  - the guard: `apps/server/test/spaces/scope-guard.test.ts`.

**Interfaces:**
- Consumes: Task 4 `SystemScope`, `systemDeleteArtifact`, `systemDeleteVersion`, `logModeration`; 1.0 `hashSecret`, `isContentToken`, `isTombstoned`, `holdArtifact`, `addTombstones`, `endShareLinkStreams`, `decodeCursor`, `encodeCursor`, `page`.
- Produces:

```ts
// packages/shared/src/api/admin.ts
AdminPerson = z.object({ id: z.string(), name: z.string(), email: z.string().nullable() });   // name: name ?? email ?? ''
AdminShareLink = z.object({ id, artifact: { id, name }, owner: AdminPerson.nullable(), created_by: AdminPerson.nullable(),
  version: z.object({ id, number }).nullable(),   // null: follows the current version
  has_password, allow_comments, created_at, expires_at: Timestamp.nullable(), last_used_at: Timestamp.nullable() });
AdminShareLinkList = page(AdminShareLink);
LookupRequest = z.object({ url: z.string().min(1).max(4096) });
AdminLookup = z.object({
  kind: z.enum(['share_link', 'content_grant', 'artifact']),
  artifact: z.object({ id, name, project: z.object({ id, name }), owner: AdminPerson.nullable() }),
  version: z.object({ id, number, published_by: AdminPerson.nullable() }),   // the link's, the grant's, /v/<n>'s, else the current one
  share_link: AdminShareLink.nullable(),   // the link, or the link a content grant was made from
  grant: z.object({ mode: z.enum(['review', 'raw']), expires_at: Timestamp, holder: AdminPerson.nullable() }).nullable() });
EndGrantsResult = z.object({ grants: z.number().int().nonnegative() });
// domain/moderation.ts — every function takes the SystemScope, so its callers sit on the scope guard's list
export async function listActiveShareLinks(deps: AppDeps, scope: SystemScope, p: { limit: number; cursor: string | null }): Promise<{ items: AdminShareLink[]; nextCursor: string | null }>;
export type ReportedUrl = { kind: 'share'; token: string } | { kind: 'artifact'; id: string; n: number | null } | { kind: 'grant'; token: string };
/** null when the URL is not one this Pinwall hands out. */
export function parseReportedUrl(config: Config, url: string): ReportedUrl | null;
/** 400 when it is no URL, 404 when it names nothing here, 410 when what it names was tombstoned. */
export async function lookupReportedUrl(deps: AppDeps, scope: SystemScope, url: string): Promise<AdminLookup>;
/** Deletes and tombstones every content grant of the version (member and share grants); the artifact is held first. Unknown version: 404. */
export async function endVersionGrants(deps: AppDeps, scope: SystemScope, versionId: string): Promise<number>;
// domain/shares.ts — revokeShareLink's transaction with SYSTEM_SCOPE and no canRevoke; unknown id 404, a revoked link unchanged
export async function systemRevokeShareLink(deps: AppDeps, scope: SystemScope, linkId: string): Promise<void>;
```

`parseReportedUrl` recognizes:
- **On the public origin** (scheme, host and port equal after `new URL`):
  - `/s/<43-char token>` with an optional `/original` or trailing `/` → `share`;
  - `/a/<id>`, with an optional `/v/<n>`, then an optional `/raw`, `/compare` or trailing `/` → `artifact`;
  - in single-domain mode, `/c/<content token>` followed by anything → `grant`.
- **In content-domain mode,** a host `<content token>.<content host>` with the content origin's scheme and port → `grant`.

Query strings and fragments are ignored. Anything else, including another site's URL, returns `null`.

Routes, all `requireAdmin` and each logging with `logModeration`:
- `GET /admin/share-links` (`limit` 1–200, default 50; `cursor`): active links only, that is, not revoked and not expired. Newest first, cursor `{ c, i }`.
- `DELETE /admin/share-links/{id}` → 204.
- `POST /admin/lookup` → 200 `AdminLookup`. The log line names only the kind and the artifact id.
- `DELETE /admin/artifacts/{id}` → 204.
- `DELETE /admin/artifacts/{id}/versions/{n}` → 204.
- `POST /admin/versions/{id}/end-grants` → 200 `EndGrantsResult`.

`api/admin-moderation.ts` joins `SYSTEM_SCOPE_ALLOWED` with the reason "admin moderation: metadata, revoke and delete by id, never content". It runs no direct content-table query.

- [ ] **Step 1: Write the failing tests** (`describe.each(dialects)` × `describe.each(MODES)`, the fixture, X as admin).

```ts
test('the share-link list shows every active link, with metadata only', …);
  // X GET /admin/share-links → ids include pLink, qLink, eLink; a revoked link and one expired at T are absent;
  // each item's keys equal AdminShareLink.shape's; the JSON contains no 'token', 'url' or 'token_hash' key; limit=2 pages with next_cursor
test('an admin revokes a link: it answers gone and its grants end', …);
  // a guest share grant on pLink serves; DELETE /admin/share-links/<pLink> → 204; /s/<token> 410 page; the grant → 410
// Urls: a test-local record of the public origin, p's id, pLink's token, a member grant of A on version 1 and fetchContent's URL form
const LOOKUPS: [string, (u: Urls) => string, AdminLookup['kind'], number][] = [
  ['a share URL', (u) => `${u.origin}/s/${u.pToken}`, 'share_link', 2],
  ['its Open original URL', (u) => `${u.origin}/s/${u.pToken}/original?x=1`, 'share_link', 2],
  ['an artifact link', (u) => `${u.origin}/a/${u.p}`, 'artifact', 2],
  ['a version raw link', (u) => `${u.origin}/a/${u.p}/v/1/raw`, 'artifact', 1],
  ['a content URL', (u) => u.contentUrl(u.aGrantOnV1, 'index.html') + '#top', 'content_grant', 1],
];   // the last also in a content-domain context (fetchContent's host form)
test.each(LOOKUPS)('look-up of %s names the artifact, its owner and the version', …);
  // artifact { id: p, project: { id: P, name: 'P' }, owner: { id: A.id, name: 'A', email: A.email } }; version.number as given;
  // a share-link grant's look-up has share_link.id = pLink and grant.holder null; a member grant's holder is A
test('look-up answers 404 for another site and unknown tokens, 410 for what was taken down, 400 for no URL', …);
  // 'https://evil.example/s/<token>' → 404; an unknown share token → 404; /a/<id> of an artifact deleted earlier → 410; 'not a url' → 400
test('takedown reaches any space and is logged', …);
  // personal: X does not see q, yet DELETE /admin/artifacts/<q> → 204, then A's GET /artifacts/<q> → 410;
  // DELETE /admin/artifacts/<p>/versions/1 → 204; POST /admin/versions/<pV2>/end-grants → { grants: ≥1 }, A's grant on pV2 → 410;
  // logger.info called with { admin_id: X.id, action: 'artifact.delete', target: { artifact_id: q } }, 'moderation'
test('members get 403 on every admin route', …);   // E on each route → 403 t('auth.adminOnly')
test('no admin route moves a space', …);
  // every OpenAPI path under /admin: none names transfer or owner; UpdateAdminUserRequest has no owner field
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/moderation/admin-moderation test/spaces/scope-guard`. Expected: FAIL (routes missing).
- [ ] **Step 3: Implement** as above. en.json:
  - `"moderation.lookup.badUrl": "Paste the whole address, starting with http:// or https://."`
  - `"moderation.lookup.unknown": "This address does not belong to anything on this Pinwall."`
  - `"moderation.lookup.gone": "What this address pointed to has already been removed."`
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/api test/content test/spaces`, plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add the admin share-link list, look-up of reported links, and takedown`.

### Task 7: `/me`, `whoami`, public config and D8 (model: sonnet)

**Files:**
- Modify:
  - config: `apps/server/src/config/types.ts`, `config/load.ts`, `config/catalog.ts`, `api/admin-config.ts`;
  - identity and public config: `api/config.ts`, `auth/users.ts` (`toMe`), `domain/usage.ts` (`quotaApplies`), `mcp/tools/identity.ts`, `mcp/schemas.ts` (`WhoamiOut`);
  - pages: `pages/error-page.tsx`, `http/errors.ts`, `content/share-route.ts`, `content/error-page.ts`, `content/serve.ts`;
  - shared and docs: `packages/shared/src/api/config.ts`, `packages/shared/src/api/auth.ts`, `packages/shared/src/i18n/en.json`, `docs/configuration.md`.
- Modify (1.0 test, three lines): `test/api/admin-config.test.ts:136`
- Test: `apps/server/test/moderation/me.test.ts`, `apps/server/test/moderation/abuse-contact.test.ts`

**Interfaces:**
- Consumes: Task 1 `mayExpose`; Task 2 `usageOf`, `limitsOf`, `formatBytes`.
- Produces:

```ts
// config/types.ts
Config.abuseContact: string | null; Config.termsUrl: string | null; Config.privacyUrl: string | null;
// domain/usage.ts
/** personal mode, a non-zero instance quota, or an override on the user. */
export function quotaApplies(config: Config, user: UserRow): boolean;
// packages/shared
PublicConfig.share_links?: 'members' | 'approved';   // sent only when 'approved'
PublicConfig.abuse_contact?: string; PublicConfig.terms_url?: string; PublicConfig.privacy_url?: string;   // only when set
Me.can_create_share_links?: boolean;   // only with 'approved': mayExpose
Me.usage?: { bytes: number; artifacts: number }; Me.limits?: { bytes: number | null; artifacts: number | null };   // when quotaApplies
// mcp/schemas.ts — WhoamiOut gains (1.0's `limits` keeps the publishing limits)
visibility?: 'personal'; usage?: { bytes, artifacts }; quota?: { bytes: number | null; artifacts: number | null }; can_create_share_links?: boolean;
// pages
ErrorPageProps.abuseContact?: string | null;
export function abuseHref(contact: string): string;   // 'mailto:' + contact for an email; the URL itself otherwise
renderContentErrorPage(kind: ContentErrorKind, abuseContact?: string | null): string;
```

The abuse line is `<p class="pw-meta">{t('pages.reportAbuse')} <a href={abuseHref(c)}>{c}</a></p>`. It appears only when the contact is set, and only on:
- app pages with status 404 or 410 (`respond` in `http/errors.ts` and `linkErrorPage`);
- the content pages `not_found`, `gone` and `expired`.

Without the setting, every page is byte-for-byte 1.0.

- [ ] **Step 1: Write the failing tests.**

```ts
// me.test.ts — describe.each(dialects)
test('the loader reads the D8 settings', …);
  // PINWALL_ABUSE_CONTACT 'abuse@example.org' and 'https://example.org/report' accepted; 'call us' → /PINWALL_ABUSE_CONTACT: must be an email address or an http\(s\) URL/;
  // PINWALL_TERMS_URL 'ftp://x' → /PINWALL_TERMS_URL: must be an http\(s\) URL/; all three default to null
test('public config names the share policy and the D8 links only when they are set', …);
  // default: none of share_links, abuse_contact, terms_url, privacy_url; set (approved + all three): their values
test('/me tells whether the person may create share links, only when links need approval', …);
  // ctx (members): no key; ap = contextWith(ctx, { shareLinks: 'approved' }): E false, X true, E after approve true
test('/me shows usage and limits in personal mode or when a quota applies', …);
  // team default: no usage or limits key; personal: usage { bytes, artifacts } = usageOf, limits { null, null };
  // team with PINWALL_QUOTA_BYTES=500MB: limits.bytes 500_000_000; X: limits { null, null }; team default with an override on E: E has both keys
test('whoami adds the mode, usage, quota and link permission under the same rules', …);
  // team default: structuredContent equals the 1.0 whoami exactly; personal + approved: visibility 'personal', usage, quota, can_create_share_links false,
  // and the text has t('mcp.whoami.space', …) and t('mcp.whoami.noShareLinks') lines
// abuse-contact.test.ts — describe.each(dialects)
test('gone and not-found pages show the abuse contact when it is set', …);
  // PINWALL_ABUSE_CONTACT=abuse@example.org: GET /nowhere (Accept text/html) 404 page contains 'href="mailto:abuse@example.org"';
  // a revoked link's /s/<token> 410 page contains it; an unknown content token's page contains it;
  // a URL contact links to the URL itself; without the setting no page contains t('pages.reportAbuse')
test('other error pages never show it', …);   // a 403 page (cross-site POST, Accept text/html) and the framed_only content page lack it
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/moderation/me test/moderation/abuse-contact`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`load.ts`:**
    - `abuseContact`: an email (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) or an `http:`/`https:` URL; otherwise `must be an email address or an http(s) URL`.
    - `termsUrl` and `privacyUrl`: an `http:`/`https:` URL; otherwise `must be an http(s) URL`.
  - **Catalog:** section `spaces`, after `PINWALL_SHARE_LINKS`, default `null` with `defaultNote: 'none'`.
    - `PINWALL_ABUSE_CONTACT`: `An email address or an http(s) URL where people report abuse. When set, it is shown on share pages, on the pages for links that are gone or not found, and on the sign-in page.`
    - `PINWALL_TERMS_URL`: `An http(s) URL of your terms of use, linked from the sign-in page when set.`
    - `PINWALL_PRIVACY_URL`: `An http(s) URL of your privacy notice, linked from the sign-in page when set.`
  - **`CONFIG_SETTINGS`:** three entries. Regenerate `docs/configuration.md`. Add the three lines to `admin-config.test.ts:136` after `'spaces PINWALL_SHARE_LINKS'`.
  - **`toMe`, `whoami` and `api/config.ts`:** add the fields by the rules above.
    - The `whoami` text adds `t('mcp.whoami.space', { bytes, bytesLimit, artifacts, artifactsLimit })` when it sends `usage`. A null limit reads as `t('mcp.whoami.noLimit')`.
    - It adds `t('mcp.whoami.noShareLinks')` when `can_create_share_links` is false.
  - **en.json:**
    - `"pages.reportAbuse": "Report abuse:"`
    - `"mcp.whoami.space": "Your space: {{bytes}} of {{bytesLimit}}, {{artifacts}} of {{artifactsLimit}} artifacts."`
    - `"mcp.whoami.noLimit": "no limit"`
    - `"mcp.whoami.noShareLinks": "You cannot create share links yet: an admin of this Pinwall has to allow it first."`
    - the three `web.config.help.*` lines.
- [ ] **Step 4: Run** the Step 2 command and `pnpm --filter @pinwall/server test test/api/me test/api/config test/mcp test/http test/content test/config test/api/admin-config`, then `pnpm --filter @pinwall/web test` (the shared DTOs changed), plain and with Postgres. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): show usage, limits and link permission, and add the abuse contact and policy links`.

---

## M12 done when

- `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=2 pnpm test` pass. `pnpm test:integration` passes too, so `test/moderation/*` runs on SQLite and Postgres, in both modes where the mode matters.
- Spec acceptance items 3 (approval: Task 1, Task 4), 4 (quotas: Task 2) and 5 (admin tools: Tasks 4, 5, 6) are automated and pass. Review Focus 1–5 above (roadmap Review Focus 2 for transfer, 3, and 5 for the CLI) pass.
- `git diff 4264c0b -- apps/server/test ':!apps/server/test/moderation' ':!apps/server/test/spaces'` lists only `test/api/admin-config.test.ts` and `test/mcp/skill.test.ts`, with only the lines "The 1.0 suite" allows. `apps/web` is unchanged.
- `scope-guard.test.ts` passes with the three new `SYSTEM_SCOPE` entries and no new `DIRECT_QUERIES_ALLOWED` entry.
