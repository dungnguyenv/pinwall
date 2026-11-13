# Pinwall M13 — Web: Spaces, Members, Usage, Exposure States, Admin Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The React SPA for personal spaces. In `personal` mode a person sees their own space and the projects shared with them, the controls their project role allows, a Members panel, their usage with self-service deletion, why sharing is not yet allowed, and the operator's abuse contact and policy links. Admins get usage, approval, quota overrides and purge on Users, plus two new pages: Share links and Look up a link. In `team` mode every screen except the admin additions looks and behaves exactly like 1.0.

**Architecture:**
- **One rights module.** `api/spaces.ts` turns the mode (`PublicConfig.visibility`), the project's `role` and the artifact's `can_manage` into a `Rights` value. Every control that changes content asks it. The `team` branch reuses the 1.0 helpers (`canDelete`, `canRevoke`, `memberPermissions`), so team mode runs the 1.0 rules. In `personal` mode, controls stay hidden until the role is known.
- **The shell knows the mode before it renders.** `RequireAuth` waits for `/config/public` as well as `/me`. Inside the shell `useVisibility()` is then synchronous: `'personal'`, or `'team'` when the field is absent.
- **The server decides.** The SPA hides what a role forbids and shows every refusal in the server's own words. The two reasons with their own screens (`share_links_not_approved`, `role`) switch the screen to its explained state.
- **New screens follow the 1.0 patterns.** The Members dialog is built like the share dialog, Settings → Usage like Settings → Profile, and the admin pages like Users: a table on wide screens and cards below, with skeleton, empty and error states.
- **End-to-end.** The Keycloak suite gains a second Pinwall in `personal` mode with open sign-up and `PINWALL_SHARE_LINKS=approved`. Spec acceptance 2, 3 and 9 are walked through the web with Keycloak's ada (admin), bob and eve.

**Tech Stack:** unchanged from the 1.0 web milestones: React 19, Vite, Tailwind CSS v4, Radix UI, TanStack Query, React Router, react-i18next, lucide-react. Tests use Vitest, Testing Library and msw, and end to end Playwright with `@axe-core/playwright` and the Keycloak test IdP in Docker. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-pinwall-personal-spaces-design.md`: §4.3 (role table), §6, §7, §9, §10 "What people see", §11 acceptance 2, 3 and 9, and §12 D8. It sits on `docs/superpowers/specs/2026-11-10-pinwall-design.md` §4 (look and feel).

**Roadmaps:** `docs/superpowers/plans/2026-11-13-pinwall-v1.1-roadmap.md` (M13 scope, done-when, Routes, DTOs) and `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md` (Global Constraints). The names consumed come from the code on `m12-moderation` (M10, M11 and M12 Tasks 1–4 and 7 merged) and from the "Interface handed to …" sections of the M10, M11 and M12 plans. M12 Task 6's routes and DTOs come from that plan's Task 6.

**Depends on:** M10, M11 and M12 merged, including M12 Task 6. If a task starts before Task 6's DTOs are in `@pinwall/shared`, it defines `AdminPerson`, `AdminShareLink`, `AdminShareLinkList`, `AdminLookup` and `EndGrantsResult` in `apps/web/src/api/dto.ts`, under those names and with the shapes in M12 Task 6 "Produces", as the header of `dto.ts` prescribes. The merge then turns them into re-exports.

**Out of scope:**
- server code: none changes (see "Carried items");
- docs, the CHANGELOG, MCP and skill wording (M14);
- any way to move content between spaces (spec §7: transfer is CLI-only).

## Global Constraints

The Global Constraints of both roadmaps, M7a, M7b, M8a and M8b apply. Put them in each implementer brief: the design tokens, list states, accessibility, strings, untrusted text and frames. For M13:
- **Absent means 1.0.** New fields come only in `personal` mode, or when their setting is not at its default:
  - no `PublicConfig.visibility` → `team`;
  - no `PublicConfig.share_links` → `members`;
  - no `Project.role` or `Project.owner`, and no `ArtifactSummary.can_manage` → the 1.0 rules (`me.role === 'admin' || created_by === me.id`);
  - no `Me.can_create_share_links` → may share;
  - no `Me.usage` → no Usage page.
- **Team mode is 1.0.** Every 1.0 web test passes unchanged. The only edits allowed in 1.0 test files:
  - `src/test/admin.ts`: `fxAdminUser` defaults gain `usage`, `share_approved: false`, `quota_bytes: null` and `quota_artifacts: null`, which M12 asks for. `serveAdminUsers` gains the PATCH and purge handlers.
  - `src/pages/admin/users.test.tsx`: the numbers in "the table needs 1100 px…" change, but only if `TABLE_QUERY` moves.
  - `e2e/web-shell.spec.ts`: its axe list gains `/admin/share-links` and `/admin/lookup`.
  - `e2e/keycloak/sign-in.spec.ts`: it imports its helpers from `e2e/keycloak/support.ts`, with no assertion changed.

  A 1.0 test that seems to need anything else is reported, not edited.
- **Default project.** `apps/web/src` never names `prj_00000000000000000000`; Task 2 adds a test that greps for it. Uploads from All artifacts send no `project_id`. Their label names `ownDefaultProject(projects)`: `is_default` and role `owner` or absent.
- **Untrusted text** renders as React text, never through `dangerouslySetInnerHTML`. That covers names, emails, artifact and project names, reported URLs, and the abuse contact.
- **Links from configuration** (`abuse_contact`, `terms_url`, `privacy_url`) become `href` only as `mailto:`, `http:` or `https:`, checked in the browser as well. Anything else shows as text.
- **Admin pages show metadata only.** No link to `/a/…`, `/s/…`, `/c/…` or a raw URL appears on an admin page. No control moves content between people.
- **Destructive actions confirm.** Purges need the account's email typed (its id when it has no email). Confirm is enabled only when the typed text, trimmed, matches ignoring case. The server still judges what was sent.
- **i18n.** Every new string goes through `t()`. New `web.` keys sit in one block after `web.shortcuts.frameNote`, the last `web.` key, ordered by task. Where the server already states a message, the SPA reuses its key verbatim: `spaces.exposure.shareLink`, `spaces.exposure.rawLink`, `spaces.role.createShareLink`, `pages.reportAbuse`, `share.gone.title`, `artifact.notFound`. Plurals use `_one` and `_other`.
- **Tests.** Component tests go through `renderRoute` with msw, and personal mode is `renderRoute(path, { config: { visibility: 'personal' } })`. Full runs use `VITEST_MAX_WORKERS=2`, and at most 2 implementers run at once. Each UI task starts by loading the `frontend-design:frontend-design` skill.
- Conventional Commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; commit on the M13 branch, never push.

## Review Focus

1. **The role is still loading in `personal` mode.** A viewer must never see Upload, Restore, Delete or Revoke flash in before the project answers. Team mode must not wait at all.
   → Task 1 `nothing that changes content shows until the role is known`; Task 2 `project controls stay hidden while the role loads`.
2. **Another person's default project shared with me** (`is_default: true`, `role: 'editor'`). Expected: uploads from All artifacts go to my own default, the dialog names mine, and the shared one is listed under Shared with me.
   → Task 2 `All artifacts uploads into the person's own default project, never a shared one`.
3. **One email, several accounts** (roadmap Review Focus 5, member part). Expected: the dialog lists the accounts by name and sign-in method, sends nothing until one is picked, then adds only that one.
   → Task 3 `several accounts share the email: the owner picks one and only that one is added`.
4. **Approval removed while the share dialog is open.** `me` is stale. Expected: the refusal switches the dialog to its not-approved state and refreshes `me`, with no raw error.
   → Task 4 `approval taken away while the dialog is open switches it to the explanation`.
5. **Typed confirmation.** The typed text may differ in case or carry spaces, and the owner account may have no email. Expected: the label says what to type, Confirm follows the trimmed, case-insensitive match, and the server's 400 shows verbatim.
   → Task 5 `an account without an email confirms with its id`; Task 6 `Delete all content is personal-only and needs the person's email`.

## Carried items

| Item | Where |
| --- | --- |
| Absent fields mean 1.0 | Global Constraints; Task 1 `rightsFor` team branch; every task's team-mode test |
| Default project without `prj_000…` | Task 2 (`ownDefaultProject`, grep test) |
| Hide Delete version on the last version for an editor who did not publish the artifact | Task 1 (`deleteVersion` needs `versionCount > 1`, and for an editor `v.created_by === me.id`) |
| M10 review Minor 7 and 8 (team-mode later default) | Task 2, **UI only, no server change.** The project page hides Archive exactly when the project's own GET says `is_default`, which is exactly when the server refuses, so the Minor 8 message cannot appear in the web. Lists keep showing the project as ordinary. A test pins both. |
| D8 links on the sign-in page and the share viewer | Task 4 |
| Members panel and its refusals | Task 3 |
| Shared with me; no upload or publish for viewers | Task 2 |
| Settings → Usage, Delete all my content | Task 5 |
| Not-approved share dialog; the raw link explains | Task 4 |
| Admin → Users additions, no transfer | Task 6 |
| Admin → Share links, Look up a link | Task 7 |
| Configuration page | Task 7 |
| i18n, component tests, axe | every task; axe in Task 8 |
| Playwright acceptance 2, 3, 9 | Task 8 |

---

### Task 1: Rights in the SPA — mode, project role, `can_manage` (model: opus)

**Files:**
- Create: `apps/web/src/api/spaces.ts`, `apps/web/src/test/spaces.ts`
- Modify:
  - shell: `apps/web/src/app/require-auth.tsx`;
  - review menu and top bar: `apps/web/src/review/viewer/review-menu.tsx`, `review/viewer/top-bar.tsx`;
  - review page and comments: `review/viewer/review-page.tsx`, `review/comments/backend.ts`;
  - share list: `review/share/share-link-list.tsx`.
- Test: `apps/web/src/api/spaces.test.ts`, `apps/web/src/review/viewer/rights.test.tsx`

**Interfaces:**
- Consumes: shared `Me`, `Project`, `ArtifactSummary`, `VersionSummary`, `ShareLink`, `PublicConfig`; 1.0 `usePublicConfig`, `useMe`, `useProject`, `canDelete` (`review-menu.tsx`), `canRevoke` (`share-status.ts`), `memberPermissions` (`backend.ts`).
- Produces:

```ts
// api/spaces.ts
export type Visibility = 'team' | 'personal';
export type ProjectRole = NonNullable<Project['role']>;              // 'owner' | 'editor' | 'viewer'
/** Inside the shell: 'personal' when the server says so, else 'team'. */
export function useVisibility(): Visibility;
/** 'team' (1.0 rules), the viewer's role in personal mode, or null while that role is not known. */
export type Standing = 'team' | ProjectRole | null;
export function standingOf(visibility: Visibility, project: Pick<Project, 'role'> | undefined): Standing;
export function useStanding(projectId: string | null | undefined): Standing;   // useProject when personal
export interface Rights {
  publish: boolean;             // upload into the project, restore a version
  manageProject: boolean;       // rename, archive, edit instructions
  deleteArtifact: boolean;
  deleteVersion(v: Pick<VersionSummary, 'created_by'> | null, versionCount: number): boolean;
  deleteOthersComments: boolean;
  createShareLinks: boolean;    // the role's part; the policy part is mayExpose(me)
  revokeLink(l: Pick<ShareLink, 'created_by'>): boolean;
}
export const NO_RIGHTS: Rights;                                       // every flag false, every function false
export function rightsFor(me: Me, artifact: Pick<ArtifactSummary, 'created_by' | 'can_manage'> | null, standing: Standing): Rights;
export function useArtifactRights(artifact: ArtifactSummary): Rights;
export function useProjectRights(projectId: string): Rights;          // rightsFor(me, null, useStanding(projectId))
/** Absent means 1.0: everyone may. */
export function mayExpose(me: Me): boolean;                           // me.can_create_share_links !== false
export function ownDefaultProject(projects: readonly Project[] | undefined): Project | undefined;
export function splitProjects(projects: readonly Project[]): { own: Project[]; shared: Project[] };   // shared: role editor | viewer
// test/spaces.ts
export const BOB = { id: 'usr_b', name: 'Bob Example' } as const;
export const PERSONAL: Partial<PublicConfig>;                          // { visibility: 'personal' }
export function fxOwn(o?: Partial<Project>): Project;                  // role 'owner', owner = fx.me()
export function fxShared(role: 'editor' | 'viewer', o?: Partial<Project>): Project;   // owner BOB
```

`rightsFor`:
- **`'team'`** follows the 1.0 rules exactly:
  - `publish`, `manageProject` and `createShareLinks` are true;
  - `deleteArtifact = canDelete(me, artifact)`;
  - `deleteVersion = deleteArtifact && versionCount > 1`;
  - `deleteOthersComments = me.role === 'admin' || artifact.created_by === me.id`;
  - `revokeLink = canRevoke(me, artifact, l)`.
- **`owner`:** everything, with `deleteVersion = versionCount > 1`.
- **`editor`:**
  - `publish` and `createShareLinks` are true;
  - `deleteArtifact = artifact.can_manage === true`;
  - `deleteVersion = versionCount > 1 && v?.created_by === me.id`;
  - `revokeLink = l.created_by?.user_id === me.id`;
  - everything else is false.
- **`viewer`** and **`null`** give `NO_RIGHTS`. A viewer still comments, and edits and deletes their own comments.
- **A `null` artifact** (`useProjectRights`) gives the project-level flags only; every artifact flag and function is false.

`RequireAuth` renders its skeleton until `/me` has answered and `/config/public` has answered or failed. A failed public config counts as `team` (the server still refuses what a role forbids).

Wiring:
- `ReviewMenu` takes `shownVersion?: VersionSummary | null` from `TopBar`, and asks `useArtifactRights`:
  - Restore needs `publish`;
  - Delete version needs `deleteVersion(shownVersion, versionCount)`;
  - Delete artifact needs `deleteArtifact`.
- `memberPermissions(me, artifact, rights?)`: with `rights` given, `canDelete` is the person's own comment `|| rights.deleteOthersComments`. Without it, the 1.0 rule applies, so the 1.0 tests that call it with two arguments keep passing.
- `ShareLinkList` offers Revoke by `rights.revokeLink`.
- `canDelete` and `canRevoke` stay exported, because 1.0 tests import them.
- The version switcher has no actions and does not change.

- [ ] **Step 1: Write the failing tests.**

```ts
// spaces.test.ts
test.each([
  // standing, artifact.created_by, can_manage, publish, deleteArtifact, deleteOthersComments, createShareLinks
  ['team', 'me', undefined, true, true, true, true], ['team', 'other', undefined, true, false, false, true],
  ['owner', 'other', true, true, true, true, true], ['editor', 'me', true, true, true, false, true],
  ['editor', 'other', false, true, false, false, true], ['viewer', 'other', false, false, false, false, false],
  [null, 'me', true, false, false, false, false],
])('rightsFor %s on an artifact by %s', …);   // me = fx.me({ role: 'member' }); team as admin: deleteArtifact true for 'other'
test('deleteVersion: never the last one; an editor only their own', () => {
  // owner: (v by other, 2) true, (v by other, 1) false; editor: (v by me, 2) true, (v by me, 1) false, (v by other, 2) false, (null, 2) false
  // team admin: (any, 2) true, (any, 1) false — 1.0
});
test('revokeLink: team by the 1.0 rule, owner any, editor their own, viewer none', …);
test('mayExpose: absent and true allow, false refuses', …);
test('ownDefaultProject skips a default project shared with me', () => {
  expect(ownDefaultProject([fxShared('editor', { id: 'prj_b', is_default: true }), fxOwn({ id: 'prj_d', is_default: true })])?.id).toBe('prj_d');
  expect(ownDefaultProject([fx.project({ is_default: true })])?.id).toBe('prj_1');   // team: no role
  expect(ownDefaultProject([fxShared('viewer', { is_default: true })])).toBeUndefined();
});
// rights.test.tsx — renderRoute('/a/art_1/v/2', { me: fx.me({ role: 'member' }), config: PERSONAL }) with serveReview
test('a viewer gets no Restore and no Delete in the review menu', …);       // project role viewer: menu lacks both
test('an editor deletes only versions they published, never the last one of an artifact they did not publish', …);
  // artifact created_by BOB.id, can_manage false; v1 by BOB, v2 by me; shown v2 → t('web.review.deleteVersion.item', { number: 2 }) present, 'Delete artifact' absent;
  // shown v1 → no Delete version; after v1 is deleted (list holds v2 only) → no Delete version on v2
test('the project owner deletes anyone\'s comment; an editor only their own', …);   // comment panel Delete on Bob's comment
test('the owner revokes any link of the project; an editor only their own', …);    // share dialog list rows
test('nothing that changes content shows until the role is known', …);      // Review Focus 1
  // GET /projects/prj_1 delayed: open the menu → no Restore, no Delete; resolve as owner → both appear
test('team mode keeps the 1.0 menu without waiting for the project', …);   // no visibility; GET /projects/prj_1 never answers; admin sees Delete artifact
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/api/spaces src/review/viewer/rights`. Expected: FAIL (`api/spaces.ts` missing).
- [ ] **Step 3: Implement** the module, the `RequireAuth` wait, and the wiring above.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @pinwall/web test`. Expected: PASS, with every 1.0 test unchanged.
- [ ] **Step 5: Commit** `feat(web): decide controls from the project role and can_manage in personal mode`.

### Task 2: Library and sidebar — Shared with me, own default, empty space, role-aware project page (model: sonnet)

**Files:**
- Modify:
  - shell and pages: `apps/web/src/app/shell/sidebar.tsx`, `pages/all-artifacts-page.tsx`, `pages/project-page.tsx`;
  - library: `library/instructions-editor.tsx` (`editable` prop);
  - strings: `packages/shared/src/i18n/en.json`.
- Test: `apps/web/src/library/spaces-library.test.tsx`, `apps/web/src/no-fixed-default.test.ts`

**Interfaces:**
- Consumes: Task 1 `useVisibility`, `useProjectRights`, `splitProjects`, `ownDefaultProject`, `fxOwn`, `fxShared`, `BOB`, `PERSONAL`; 1.0 `useProjects`, `useShellActions().openNewProject`, `useUpload`, `UploadButton`, `DropOverlay`, `EmptyState`.
- Produces: `InstructionsEditor({ project, editable = true })`. `editable: false` hides Edit; empty instructions then read `t('web.project.noInstructions')`.

UI:
- **Sidebar.**
  - In `team` mode it is unchanged.
  - In `personal` mode, Projects lists `splitProjects(...).own` (default first). A new section, **Shared with me**, lists `shared`, oldest first, and appears only when it has items.
  - Each shared row has two lines: the name, then `t('web.sidebar.sharedBy', { owner, role })` in muted small text. `owner` is `owner.name ?? t('web.project.someone')`; `role` is `t('web.role.editor')` or `t('web.role.viewer')`.
  - The archived disclosure keeps one list. Its shared rows carry the same second line.
- **All artifacts.**
  - The upload label is `ownDefaultProject(...)?.name ?? t('web.upload.defaultProject')`.
  - In `personal` mode the empty list shows the empty space: title `t('web.library.spaceEmptyTitle')`, body `t('web.library.spaceEmptyBody')`, and three actions: Connect an agent (`/connect`), Upload files, and New project (`openNewProject`). In `team` mode it is the 1.0 empty state.
- **Project page in `personal` mode.**
  - **A shared project's header** says `t('web.project.sharedEditor', { owner })` or `t('web.project.sharedViewer', { owner })`, ahead of the 1.0 summary.
  - **Without `publish`:** no Upload buttons, `DropOverlay` disabled, and an empty state with body `t('web.project.viewerEmptyBody')` and only Connect an agent.
  - **Without `manageProject`:** no project menu, no Unarchive in the archived banner, and `InstructionsEditor editable={false}`.
- **Team-mode later default (Minor 7 and 8):** no change. Archive stays hidden when the project's own GET says `is_default`.

en.json (exact):
- `"web.sidebar.shared": "Shared with me"`, `"web.sidebar.sharedBy": "{{owner}} · {{role}}"`, `"web.sidebar.loadingShared": "Loading shared projects"`
- `"web.role.owner": "Owner"`, `"web.role.editor": "Editor"`, `"web.role.viewer": "Viewer"`, `"web.project.someone": "Someone"`
- `"web.library.spaceEmptyTitle": "Your space is empty"`
- `"web.library.spaceEmptyBody": "Only you can see what you publish here, until you add people to a project or make a share link. Connect an agent, drop a file or a folder here, or create a project."`
- `"web.project.sharedEditor": "{{owner}}'s project · You can publish here"`, `"web.project.sharedViewer": "{{owner}}'s project · You can view and comment"`
- `"web.project.viewerEmptyBody": "Nothing has been published here yet."`, `"web.project.noInstructions": "No instructions for agents yet."`

- [ ] **Step 1: Write the failing tests.**

```ts
// spaces-library.test.tsx
test('team mode: no Shared with me, every project under Projects', …);   // serveSidebar([fx.project(), fx.project({ id: 'prj_2' })]), no visibility
test('personal mode: own projects under Projects, shared ones under Shared with me with owner and role', …);
  // [fxOwn({ id: 'prj_d', name: 'Default', is_default: true }), fxOwn({ name: 'Launch' }), fxShared('viewer', { id: 'prj_p', name: 'Pricing' })]
  // → list 'Projects' = ['Default', 'Launch']; list 'Shared with me' has 'Pricing' and 'Bob Example · Viewer'
test('Shared with me is absent when nothing is shared', …);
test("All artifacts uploads into the person's own default project, never a shared one", …);   // Review Focus 2
  // [fxShared('editor', { name: 'Bob default', is_default: true }), fxOwn({ name: 'Default', is_default: true })]
  // → upload dialog names 'Default'; POST /publish/upload target has no project_id; with no own default → t('web.upload.defaultProject')
test('a new person sees the empty space with three ways to start', …);
  // PERSONAL, no artifacts → heading t('web.library.spaceEmptyTitle'); link 'Connect an agent' → /connect;
  // 'Upload files' opens the upload dialog; 'New project' opens the New project dialog
test('team mode keeps the 1.0 empty library', …);   // heading t('web.library.emptyTitle'); no 'New project' button in it
test('a viewer gets no upload or publish controls on the project page', …);
  // fxShared('viewer'): header has t('web.project.sharedViewer', { owner: 'Bob Example' }); no 'Upload'; no t('web.project.menu') button;
  // no instructions Edit; a drop on the page sends no request
test('an editor uploads, but cannot rename, archive or change the instructions', …);
test('project controls stay hidden while the role loads', …);   // Review Focus 1: GET /projects/prj_1 delayed → no Upload until it answers as owner
test('team mode: a later default project offers no Archive, as the server refuses it', …);
  // list: [fx.project({ id: 'prj_t', is_default: true }), fx.project({ id: 'prj_2', is_default: false })]; GET /projects/prj_2 → is_default true
  // → menu has Rename, no Archive; sidebar lists prj_2 second, as an ordinary project
test('names render as text', …);   // shared project named '<img src=x onerror=alert(1)>' with owner '<b>Bob</b>' → literal text, no img
// no-fixed-default.test.ts
test('the web app never names the 1.0 default project id', …);   // readdir src recursively (not test/): no file contains 'prj_00000000000000000000'
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/library/spaces-library src/no-fixed-default`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): show shared projects, the empty space and role-aware project pages`.

### Task 3: Members panel (model: sonnet)

**Files:**
- Create: `apps/web/src/api/members.ts`, `apps/web/src/library/members/{members-dialog.tsx,add-member-form.tsx,member-row.tsx}`, `apps/web/src/test/members.ts`
- Modify: `apps/web/src/pages/project-page.tsx` (a Members header action, `personal` mode only), `apps/web/src/api/keys.ts`, `apps/web/src/api/dto.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/library/members/members.test.tsx`

**Interfaces:**
- Consumes:
  - shared `ProjectMember`, `ProjectMemberList`, `AddMemberRequest`, `UpdateMemberRequest`, `MemberCandidate`, `ProjectMemberRole`; `dto.ts` re-exports them;
  - Task 1 `useVisibility`, `useStanding`;
  - 1.0 `Dialog`, `Field`, `Input`, `Select` (with `detail`), `ConfirmDialog`, `Avatar`, `Badge`, `useRowDialog`, `errorMessage`, `isApiError`.
- Produces:

```ts
// api/members.ts — routes from M11; every one answers 404 in team mode, so callers run only in personal mode
export function listMembers(projectId: string): Promise<ProjectMemberList>;                               // GET /projects/{id}/members
export function addMember(projectId: string, body: AddMemberRequest): Promise<ProjectMember>;            // POST → 201
export function updateMember(projectId: string, userId: string, role: ProjectMemberRole): Promise<ProjectMember>;   // PATCH { role }
export function removeMember(projectId: string, userId: string): Promise<void>;                           // DELETE → 204; also "leave"
export function useMembers(projectId: string, enabled: boolean): UseQueryResult<ProjectMemberList, ApiError>;
export function useAddMember(projectId: string): UseMutationResult<ProjectMember, ApiError, AddMemberRequest>;   // invalidates qk.members
export function useUpdateMember(projectId: string): UseMutationResult<ProjectMember, ApiError, { userId: string; role: ProjectMemberRole }>;
export function useRemoveMember(projectId: string): UseMutationResult<void, ApiError, string>;
/** Leaves: DELETE with the caller's own id; drops qk.project(id), refreshes project, artifact and Recent lists. */
export function useLeaveProject(projectId: string): UseMutationResult<void, ApiError, void>;
/** The accounts a 409 several_accounts offered; null for any other error. */
export function candidatesOf(e: unknown): MemberCandidate[] | null;
/** 'email' for a refusal about the address (404 or 400 with details.field 'email', 409 already_member); null otherwise. */
export function memberErrorField(e: unknown): 'email' | null;
// api/keys.ts
members: (projectId: string) => ['members', projectId] as const,
// test/members.ts
export function serveMembers(o: { projectId: string; members: ProjectMember[]; add?: (body: AddMemberRequest) => Response }): { calls: Call[] };
```

UI:
- **The header action.** A **Members** button (Users icon) on every project page in `personal` mode. It opens `MembersDialog({ project, open, onOpenChange })`.
- **The list.** The owner's row comes first, from `Project.owner`, with the Owner badge and "You" when it is the viewer. Then the members, oldest first.
- **The owner's view:**
  - each member row shows name and email, a role `Select` (Editor or Viewer, label `t('web.members.roleFor', { name })`), and a Remove `IconButton` (`t('web.members.removeFor', { name })`) behind a danger `ConfirmDialog`;
  - under the list, the add form: an email `Input` (type email), a role `Select` that defaults to Viewer, an **Add** button, and the hint `t('web.members.hint')`.
- **Several accounts.** A 409 with `reason: 'several_accounts'` shows the `Select` "Which account?". Each option is `name ?? t('web.members.unnamed')`, with detail `t('web.members.kind.<kind>')`. Add then sends `user_id`. Editing the email clears the choice.
- **Refusals.** `memberErrorField` decides where each message goes:
  - 404 no account, 400 adding oneself and 409 already a member: the server's message, verbatim, under the email field;
  - 403 role, 429 and anything else: the form alert.
- **Everyone else's view.** Names only, with no email, role, Select or Remove, plus `t('web.members.memberHint')`. The footer offers **Leave project**, behind a `ConfirmDialog`. On success it navigates to `/` and shows the toast `t('web.members.left', { project })`.
- **States.** A skeleton while loading, an error with Retry, and for the owner with nobody added, `t('web.members.empty')`.

en.json (exact):
- `"web.members.button": "Members"`, `"web.members.title": "Members of “{{project}}”"`
- `"web.members.hint": "Add someone who has signed in to Pinwall at least once. Viewers see this project and comment; editors also publish here."`
- `"web.members.memberHint": "Only the project's owner can add or remove people."`
- `"web.members.empty": "Nobody else is in this project yet."`, `"web.members.unnamed": "Unnamed account"`, `"web.members.you": "You"`
- `"web.members.chooseAccount": "Which account?"`, `"web.members.kind.owner": "Signs in with a password or passkey"`, `"web.members.kind.oidc": "Signs in with single sign-on"`
- `"web.members.remove.body": "{{name}} loses access to “{{project}}” at once: open pages and live updates stop, and the share links they made here stop working. Their comments stay."`
- `"web.members.leave": "Leave project"`, `"web.members.leave.body": "You lose access at once, and the share links you made in this project stop working. Only the owner can add you again."`, `"web.members.left": "You left “{{project}}”."`
- the labels `web.members.email`, `.role`, `.add`, `.roleFor`, `.removeFor`, `.remove.title`, `.leave.title`, `.loading`.

- [ ] **Step 1: Write the failing tests** (`renderRoute('/projects/prj_1', { config: PERSONAL })`).

```ts
test('the Members button exists only in personal mode', …);   // team: none, and no request to /members
test('the owner sees members with emails, changes a role and removes someone', …);
  // members [Grace viewer grace@example.com] → Select 'Role of Grace Hopper' → Editor → PATCH /projects/prj_1/members/usr_2 { role: 'editor' };
  // Remove → confirm text has t('web.members.remove.body', …) → DELETE /projects/prj_1/members/usr_2 → list refetched
test('the owner adds by email with a role', …);   // 'grace@example.com', Editor → POST { email: 'grace@example.com', role: 'editor' } → row 'Grace Hopper'
test('several accounts share the email: the owner picks one and only that one is added', …);   // Review Focus 3
  // first POST → 409 { reason: 'several_accounts', candidates: [{ user_id: 'usr_5', name: 'Grace', kind: 'owner' }, { user_id: 'usr_6', name: 'Grace Hopper', kind: 'oidc' }] }
  // → 'Which account?' options with both kind details; pick 'Grace Hopper' → second POST { email, role: 'viewer', user_id: 'usr_6' }; exactly 2 POSTs
test("refusals show the server's words where they belong", …);
  // 404 { field: 'email' } t('spaces.members.noAccount'), 400 { field: 'email' } t('spaces.members.self'),
  // 409 { reason: 'already_member' } t('spaces.members.already') → under the email field; 403 { reason: 'role' } and 429 → form alert
test('members see names only and can leave', …);
  // project role viewer: no email text, no Select, no Add, no Remove; 'Leave project' → confirm → DELETE /projects/prj_1/members/<me.id> → path '/' and toast
test('member names render as text', …);   // name '<img src=x onerror=alert(1)>' literal
test('members list states', …);           // skeleton, 500 → Retry
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/library/members`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add the project members panel`.

### Task 4: Share dialog states, raw-link explanation, abuse contact and policy links (model: sonnet)

**Files:**
- Create: `apps/web/src/app/policy-links.tsx`
- Modify:
  - share dialog: `apps/web/src/review/share/share-dialog.tsx`, `review/share/share-form.tsx`;
  - review menu: `review/viewer/review-menu.tsx`;
  - sign-in: `pages/auth/auth-layout.tsx` (an optional `footer`), `pages/auth/sign-in-page.tsx`;
  - share pages: `pages/share/share-card.tsx`, `pages/share/share-viewer.tsx` (`ShareBar`);
  - strings: `packages/shared/src/i18n/en.json`.
- Test: `apps/web/src/review/share/share-states.test.tsx`, `apps/web/src/app/policy-links.test.tsx`

**Interfaces:**
- Consumes: Task 1 `mayExpose`, `useArtifactRights`; 1.0 `usePublicConfig`, `qk.me`, `ShareForm`, `ShareLinkList`, `Dialog`, `MenuItem`.
- Produces:

```ts
// app/policy-links.tsx
/** 'mailto:' + contact for an email address, the URL for an http(s) URL, null for anything else. */
export function abuseHref(contact: string): string | null;
/** The URL when it is http(s), else null. */
export function safeHttpUrl(url: string | undefined): string | null;
/** Terms of use · Privacy · Report abuse: <contact>, each only when set; nothing when none is. */
export function PolicyLinks(p: { config: PublicConfig; terms?: boolean }): JSX.Element | null;
/** The share bar's flag link, labelled t('web.policy.reportAbuse'); nothing without a usable contact. */
export function ReportAbuseLink(p: { config: PublicConfig }): JSX.Element | null;
// share-form.tsx
onRefused?(reason: 'share_links_not_approved'): void;   // a create refused by policy; other errors keep the 1.0 form alert
```

**Share dialog:**
- When `!mayExpose(me)`, the form is replaced by a callout: title `t('web.share.notApproved.title')`, body `t('spaces.exposure.shareLink')`.
- When `!rights.createShareLinks` (a viewer), the callout is `t('web.share.viewerRole.title')` with `t('spaces.role.createShareLink')`.
- Either way the footer has only Close, and the link list stays, with Revoke by `rights`.
- A create answered with 403 `share_links_not_approved` calls `onRefused`. The dialog then invalidates `qk.me` and shows the not-approved callout, with no toast.

**Review menu.** When `!mayExpose(me)`, "Open raw page" and "Copy raw link" give way to one item, `t('web.review.rawUnavailable')`. It opens a small `Dialog` with that title, the body `t('spaces.exposure.rawLink')` and Close. No `href` to `/raw` is rendered.

**D8 links:**
- **Sign-in page:** `PolicyLinks` with `terms` under the card, through `AuthLayout`'s `footer`.
- **`ShareCard`** (password, gone and not-found screens): under "Shared via Pinwall", `PolicyLinks` without terms, so only the abuse line shows.
- **`ShareBar`:** `ReportAbuseLink` before Open original, opening in a new tab with `rel="noopener noreferrer"`.
- **Abuse line:** `t('pages.reportAbuse')` followed by the contact as the link text.

en.json (exact):
- `"web.share.notApproved.title": "Sharing outside Pinwall needs an admin's approval"`, `"web.share.viewerRole.title": "Viewers cannot make share links"`
- `"web.review.rawUnavailable": "Raw page not available"`
- `"web.policy.terms": "Terms of use"`, `"web.policy.privacy": "Privacy"`, `"web.policy.reportAbuse": "Report abuse"`, `"web.policy.nav": "About this Pinwall"`

- [ ] **Step 1: Write the failing tests.**

```ts
// share-states.test.tsx
test('a person who is not approved sees why instead of the form, and still lists and revokes their links', …);
  // me can_create_share_links false → no 'Create link'; text t('spaces.exposure.shareLink'); own link row Revoke → DELETE /share-links/shr_1
test('a viewer sees why they cannot share, and revokes nothing', …);   // PERSONAL, role viewer → t('spaces.role.createShareLink'); no Revoke
test('approval taken away while the dialog is open switches it to the explanation', …);   // Review Focus 4
  // POST → 403 { code: 'forbidden', message: t('spaces.exposure.shareLink'), details: { reason: 'share_links_not_approved' } };
  // GET /me requested again (now can_create_share_links false); callout shown; no toast error
test('without the field, and when approved, the 1.0 form shows', …);
test('Open raw page explains why it is unavailable to a person who is not approved', …);
  // menu item t('web.review.rawUnavailable') → dialog with t('spaces.exposure.rawLink'); no element with href ending '/raw';
  // can_create_share_links true or absent → link 'Open raw page' href '/a/art_1/v/1/raw'
// policy-links.test.tsx
test('abuseHref and safeHttpUrl accept email and http(s) only', () => {
  expect(abuseHref('abuse@example.org')).toBe('mailto:abuse@example.org');
  expect(abuseHref('https://example.org/report')).toBe('https://example.org/report');
  expect(abuseHref('javascript:alert(1)')).toBeNull(); expect(abuseHref('ftp://x')).toBeNull();
  expect(safeHttpUrl('http://example.org/terms')).toBe('http://example.org/terms'); expect(safeHttpUrl('data:text/html,x')).toBeNull();
});
test('the sign-in page links the terms, the privacy notice and the abuse contact when set', …);
  // config { terms_url, privacy_url, abuse_contact: 'abuse@example.org' } → links 'Terms of use', 'Privacy', 'abuse@example.org' (mailto); unset → none
test('share pages show the abuse contact', …);
  // viewer bar link 'Report abuse' href mailto; 410 gone card and password card show 'Report abuse: abuse@example.org'; unset → no t('pages.reportAbuse')
test('a contact that is no email or http(s) URL shows as text, never as a link', …);   // 'javascript:alert(1)' → text, no <a>
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/review/share/share-states src/app/policy-links`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): explain sharing and raw-link limits and show the abuse contact and policy links`.

### Task 5: Settings → Usage and Delete all my content (model: sonnet)

**Files:**
- Create: `apps/web/src/pages/settings/usage-page.tsx`, `apps/web/src/ui/typed-confirm-dialog.tsx`
- Modify:
  - UI kit: `apps/web/src/ui/index.ts`;
  - account API: `apps/web/src/api/account.ts`;
  - routes and settings: `apps/web/src/app/routes.tsx`, `apps/web/src/pages/settings/settings-layout.tsx`;
  - strings: `packages/shared/src/i18n/en.json`.
- Test: `apps/web/src/pages/settings/usage.test.tsx`, `apps/web/src/ui/typed-confirm-dialog.test.tsx`

**Interfaces:**
- Consumes: shared `PurgeRequest`, `PurgeResult`, `Me.usage`, `Me.limits`; Task 1 `useVisibility`; 1.0 `getMe`, `qk`, `formatBytes`, `ConfirmDialog`'s behavior (busy, errors keep it open).
- Produces:

```ts
// ui/typed-confirm-dialog.tsx — ConfirmDialog's behavior plus a field that must match `expected`
export function TypedConfirmDialog(p: {
  open: boolean; onOpenChange(open: boolean): void;
  title: string; body: ReactNode; confirmLabel: string;
  /** Compared trimmed and ignoring case; Confirm stays disabled until it matches. */
  expected: string;
  fieldLabel: string;
  /** Receives the typed text, trimmed. */
  onConfirm(typed: string): Promise<unknown>;
  errorMessage?(error: unknown): string;
}): JSX.Element;   // tone danger
// api/account.ts
export function purgeMyContent(confirm_email: string): Promise<PurgeResult>;   // POST /me/purge
export function usePurgeMyContent(): UseMutationResult<PurgeResult, ApiError, string>;
  // onSuccess: invalidates artifact lists, project lists, Recent and me
// routes.tsx: settings child { path: 'usage', element: <UsagePage /> }; without me.usage it renders <Navigate to="/settings/profile" replace />
```

UI:
- **Nav.** Settings gets a **Usage** link when `me.usage` is present. That happens in `personal` mode, or in `team` mode when a quota applies.
- **The page** reads `/me` afresh on mount (`refetchOnMount: 'always'`) and shows two meters:
  - Storage: `t('web.usage.ofLimit', { used: formatBytes(bytes), limit })`;
  - Artifacts: `t('web.usage.artifactsOf', { count, limit })`.

  `limit` is `t('web.usage.noLimit')` when it is null.
- **Meters.** Each has `role="meter"`, with `aria-valuenow`, `aria-valuemax` (when there is a limit) and `aria-valuetext`. At 90 % or more it takes the warning tone. At or over the limit it takes the danger tone, with `t('web.usage.full')`.
- **Counting.** The note `t('web.usage.counting')`.
- **Delete all my content** (`personal` mode only). A danger card with `t('web.purge.self.body')` opens a `TypedConfirmDialog`:
  - `expected` is `me.email ?? me.id`, and the field label is `t('web.purge.type', { value: expected })`;
  - on success it shows the toast `t('web.purge.done', { projects, artifacts })`, then navigates to `/`;
  - a 400 or 409 shows the server's message in the dialog.

en.json (exact):
- `"web.settings.usage": "Usage"`, `"web.usage.storage": "Storage"`, `"web.usage.artifacts": "Artifacts"`, `"web.usage.ofLimit": "{{used}} of {{limit}}"`
- `"web.usage.artifactsOf_one": "{{count}} of {{limit}} artifacts"` and `"web.usage.artifactsOf_other"`, the same text
- `"web.usage.noLimit": "no limit"`
- `"web.usage.counting": "Each version counts at its full size, including what editors publish in your projects. Deleting old versions frees space."`
- `"web.usage.full": "Your space is full. Publishing stops until you delete versions or artifacts, or an admin gives you more room."`
- `"web.purge.self.title": "Delete all my content"`, `"web.purge.self.body": "Deletes every project you own, with all their artifacts, versions, comments and share links. Projects others shared with you stay, and so does your account. This cannot be undone."`
- `"web.purge.type": "Type {{value}} to confirm"`, `"web.purge.button": "Delete everything"`, `"web.purge.done": "Deleted {{projects}} and {{artifacts}}."`
- `"web.purge.projects_one": "{{count}} project"`, `"web.purge.projects_other": "{{count}} projects"`, `"web.purge.artifacts_one": "{{count}} artifact"`, `"web.purge.artifacts_other": "{{count}} artifacts"`

- [ ] **Step 1: Write the failing tests.**

```ts
// usage.test.tsx
test('usage shows bytes and artifacts against the limits', …);
  // me usage { bytes: 120_000_000, artifacts: 12 }, limits { bytes: 500_000_000, artifacts: 200 } → '120 MB of 500 MB', '12 of 200 artifacts';
  // meter 'Storage' aria-valuenow '120000000', aria-valuemax '500000000'
test('a null limit reads as no limit', …);           // '120 MB of no limit'; meter has no aria-valuemax
test('a full space says what to do', …);             // 500_000_000 of 500_000_000 → t('web.usage.full')
test('the Usage page exists only when the server sends usage', …);   // no usage → no 'Usage' link; /settings/usage → /settings/profile
test('Delete all my content needs the email typed, then deletes and goes home', …);
  // PERSONAL; Confirm disabled; type ' ADA@example.com ' → enabled → POST /me/purge { confirm_email: 'ADA@example.com' }
  // → { projects: 2, artifacts: 5 } → toast 'Deleted 2 projects and 5 artifacts.'; path '/'
test('an account without an email confirms with its id', …);   // Review Focus 5: me.email null → label names me.id; typing the id enables
test("the server's refusal stays in the dialog", …);            // 400 t('purge.confirm') and 409 t('purge.busy') verbatim; dialog open
test('Delete all my content is not offered in team mode', …);  // usage present, no visibility → meters shown, no danger card
test("a publish over the quota shows the server's words in the upload toast", …);
  // POST /publish/upload → 413 { code: 'quota_exceeded', message: 'This version needs 2 MB, but your space…' } → toast text verbatim
// typed-confirm-dialog.test.tsx
test('confirm follows a trimmed, case-insensitive match and passes the trimmed text', …);
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/pages/settings/usage src/ui/typed-confirm-dialog`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add Settings → Usage with Delete all my content`.

### Task 6: Admin → Users — usage, approval, limits, purge (model: sonnet)

**Files:**
- Create: `apps/web/src/pages/admin/{quota-dialog.tsx,user-actions.tsx}`
- Modify:
  - admin API: `apps/web/src/api/admin.ts`;
  - Users page: `pages/admin/users-page.tsx`, `pages/admin/user-parts.tsx`;
  - UI kit: `apps/web/src/ui/switch.tsx` (`hideLabel?: boolean`, as `Select` has);
  - fixtures: `apps/web/src/test/admin.ts`;
  - strings: `packages/shared/src/i18n/en.json`.
- Modify (1.0 test, only if `TABLE_QUERY` moves): `apps/web/src/pages/admin/users.test.tsx` "the table needs…" numbers
- Test: `apps/web/src/pages/admin/users-spaces.test.tsx`

**Interfaces:**
- Consumes:
  - shared `AdminUser` (`usage`, `share_approved`, `quota_bytes`, `quota_artifacts`), `AdminUsage`, `UpdateAdminUserRequest`, `PurgeResult`;
  - Task 1 `useVisibility`; Task 5 `TypedConfirmDialog`;
  - 1.0 `usePublicConfig`, `useSetUserRole`'s cache update, `Switch`, `Select`, `Menu`, `useRowDialog`.
- Produces:

```ts
// api/admin.ts
export function updateAdminUser(id: string, body: UpdateAdminUserRequest): Promise<AdminUser>;   // PATCH /admin/users/{id}
export function purgeUser(id: string, confirm_email: string): Promise<PurgeResult>;              // POST /admin/users/{id}/purge
export function useUpdateAdminUser(): UseMutationResult<AdminUser, ApiError, { id: string; patch: UpdateAdminUserRequest }>;
  // writes the answer into qk.adminUsers, as useSetUserRole does
export function usePurgeUser(): UseMutationResult<PurgeResult, ApiError, { id: string; confirm: string }>;   // invalidates qk.adminUsers
export type QuotaChoice = { kind: 'instance' } | { kind: 'none' } | { kind: 'custom'; value: number };
export function fromQuota(q: number | null | undefined): QuotaChoice;   // null/undefined → instance, 0 → none, n → custom n
export function toQuota(c: QuotaChoice): number | null;                 // instance → null, none → 0, custom → value
export const BYTE_UNITS = { MB: 1_000_000, GB: 1_000_000_000 } as const;
// test/admin.ts
fxAdminUser defaults gain usage { projects: 0, artifacts: 0, versions: 0, bytes: 0, share_links: 0, last_published_at: null },
  share_approved: false, quota_bytes: null, quota_artifacts: null;
serveAdminUsers handles PATCH /admin/users/:id (merges the patch, records the call) and POST /admin/users/:id/purge ({ projects: 1, artifacts: 2 })
```

UI. These additions show in both modes (spec §7), except Delete all content.
- **Usage column** (and card fact), three lines:
  - `t('web.admin.usage.summary', { artifacts, bytes: formatBytes(bytes) })`;
  - muted: `t('web.admin.usage.detail', { projects, versions, links })`;
  - muted: `t('web.admin.usage.lastPublished', { time })`, or `t('web.admin.usage.neverPublished')`.

  A `t('web.admin.quota.custom')` badge shows when either override is set.
- **Sharing column.** A `Switch` with `hideLabel`, labelled `t('web.admin.approval.for', { name })`.
  - **Admins:** checked and disabled, described by `t('web.admin.approval.admin')`.
  - **Turning it on** sends PATCH `{ share_approved: true }` at once.
  - **Turning it off** with `share_links === 'approved'` first asks with a `ConfirmDialog` (`t('web.admin.approval.removeBody', { name })`). In `members` mode it sends without asking.
  - **Without `approved`,** the page hint adds `t('web.admin.approval.inactive')`.
  - A refused change shows the server's message in a toast, and the switch returns to the server's value.
- **More actions** (`IconButton`, `t('web.admin.more', { name })`), next to Revoke now:
  - **Set limits…** opens `QuotaDialog`. Storage and Artifacts each get a `Select` (Instance limit, No limit, Custom). Custom shows a number input; storage adds a unit `Select` (MB or GB). A custom value must be a whole number of at least 1. Save sends both keys.
  - **Delete all content…** appears in `personal` mode only. It opens `TypedConfirmDialog` with `expected = user.email ?? user.id`. On success it shows the toast `t('web.admin.purge.done', …)` and refreshes the list.
  - There is no transfer action, and none that moves content.
- **Table breakpoint.** If the table needs more room, raise `TABLE_QUERY` so actions never sit off-screen (the M7b ruling).

en.json (exact):
- `"web.admin.col.usage": "Usage"`, `"web.admin.col.sharing": "Sharing"`
- `"web.admin.usage.summary": "{{artifacts}} · {{bytes}}"`, `"web.admin.usage.detail": "{{projects}} · {{versions}} · {{links}}"`, with plural sub-keys for artifacts, projects, versions and links
- `"web.admin.usage.lastPublished": "Published {{time}}"`, `"web.admin.usage.neverPublished": "Never published"`
- `"web.admin.quota.custom": "Custom limits"`, `"web.admin.quota.item": "Set limits…"`, `"web.admin.quota.title": "Limits for {{name}}"`
- `"web.admin.quota.instance": "Instance limit"`, `"web.admin.quota.none": "No limit"`, `"web.admin.quota.customOption": "Custom"`
- `"web.admin.quota.wholeNumber": "Enter a whole number of at least 1."`, `"web.admin.quota.adminExempt": "Admins have no limits. These apply if {{name}} stops being an admin."`
- `"web.admin.approval.for": "{{name}} may expose content"`, `"web.admin.approval.admin": "Admins always may."`
- `"web.admin.approval.inactive": "Approval takes effect only with PINWALL_SHARE_LINKS=approved. Approve people before you switch, so their links keep working."`
- `"web.admin.approval.removeTitle": "Stop {{name}} sharing?"`, `"web.admin.approval.removeBody": "Every share link {{name}} made stops working at once, and their pages open only inside Pinwall's viewer."`
- `"web.admin.more": "More actions for {{name}}"`, `"web.admin.purge.item": "Delete all content…"`, `"web.admin.purge.title": "Delete all of {{name}}'s content?"`
- `"web.admin.purge.body": "Deletes every project {{name}} owns, with everything in it: their share links answer “gone” and the files are removed. Projects they only belong to stay, and so does their account. You will not see any of the content."`
- `"web.admin.purge.done": "Deleted {{projects}} and {{artifacts}} of {{name}}."`

- [ ] **Step 1: Write the failing tests** (`users-spaces.test.tsx`, `serveSidebar()`, viewport 1600 and 360).

```ts
test('each user shows usage, last publish and a custom-limits badge', …);
  // usage { projects: 3, artifacts: 12, versions: 20, bytes: 120_000_000, share_links: 2, last_published_at: 2 h ago }, quota_bytes 1_000_000_000
  // → '12 artifacts · 120 MB', '3 projects · 20 versions · 2 links', 'Published 2 hours ago', 'Custom limits'; the same facts on a 360 px card
test('approval turns on at once, and asks before it is taken away when links need approval', …);
  // config share_links 'approved': on → PATCH /admin/users/usr_2 { share_approved: true }; off → confirm t('web.admin.approval.removeBody', …) → PATCH { share_approved: false }
  // members mode: off sends at once; t('web.admin.approval.inactive') shown only in members mode
test('admins may always expose content', …);   // admin row switch checked and disabled
test('limits: instance, none or custom', …);
  // storage Custom 2 GB, artifacts No limit → PATCH { quota_bytes: 2_000_000_000, quota_artifacts: 0 }; both Instance → { quota_bytes: null, quota_artifacts: null };
  // artifacts Custom '1.5' → t('web.admin.quota.wholeNumber'), no request
test("Delete all content is personal-only and needs the person's email", …);   // Review Focus 5
  // team: no such menu item; PERSONAL: dialog; ' GRACE@example.com' → POST /admin/users/usr_2/purge { confirm_email: 'GRACE@example.com' } → toast; list refetched;
  // a user with email null confirms with its id
test('there is no transfer in the app', …);   // no button or menu item matches /transfer|move/i on the page or in any row menu
test("a refused change shows the server's words and keeps the old value", …);   // PATCH 400 → toast verbatim; switch unchecked again
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/pages/admin/users-spaces`. Expected: FAIL.
- [ ] **Step 3: Implement** as above, then update the `test/admin.ts` fixtures.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/web test src/pages/admin`, then `pnpm --filter @pinwall/web test`. Expected: PASS, and the 1.0 `users.test.tsx` passes, changed at most in its breakpoint numbers.
- [ ] **Step 5: Commit** `feat(web): show usage, approval, limits and purge on Admin → Users`.

### Task 7: Admin → Share links, Look up a link, and the configuration page (model: sonnet)

**Files:**
- Create: `apps/web/src/pages/admin/{share-links-page.tsx,lookup-page.tsx,lookup-result.tsx}`, `apps/web/src/app/spaces-explainer.tsx`
- Modify:
  - admin API and data: `apps/web/src/api/admin.ts`, `api/keys.ts`, `api/dto.ts` (only if M12 Task 6's DTOs are not in shared yet);
  - routes and admin pages: `app/routes.tsx` (admin children `share-links`, `lookup`), `pages/admin/admin-layout.tsx` (nav: Users, Share links, Look up a link, Configuration), `pages/admin/config-page.tsx`;
  - fixtures and strings: `src/test/admin.ts`, `packages/shared/src/i18n/en.json`.
- Test: `apps/web/src/pages/admin/{share-links,lookup,config-spaces}.test.tsx`

**Interfaces:**
- Consumes:
  - M12 Task 6 `AdminPerson`, `AdminShareLink`, `AdminShareLinkList`, `AdminLookup`, `EndGrantsResult`, and its routes;
  - 1.0 `setUserRole` (block), `formatRelativeTime`, `formatDate`, `IsolationExplainer`'s pattern, `ConfirmDialog`, `useRowDialog`.
- Produces:

```ts
// api/admin.ts
export const ADMIN_LINKS_PAGE_SIZE = 50;
export function listAdminShareLinks(p: { cursor?: string | null; limit?: number }): Promise<AdminShareLinkList>;   // GET /admin/share-links
export function adminRevokeShareLink(id: string): Promise<void>;                     // DELETE /admin/share-links/{id}
export function lookupUrl(url: string): Promise<AdminLookup>;                        // POST /admin/lookup { url }
export function adminDeleteArtifact(id: string): Promise<void>;                      // DELETE /admin/artifacts/{id}
export function adminDeleteVersion(id: string, n: number): Promise<void>;            // DELETE /admin/artifacts/{id}/versions/{n}
export function endVersionGrants(versionId: string): Promise<EndGrantsResult>;       // POST /admin/versions/{id}/end-grants
export function useAdminShareLinks(): UseInfiniteQueryResult<InfiniteData<AdminShareLinkList>, ApiError>;
// api/keys.ts
adminShareLinks: ['admin', 'share-links'] as const,
// app/spaces-explainer.tsx
export function SpacesExplainer(p: { visibility: string | null; shareLinks: string | null }): JSX.Element;   // values from the config entries
// test/admin.ts
export function fxAdminShareLink(o?: Partial<AdminShareLink>): AdminShareLink;
export function fxLookup(o?: Partial<AdminLookup>): AdminLookup;
export function serveModeration(o: { links?: AdminShareLink[]; lookup?: (url: string) => Response; pageSize?: number }): { calls: Call[] };
```

**Share links** (`/admin/share-links`):
- **Columns** (cards below the breakpoint): artifact name; owner name and email; made by, when it differs from the owner; Shows (`t('web.share.scopeLatestShort')` or `vN`); the Password and Comments badges; created; expires (Never, or relative); last used (Never, or relative).
- **Revoke.** Behind a confirm, then DELETE; the row leaves the list.
- **Delete artifact.** Behind a danger confirm (`t('web.admin.links.deleteBody', { name })`), then DELETE `/admin/artifacts/{id}` and a refetch.
- **No links out.** No link to the artifact, the share URL or content. The hint says why.
- **Paging and states.** Load more, plus the skeleton, empty and error states.

**Look up a link** (`/admin/lookup`):
- **The form.** A "Reported address" `Input` (type text) and Look up.
- **The result** is a region labelled by the kind (`t('web.admin.lookup.kind.<kind>')`). It lists:
  - artifact name, project name, owner name and email;
  - `vN` and who published it;
  - the share link's facts (made by, created, expires, password, comments, last used), or the grant's (Review or Raw, expires, holder, or `t('web.admin.lookup.guest')` when the holder is null).
- **Actions,** each behind a confirm:
  - Revoke link (when there is a `share_link`);
  - End open pages of vN (end-grants, then the toast `t('web.admin.lookup.grantsEnded', { count })`);
  - Delete vN;
  - Delete artifact;
  - Block owner, through the existing `setUserRole(owner.id, 'blocked')`, shown when the owner is set and is not the viewer.

  After an action the look-up runs again for the same address. A 410 then shows the server's "already removed" message.
- **Refusals.** 400, 404 and 410 show the server's message, verbatim, under the field.

**Configuration:**
- After `IsolationExplainer`, a `SpacesExplainer` explains `team` vs `personal` and `members` vs `approved`, and marks the current values (read from the `PINWALL_VISIBILITY` and `PINWALL_SHARE_LINKS` entries).
- A `PINWALL_QUOTA_BYTES` or `PINWALL_QUOTA_ARTIFACTS` value of `"0"` reads `t('web.config.noLimit')` instead of `≈ 0 bytes`.

en.json (exact):
- `"web.admin.links": "Share links"`, `"web.admin.links.hint": "Every share link that still opens, across all people. Pinwall stores only a hash of each link, so links cannot be opened from here; to check a reported address, use Look up a link."`
- `"web.admin.links.empty": "No share link is open right now."`, `"web.admin.links.deleteBody": "Deletes “{{name}}” for its owner too: every version, comment and share link. This cannot be undone."`
- `"web.admin.lookup": "Look up a link"`, `"web.admin.lookup.hint": "Paste an address from an abuse report: a share link, an artifact link, or a content address. You see whose it is and what it points to, not its content."`
- `"web.admin.lookup.field": "Reported address"`, `"web.admin.lookup.guest": "A visitor of a share link"`
- `"web.admin.lookup.grantsEnded_one": "Ended {{count}} open page."`, `"web.admin.lookup.grantsEnded_other": "Ended {{count}} open pages."`
- `"web.admin.lookup.kind.share_link": "Share link"`, `"web.admin.lookup.kind.content_grant": "Content address"`, `"web.admin.lookup.kind.artifact": "Artifact link"`
- `"web.config.spaces.title": "Who sees what, and who may share"`
- `"web.config.visibility.team": "team: every member sees every project, as in Pinwall 1.0."`, `"web.config.visibility.personal": "personal: each person sees only the projects they own or were added to. Admins do not see other people's work."`
- `"web.config.shareLinks.members": "members: anyone may make share links and open raw links."`, `"web.config.shareLinks.approved": "approved: only admins and people approved in Users may; everyone else's pages open only inside Pinwall's viewer."`
- `"web.config.noLimit": "0 (no limit)"`
- the column and action labels under `web.admin.links.*` and `web.admin.lookup.*`.

- [ ] **Step 1: Write the failing tests.**

```ts
// share-links.test.tsx
test('the share-link list shows metadata and pages', …);
  // fxAdminShareLink { artifact: { name: 'Pricing' }, owner: { name: 'Bob Example', email: 'bob@example.test' }, version: null, has_password: true, last_used_at: 2 h ago }
  // → 'Pricing', 'Bob Example', 'bob@example.test', 'Latest version', 'Password', 'Never', '2 hours ago';
  // no element has an href containing '/s/', '/a/' or '/c/'; 'Load more' → ?cursor=
test('revoke asks, then the link leaves the list', …);   // DELETE /admin/share-links/shr_1
test('delete artifact warns, then refreshes', …);         // DELETE /admin/artifacts/art_1; list refetched
test('list states', …);
// lookup.test.tsx
test('a share URL names the artifact, owner, version and link', …);   // POST /admin/lookup { url: 'https://pinwall.test/s/abc' } → all facts shown
test('a content URL shows the grant and its holder', …);              // kind content_grant, grant { mode: 'review', holder: { name: 'Eve Example' } }
test('each takedown asks first and calls its route', …);
  // DELETE /admin/share-links/shr_1; POST /admin/versions/ver_2/end-grants → { grants: 3 } → 'Ended 3 open pages.';
  // DELETE /admin/artifacts/art_1/versions/2; DELETE /admin/artifacts/art_1; PUT /admin/users/usr_b/role { role_override: 'blocked' }
test("refusals show the server's words", …);   // 400 t('moderation.lookup.badUrl'), 404 t('moderation.lookup.unknown'), 410 t('moderation.lookup.gone')
test('the reported address and names render as text', …);   // names '<b>x</b>' literal; the URL is never an href
test('the admin nav reaches all four pages', …);   // Users, Share links, Look up a link, Configuration
// config-spaces.test.tsx
test('configuration explains visibility and sharing, and marks the current ones', …);   // entries personal + approved → both marked current
test('a quota of 0 reads as no limit', …);
test('every new setting has its help line', …);
  // PINWALL_VISIBILITY, _SHARE_LINKS, _QUOTA_BYTES, _QUOTA_ARTIFACTS, _ABUSE_CONTACT, _TERMS_URL, _PRIVACY_URL → t(`web.config.help.${env}`) shown
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/pages/admin/share-links src/pages/admin/lookup src/pages/admin/config-spaces`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/web test`, then `pnpm lint && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add admin share links, look-up of reported links, and the spaces settings explained`.

### Task 8: End to end — acceptance 2, 3 and 9 with the test IdP, and axe on the new pages (model: sonnet)

**Files:**
- Create: `e2e/keycloak/support.ts`, `e2e/keycloak/spaces.spec.ts`
- Modify:
  - Keycloak suite: `e2e/keycloak/realm.json`, `e2e/keycloak/global-setup.ts`, `e2e/keycloak/keycloak.config.ts`;
  - 1.0 specs: `e2e/keycloak/sign-in.spec.ts` (imports only), `e2e/web-shell.spec.ts` (two axe paths).

**Interfaces:**
- Consumes: 1.0 `startPinwall`, `stopPinwall`, `apiCall`, `publishInline` (`e2e/support/*`), the Keycloak users `ada` (in `pinwall-admins`), `bob` and `eve` (all `Example`, emails `<user>@example.test`, passwords `<user>-e2e-password`), and Tasks 1–7's screens.
- Produces:

```ts
// e2e/keycloak/support.ts — moved from sign-in.spec.ts, now taking the origin
export function t(key: keyof typeof messages, vars?: Record<string, string>): string;
export async function keycloakLogin(page: Page, user: string, password: string): Promise<void>;
export async function signInWithKeycloak(page: Page, origin: string, user: 'ada' | 'bob' | 'eve'): Promise<void>;
export async function personIn(browser: Browser, origin: string, user: 'ada' | 'bob' | 'eve'): Promise<{ context: BrowserContext; page: Page }>;   // a fresh context, signed in
export const SPACES_ORIGIN = 'http://localhost:18097';
```

- **The second Pinwall.** The global setup starts it on `18097`, after the team instance on `18096`, and creates its owner the same way.
  - Env: the same OIDC settings, **without** `PINWALL_OIDC_MEMBER_GROUPS` (open sign-up, spec §13), plus `PINWALL_VISIBILITY=personal`, `PINWALL_SHARE_LINKS=approved`, `PINWALL_ABUSE_CONTACT=abuse@example.test`, `PINWALL_TERMS_URL=https://example.test/terms` and `PINWALL_PRIVACY_URL=https://example.test/privacy`.
  - `realm.json` adds `http://localhost:18097/auth/oidc/callback` to `redirectUris`, and `http://localhost:18097/auth/oidc/signed-out` to `post.logout.redirect.uris` (Keycloak separates several with `##`).
- **Config.** `keycloak.config.ts` gets two projects:
  - `team`: `sign-in.spec.ts`, base URL `18096`;
  - `personal`: `spaces.spec.ts`, base URL `18097`.

  Each person runs in their own browser context, because cookies on `localhost` ignore the port.

- [ ] **Step 1: Write the spec** (`test.describe.configure({ mode: 'serial' })`, `test.setTimeout(180_000)`; `axe(page)` as in `web-shell.spec.ts`, expecting no violations).

```ts
test('acceptance 2: a first sign-in gets an empty space and cannot reach another person\'s artifact', …);
  // bob signs in, publishInline({ 'index.html': '<title>Bob plan</title>…' }) → b
  // eve (first sign-in, no group) → '/' shows heading t('web.library.spaceEmptyTitle'); sidebar Recent and Projects lack 'Bob plan'
  // search 'plan' (dialog) → no result; page.goto(`/a/${b}`) → heading t('web.artifact.unavailable') and t('artifact.notFound'),
  //   the same as page.goto('/a/art_00000000000000000000')
  // eve publishInline 'Eve notes' → All artifacts lists exactly ['Eve notes']
  // a signed-out context at /signin shows links 'Terms of use', 'Privacy' and 'abuse@example.test' (D8); axe on /signin and on eve's '/'
test('acceptance 3: approval gates share links, raw links and top-level content', …);
  // eve opens /a/<e>: Share → t('web.share.notApproved.title'), no 'Create link'; More → t('web.review.rawUnavailable') → dialog t('spaces.exposure.rawLink')
  // page.goto(`/a/${e}/raw`) → status 403, text t('spaces.exposure.rawLink')
  // the review iframe's src: page.goto(src) → 403, t('content.framedOnly.title');
  //   context.request.get(src, { headers: { 'sec-fetch-dest': 'iframe' } }) → 200, CSP contains "frame-ancestors 'self' http://localhost:18097"
  // ada → /admin/users → switch 'Eve Example may expose content' on; axe on /admin/users, /admin/share-links, /admin/lookup
  // eve reloads → Share → Create link → URL; a guest context opens it → heading 'Eve notes', link 'Report abuse' (mailto:abuse@example.test);
  //   /a/<e>/raw → redirected to content (200); a fresh review src opened top-level → 200
  // ada → /admin/lookup with the share URL → owner 'Eve Example'; then switch eve off → confirm → the guest reload shows t('share.gone.title')
test('acceptance 9: project members', …);
  // ada approves eve again; bob: 'New project' 'Launch' → publishInline into it ('Launch page') and into a second project 'Q' ('Secret')
  // bob: /projects/<Launch> → Members → add 'eve@example.test' as Viewer → row 'Eve Example'; axe with the dialog open
  // eve: sidebar 'Shared with me' has 'Launch' and 'Bob Example · Viewer'; its page has no 'Upload';
  //   apiCall POST /api/v1/publish/inline into Launch → 403 details.reason 'role'; opens 'Launch page' and comments through the review screen
  //   (comment mode, as live-review.spec.ts does) → the comment shows; axe on eve's '/' with Shared with me
  // bob: Members → eve's role Editor; eve's project page now has 'Upload'; bob's GET /api/v1/me usage.bytes before and after eve's
  //   publishInline into Launch grows by that version's total_bytes (GET /api/v1/artifacts/<id>), and eve's own usage.bytes does not;
  //   axe on bob's /settings/usage
  // eve makes a share link on 'Launch page' and keeps /a/<launch page> open; bob removes eve (confirm)
  //   → within 30 s eve's open tab shows heading t('web.artifact.unavailable'); a guest open of eve's link → t('share.gone.title')
  // eve: /a/<Secret> → t('web.artifact.unavailable') before and after; her sidebar no longer lists 'Launch'
```

- [ ] **Step 2: Run** `pnpm test:e2e:keycloak` (Docker running). Expected: FAIL first in `spaces.spec.ts` until the setup and screens are in place. Fix a screen only through the task that owns it.
- [ ] **Step 3: Implement** `support.ts`, the second instance in the global setup, the realm URIs, the two projects, and the two axe paths in `web-shell.spec.ts`.
- [ ] **Step 4: Run** `pnpm test:e2e:keycloak` and `pnpm test:e2e`. Expected: all pass (the team-mode sign-in walks unchanged; the three spaces walks; no axe violations). Then run `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=2 pnpm test`. Expected: PASS.
- [ ] **Step 5: Commit** `test(e2e): walk acceptance 2, 3 and 9 through the web with Keycloak in personal mode`.

---

## M13 done when

- `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=2 pnpm test` pass. Every 1.0 web test passes, changed only as the Global Constraints allow.
- `pnpm test:e2e` and `pnpm test:e2e:keycloak` pass. Spec acceptance 2, 3 and 9 are walked through the web with Keycloak, and axe finds no WCAG 2.1 AA violation on the new pages.
- Every Review Focus test above passes, and `no-fixed-default.test.ts` passes.
- `git diff <M13 base> -- apps/server` is empty.
