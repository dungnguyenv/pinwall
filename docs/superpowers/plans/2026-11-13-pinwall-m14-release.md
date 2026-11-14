# Pinwall M14 — Docs, Acceptance, Release 1.1.0, Homelab Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Pinwall 1.1.0:
- the operator, user and agent docs for personal spaces;
- spec §11 acceptance items 1–9, each automated or recorded as a manual check;
- the version bump, the final whole-branch review and the signed release, once the owner says so;
- the rollout on `pinwall.happybooth.vn` with the homelab session, in the order of spec §13.

**Architecture:**
- **Docs are the bulk.** Two new pages: `docs/open-instance.md` for operators, and `docs/spaces.md` for the people who use an instance. Every existing page that 1.1 makes wrong gets edited. `tools/test/docs.test.ts` keeps checking links, anchors and `PINWALL_*` names, and gains required-contents checks.
- **Acceptance is wired the 1.0 way.** `tools/src/acceptance.ts` gains items `1.1-1` to `1.1-9`, each pointing at the suites that prove it. One new Playwright spec, `e2e/acceptance/upgrade.spec.ts`, upgrades a real 1.0.0 image in place and restores a 1.0.0 backup into 1.1. `docs/acceptance.md` holds the manual checks for the live instance.
- **Release and rollout reuse 1.0's machinery.** `tools/src/release.ts` and `.github/workflows/release.yml` are unchanged since `v1.0.0`. The last two tasks are manual, and each stops and asks the owner before anything leaves this machine.

**Tech Stack:** unchanged. Markdown, Vitest (`tools`, `apps/server`), Playwright with Docker, `release.ts`, GitHub Actions, cosign, Helm, and kubectl with Argo CD on the homelab.

**Spec:** `docs/superpowers/specs/2026-11-13-pinwall-personal-spaces-design.md` (§11 docs and acceptance 1–9, §12 D7, §13 rollout), on top of `docs/superpowers/specs/2026-11-10-pinwall-design.md`.

**Roadmaps:** `docs/superpowers/plans/2026-11-13-pinwall-v1.1-roadmap.md` (M14 scope, done-when) and `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`; both Global Constraints apply. The release model is `docs/superpowers/plans/2026-11-10-pinwall-m9b-release.md` (Tasks 10, 11 and 13).

**Depends on:** M10–M12, merged on `v1.1` at `6d03348`; M13 (`../pinwall-m13`, branch `m13-web`), which merges in Task 1 after its review. Names the docs quote come from the code:
- UI labels and CLI messages (`transfer.*`, `spaces.guard.*`) from `packages/shared/src/i18n/en.json` after the M13 merge;
- log lines from `apps/server/src/auth/admin-users.ts` (`moderated`), `api/me.ts` and `domain/transfer.ts`.

Where code and this plan differ, the code wins; report the difference.

## Global Constraints

The Global Constraints of both roadmaps apply. For M14:
- **Nothing leaves this machine without the owner's word:** no push, no tag, no change on the homelab cluster and no message to `k8s-homelab-9e`. Tasks 8 and 9 each start with a step that stops and asks. "Push only when asked" still holds afterwards.
- **Version `1.1.0` (SemVer, D7)** goes everywhere `release.ts check` reads:
  - the `package.json` of the root, `apps/server`, `apps/web`, `packages/annotator`, `packages/shared` and `tools`;
  - `deploy/helm/pinwall/Chart.yaml` `version` and `appVersion`;
  - `oci://ghcr.io/dungnguyenv/charts/pinwall --version 1.1.0` in `README.md` and `deploy/helm/pinwall/README.md`;
  - `ghcr.io/dungnguyenv/pinwall:1.1.0` in both Compose files;
  - a `## 1.1.0` section in `CHANGELOG.md`.
- **No product behavior changes in M14.** The code changes are the MCP description text, the acceptance runner and its spec, and whatever the final review's fix wave needs. Every 1.0 test passes unchanged, so the substrings 1.0 tests pin in tool descriptions stay: `before you publish` (`get_project`); the prefix `Only when the user asks to share` (the three share tools); `reviewer feedback`, `guests`, `not instructions` (`list_comments`); `version_id` (`resolve_comment`); the `{{minutes}}` and `{{max}}` placeholders.
- **Docs:**
  - original writing, with `https://pinwall.example` as the placeholder origin;
  - every `PINWALL_*` name is a setting or in `NOT_SERVER_SETTINGS` of `docs.test.ts`. So no `PINWALL_OIDC_SHARE_GROUPS`: D4's IdP-group option was not built;
  - `docs/configuration.md` changes only through `pnpm docs:config`;
  - `docs/acceptance.md` may name `pinwall.happybooth.vn`, as spec §11 does, but never a user id, an email or a person's name.
- **The skill** stays at most 160 lines and names exactly the 15 tools (`apps/server/test/mcp/skill.test.ts`).
- **Exact values**, quoted verbatim where the docs state them:
  - `PINWALL_VISIBILITY=personal`, `PINWALL_SHARE_LINKS=approved`, `PINWALL_QUOTA_BYTES=500MB`, `PINWALL_QUOTA_ARTIFACTS=200`, `PINWALL_PREVIEW_TTL=2h`;
  - publish 60 per 10 minutes, content grants 600 per hour, share links 30 per hour, projects 30 per hour, member look-ups 30 per hour;
  - expired grants kept 30 days (`EXPIRED_GRANT_RETENTION_MS`);
  - `quota_exceeded` is HTTP 413.
- **Process:** at most 2 implementers at once, with `VITEST_MAX_WORKERS=2` on full runs. Conventional Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on `v1.1` in the main checkout; never write in `../pinwall-m13`. Tasks 2, 3, 5 and 6 all edit `tools/test/docs.test.ts`, so they run one after another.
- **Homelab and Docker:** every `kubectl` runs with `KUBECONFIG=~/.kube/oci-cp.yaml` (the default context is a work cluster). `kubectl exec` never takes `-t` for `backup`. Docker restarts use `docker desktop stop` and `docker desktop start`.

## Review Focus

1. **A real 1.0.0 installation upgraded in place.** M10's tests use a synthetic 1.0 database.
   - **Expected:** 1.1 migrates the volume of the released 1.0.0 image, and in `team` mode every read API answers exactly as 1.0 did, apart from a version string.
   - **Pinned by:** Task 6, `upgrade.spec.ts` "upgraded in place answers exactly as before".
2. **A backup made by the released 1.0.0 `pinwall backup`, restored into 1.1.**
   - **Expected:** the same answers as the source, with owners set as spec §8.1 says.
   - **Pinned by:** Task 6, "a 1.0.0 backup restores into 1.1 as if 1.1 had migrated it".
3. **A version mention left at 1.0.0** in a chart README, a Compose file or a `package.json`.
   - **Expected:** `release.ts check v1.1.0` reports no problem before any tag exists.
   - **Pinned by:** Task 5, Step 4.
4. **A doc names a setting or an anchor that does not exist.** For example D4's `PINWALL_OIDC_SHARE_GROUPS`, or a link to `open-instance.md#…` with a wrong slug.
   - **Expected:** `docs.test.ts` fails.
   - **Pinned by:** Tasks 2 and 3. Their required-contents tests name the anchors other pages link to.
5. **An agent that gets refused retries in a loop.** The refusal can be `quota_exceeded`, `forbidden` with reason `role`, or `share_links_not_approved`.
   - **Expected:** the skill tells it to stop and tell the person why.
   - **Pinned by:** Task 4, `skill.test.ts` "the skill handles the space refusals".

The rollout's own failure mode is opening sign-up before the owner's work is private. No test can reach it, so Task 9 gates twice: Step 1 checks that a member rule is in force, and Step 6 runs acceptance 8 and 9 before the member rule goes.

---

### Task 1: Merge M13 into `v1.1` and take the baseline (model: sonnet)

**Files:** none edited; a merge commit on `v1.1`.

**Interfaces:**
- Consumes: branch `m13-web`, reviewed, with its fix wave committed. Its ledger is `.superpowers/sdd/2026-11-13-pinwall-m13-web/progress.md`.
- Produces: `v1.1` holding M10–M13, and a ledger note of M13 Task 8's nested-frame finding, which Task 5 reads. The finding concerns framed-only content in single-domain mode (M12 review M2).

- [ ] **Step 1: Check the precondition.** The M13 ledger says the milestone review is approved and the fix wave is done, and `git -C ../pinwall-m13 status --short` is empty. Otherwise stop and report.
- [ ] **Step 2: Merge.** On `v1.1` in the main checkout, run `git merge --no-ff m13-web -m "Merge branch 'm13-web' (M13 web) into v1.1"`. `m13-web` already contains `6d03348`, so a conflict means `v1.1` moved: stop and report.
- [ ] **Step 3: Verify,** with Docker running. Run `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck`, then `VITEST_MAX_WORKERS=2 pnpm test:integration`, then `pnpm test:e2e && pnpm test:e2e:keycloak`. Expected: all pass, `e2e/keycloak/spaces.spec.ts` included.
- [ ] **Step 4: Record.** Add a ledger line with the merge commit and the nested-frame finding: blocked or working, and in which browsers. Then run `git worktree remove ../pinwall-m13` as 1.0 did with merged worktrees; the branch stays.

### Task 2: Operator docs — open instance, open sign-up, backup, chart, security (model: sonnet)

**Files:**
- Create: `docs/open-instance.md`
- Modify:
  - `docs/sign-in.md`: the section "Open sign-up", and its entry in the list at the top;
  - `docs/install.md`;
  - `docs/backup.md`;
  - `deploy/helm/pinwall/README.md`: one new example only; the `--version` line is Task 5's;
  - `SECURITY.md`;
  - `tools/test/docs.test.ts`.

**Interfaces:**
- Consumes:
  - the catalog texts in `docs/configuration.md`;
  - the `en.json` labels (`Shared with me`, `Members`, `Usage`, `Delete all my content`, `Look up a link`, and the Admin → Users columns and switch);
  - the header's log lines and CLI messages.
- Produces: the anchors other pages link to.
  - `docs/open-instance.md`: `#settings`, `#order-of-operations`, `#quotas-and-rate-limits`, `#who-may-share-outside-pinwall`, `#handling-an-abuse-report`, `#the-moderation-log`, `#moving-work-between-people`, `#a-separate-content-domain`;
  - `docs/sign-in.md#open-sign-up`;
  - `docs/backup.md#restoring-a-10-backup-into-11`.

- [ ] **Step 1: Write the failing tests** in `docs.test.ts`, `describe('required contents')`:

```ts
test('the open-instance guide gives the settings, the order and the abuse workflow', async () => {
  const guide = await readFile(join(ROOT, 'docs/open-instance.md'), 'utf8');
  for (const line of ['PINWALL_VISIBILITY=personal', 'PINWALL_SHARE_LINKS=approved', 'PINWALL_QUOTA_BYTES=500MB',
    'PINWALL_QUOTA_ARTIFACTS=200', 'PINWALL_PREVIEW_TTL=2h', 'PINWALL_ABUSE_CONTACT=', 'pinwall transfer --from'])
    expect(guide, line).toContain(line);
  expect(guide).toMatch(/30 days/);
  const anchors = anchorsOf(guide);
  for (const a of ['settings', 'order-of-operations', 'quotas-and-rate-limits', 'who-may-share-outside-pinwall',
    'handling-an-abuse-report', 'the-moderation-log', 'moving-work-between-people', 'a-separate-content-domain'])
    expect(anchors.has(a), a).toBe(true);
});
test('sign-in has an Open sign-up section with the Zitadel role claim and no member rule', async () => {
  const signIn = await readFile(join(ROOT, 'docs/sign-in.md'), 'utf8');
  expect(anchorsOf(signIn).has('open-sign-up')).toBe(true);
  const section = signIn.slice(signIn.indexOf('## Open sign-up'));
  expect(section).toContain('PINWALL_OIDC_ROLES_CLAIM=urn:zitadel:iam:org:project:roles');
  expect(section).toContain('PINWALL_OIDC_ADMIN_GROUPS=pinwall-admin');
  expect(section).not.toMatch(/^PINWALL_OIDC_MEMBER_GROUPS=/m);
});
test('the backup guide has a section on restoring a 1.0 backup into 1.1', async () => {
  expect(anchorsOf(await readFile(join(ROOT, 'docs/backup.md'), 'utf8')).has('restoring-a-10-backup-into-11')).toBe(true);
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/tools test test/docs`. Expected: FAIL (no `docs/open-instance.md`).
- [ ] **Step 3: Write `docs/open-instance.md`, "Running an open instance",** with one `##` per anchor, in this order:
  - **Settings.**
    - One `sh` block with the five happybooth lines and `PINWALL_ABUSE_CONTACT=abuse@pinwall.example`, plus optional `PINWALL_TERMS_URL` and `PINWALL_PRIVACY_URL` as comments.
    - One line on what each does.
    - The chart takes them under `env:`, and Compose under `environment:`.
    - Link `configuration.md#spaces-and-sharing`.
  - **Order of operations.**
    1. Personal mode, quotas and approval go first, while a member rule still holds.
    2. Existing work is moved and checked.
    3. Only then the member rule goes.

    Link `sign-in.md#open-sign-up`.
  - **Quotas and rate limits.**
    - Admins are exempt, and an admin can override the quota per person in Admin → Users.
    - The count is the logical size of every version (`versions.total_bytes`), each in full, in the projects a person owns, editors' publishes included.
    - Deleting old versions frees space.
    - A refusal is `quota_exceeded` (HTTP 413) and says whose space is full.
    - The fixed rate rules, with the numbers from the Global Constraints.
  - **Who may share outside Pinwall.**
    - With `approved`, a person who is not approved cannot create share links, open raw links or open their pages top-level. Their pages work inside the viewer.
    - **Approve people before switching** (Admin → Users, the "may expose content" switch). Switching stops the links of everyone not yet approved. The check runs at every open, so a link opens again once its maker is approved.
    - Removing approval revokes that person's links for good.
    - Links handed over by a transfer open only if the target is approved.
    - Content URLs are capability URLs, valid for `PINWALL_PREVIEW_TTL` (12 h by default). `2h` shortens how long a leaked one works.
  - **Handling an abuse report.**
    1. Open Admin → Look up a link and paste the URL. It takes a share URL, an `/a/…` link, or a content URL (`/c/<token>/…` or `<token>.<content host>/…`).
    2. Read the answer: the artifact, its owner, the version, and the link or grant.
    3. Act on it: revoke the link, end the version's grants, delete the version or the artifact, block the owner, or "Delete all content" (`personal` mode only, with the email typed).

    Then a paragraph on attribution:
    - expired content grants are kept 30 days, so look-up can still name the owner;
    - that is up to about 430,000 rows (about 65 MB) for a person who sits at the grant limit, 600 an hour for 30 days;
    - after 30 days look-up answers 404;
    - content already revoked or deleted cannot be attributed (410).

    Admins never open private content: the share-link list has no "open", because tokens are stored hashed. The operator, who can read the database, can.
  - **The moderation log.**
    - Lines with message `moderation` carry `admin_id`, `action`, `target` and `outcome` (`done`, `refused` or `failed`), plus `result` when done.
    - The actions are `user.update`, `user.purge`, `share_link.revoke`, `lookup`, `artifact.delete`, `version.delete` and `version.end_grants`.
    - `self.purge` lines carry `user_id`.
    - The CLI writes a `transfer` line.
    - 1.0 already logs `role override changed` and the Revoke now line.

    The logs are the audit trail, since there is no audit table. Keep them as long as reports may arrive.
  - **Moving work between people.**
    - `pinwall transfer --from <id|email> --to <id|email>`, through `docker exec` or `kubectl exec deploy/pinwall --`.
    - An email shared by several accounts is refused with their ids, so pass ids.
    - When both have a default project, the source's becomes "Default (from <name>)".
    - Members stay. Grants of people who lose sight end. Links are handed over to the target.
    - A transfer that races the target's first default project fails and moves nothing: run it again.
    - Going back to `team` needs `pinwall visibility team --confirm`; quote the `spaces.guard.refused` text.
    - There is no transfer in the app, by design.
  - **A separate content domain.**
    - Strangers' HTML on the app's own registrable domain puts the app's reputation and its people at risk: phishing, blocklists and cookie scope.
    - A content domain holds nothing else, so blocklisting it does not take the app down. Link `install.md#content-isolation`.
    - Prefer PostgreSQL for an open instance; SECURITY.md explains SQLite search ranking.
- [ ] **Step 4: Write `docs/sign-in.md` "Open sign-up",** after Google.
  - **The intro:**
    - With no member group, email or domain rule, everyone the provider signs in is a member.
    - Use that only with `PINWALL_VISIBILITY=personal`. In `team` mode Pinwall logs a startup warning, since everyone would see everything.
    - A person whose token has no roles claim is admitted as a member, and the re-check does not count a missing claim as a removal.
    - The "no roles claim" warning appears only when a member group rule exists.
  - **`### Zitadel with Google`:**
    - an organization whose login policy allows Google only;
    - the project roles, with "Assert Roles on Authentication";
    - the scope `urn:zitadel:iam:org:id:<organization id>`, which keeps sign-in to that organization;
    - optionally `urn:zitadel:iam:org:idp:id:<Google IdP id>`, which goes straight to Google;
    - an `sh` block with `PINWALL_OIDC_ISSUER`, `PINWALL_OIDC_CLIENT_ID`, `PINWALL_OIDC_SCOPES`, `PINWALL_OIDC_ROLES_CLAIM=urn:zitadel:iam:org:project:roles` and `PINWALL_OIDC_ADMIN_GROUPS=pinwall-admin`, and no member line.
  - **`### Google directly`:** the Google recipe with `PINWALL_ADMIN_EMAILS` only.
  - **`### Order of operations`,** spec §13 for any instance:
    1. Deploy 1.1 in personal mode while the member rule holds.
    2. Move existing work with `pinwall transfer`, and check that a second account sees none of it.
    3. Remove the member rule.

    Removing the rule first exposes everything.
- [ ] **Step 5: The rest.**
  - **`docs/backup.md`**, a section `## Restoring a 1.0 backup into 1.1`:
    - such a restore gives each project its owner exactly as the migration does;
    - archives now also hold project members and instance settings;
    - a 1.1 archive does not restore into 1.0.
  - **The chart README:** an example "An open instance" with an `env:` block of the five settings and `PINWALL_ABUSE_CONTACT`, linking `../../../docs/open-instance.md`.
  - **`SECURITY.md`:**
    - **The model:** private spaces in `personal` mode, where another person's id answers like a missing one. Admins of the app cannot read private work, the operator can, and transfer is CLI-only.
    - **Rewrite** the by-design sentence "every member can open every artifact…", which now holds in `team` mode only.
    - **Add as by-design:** SQLite FTS5 `bm25` uses whole-index statistics, so other spaces' text can change the order, never the membership, of a person's results. Only aggregate term frequency and document length leak. PostgreSQL ranking does not depend on other documents.
    - **Add as by-design:** expired grants are kept 30 days for attribution.
  - **`docs/install.md`:** one paragraph under "Content isolation" linking `open-instance.md#a-separate-content-domain`.

  Run `pnpm docs:config`. Expected: `git diff --exit-code docs/configuration.md` is clean, because the catalog texts are already there and `catalog.test.ts` checks them.
- [ ] **Step 6: Run** `pnpm --filter @pinwall/tools test test/docs && pnpm lint`. Expected: PASS.
- [ ] **Step 7: Commit** `docs: add the open-instance guide and open sign-up, and update backup, chart and security for 1.1`.

### Task 3: People docs — spaces and members guide, README, authoring, connecting an agent (model: sonnet)

**Files:**
- Create: `docs/spaces.md`
- Modify:
  - `README.md`: Features, the Documentation table and the FAQ; not the `--version` line;
  - `docs/authoring.md`, `docs/connect-an-agent.md`;
  - `tools/test/docs.test.ts`.

**Interfaces:**
- Consumes:
  - Task 2's anchors;
  - the M13 labels: `Shared with me`, `{{owner}} · {{role}}`, `Members`, `Leave project`, `Usage`, `Delete all my content`;
  - spec §4.3's role table;
  - the M11 ruling that demoting an editor to viewer revokes the links they made in the project.
- Produces: `docs/spaces.md#your-space`, `#shared-with-me`, `#project-members`, `#sharing-outside-pinwall`, `#usage-and-limits`, `#delete-all-my-content`.

- [ ] **Step 1: Write the failing test** in `docs.test.ts`:

```ts
test('the spaces guide covers members, sharing and usage, and the README links both new guides', async () => {
  const anchors = anchorsOf(await readFile(join(ROOT, 'docs/spaces.md'), 'utf8'));
  for (const a of ['your-space', 'shared-with-me', 'project-members', 'sharing-outside-pinwall', 'usage-and-limits', 'delete-all-my-content'])
    expect(anchors.has(a), a).toBe(true);
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
  expect(readme).toContain('](docs/spaces.md');
  expect(readme).toContain('](docs/open-instance.md');
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/tools test test/docs`. Expected: FAIL.
- [ ] **Step 3: Write `docs/spaces.md`, "Spaces, projects and members".** It opens by saying it applies with `PINWALL_VISIBILITY=personal`; in `team` mode everyone sees everything, as in 1.0.
  - **Your space:** private by default. Your own "Default" project. "All artifacts" means everything you can see.
  - **Shared with me:** the sidebar group, with each owner and your role.
  - **Project members.**
    - Add someone by the email of an account that has signed in once; otherwise ask them to sign in first.
    - When several accounts share the email, pick one by name and sign-in method.
    - A short owner, editor and viewer table, condensed from spec §4.3.
    - Change a role, remove someone, or leave.
    - On removal, their open tab loses the content and their stream ends. Links they made in the project stop working, and their comments stay.
    - Demoting an editor to viewer also revokes the links they made there.
    - Only the owner manages members and the project's instructions.
  - **Sharing outside Pinwall.**
    - Share links work as in 1.0.
    - Where approval is required, the share dialog explains why, "Open original" is unavailable, and pages open only in the viewer until an admin approves you.
    - Link `open-instance.md#who-may-share-outside-pinwall`.
  - **Usage and limits.**
    - Settings → Usage.
    - Every version counts in full, in projects you own, editors' publishes included.
    - Deleting versions frees space.
    - Agents see the same numbers through `whoami`.
  - **Delete all my content.**
    - You confirm by typing your email, or the account id when there is no email.
    - What goes.
    - The account stays, and the identity provider's account is untouched.
  - **Who can see your work:** admins cannot browse it; the installation's operator can, as with any self-hosted service.
- [ ] **Step 4: The rest.**
  - **README:**
    - **Features:** under "Sharing and access", emoji bullets for personal spaces, project members, and approval with quotas and moderation for open sign-up.
    - **Documentation:** rows for both new guides.
    - **New FAQ entries:** "Can other people on my Pinwall see my work?"; "Can I let anyone with a Google account sign up?" (yes, in personal mode; link both guides); "Can an admin read my private pages?"; "How do I work on a project with someone?"; "Does upgrading from 1.0 change what people see?" (no: `team` stays the default).
    - **The FAQ on several Claude Code accounts** now says that every machine signed in to the same account sees the same artifacts, and in `team` mode every member does.
  - **`docs/authoring.md`:**
    - "Size and file limits" names the per-person quota (`PINWALL_QUOTA_BYTES`, `PINWALL_QUOTA_ARTIFACTS`);
    - one paragraph: where approval is required, a page of someone not yet approved opens only inside the viewer, and its own nested frames work. If Task 1 recorded them blocked in single-domain mode, say so instead.
  - **`docs/connect-an-agent.md`:**
    - one paragraph after the intro: the agent sees your projects and those shared with you;
    - three Troubleshooting entries: the space is full (`quota_exceeded`), the agent cannot publish into a project (viewer), and the agent cannot make a share link (approval).
- [ ] **Step 5: Run** `pnpm --filter @pinwall/tools test test/docs && pnpm lint`. Expected: PASS.
- [ ] **Step 6: Commit** `docs: add the spaces and members guide and update the README, authoring and agent guides`.

### Task 4: Agent wording — MCP tool descriptions and the skill (model: sonnet)

Independent of M13. It may run before Task 1 or beside Task 2, since its files are disjoint from theirs.

**Files:**
- Modify: `apps/server/src/mcp/descriptions.ts`, `skills/pinwall/SKILL.md`, `apps/server/test/mcp/skill.test.ts`
- Create: `apps/server/test/mcp/descriptions.test.ts`

**Interfaces:**
- Consumes:
  - `whoami`'s 1.1 fields in `mcp/schemas.ts`: `visibility`, `usage`, `quota`, `can_create_share_links`;
  - the MCP error text from `mcp/results.ts`: the message, `mcp.hint.<code>`, and the details as JSON;
  - `mcp.hint.quota_exceeded`;
  - `forbidden` with `details.reason` `'role'` or `'share_links_not_approved'`.
- Produces: `DESCRIPTIONS`, with the same keys and placeholders.

- [ ] **Step 1: Write the failing tests.** `descriptions.test.ts` imports `DESCRIPTIONS`:

```ts
test('whoami names usage, quota and whether links may be made', () => {
  const d = DESCRIPTIONS.whoami.description;
  expect(d).toMatch(/usage/i); expect(d).toMatch(/quota/i); expect(d).toMatch(/share links/i);
});
test('revoke_share_link states the 1.1 rule and the 1.0 one', () => {
  const d = DESCRIPTIONS.revoke_share_link.description;
  expect(d.startsWith('Only when the user asks to share')).toBe(true);
  expect(d).toMatch(/project's owner/); expect(d).toMatch(/editor/); expect(d).toMatch(/admin/);
});
test('list and search speak of what the account can see', () => {
  expect(DESCRIPTIONS.list_projects.description).toMatch(/shared with you/);
  expect(DESCRIPTIONS.list_projects.description).toMatch(/your role/);
  expect(DESCRIPTIONS.list_artifacts.description).toMatch(/you can see/);
  expect(DESCRIPTIONS.search_artifacts.description).toMatch(/you can see/);
});
test('create_share_link warns that an admin may have to approve the account', () => {
  expect(DESCRIPTIONS.create_share_link.description).toMatch(/approv/);
});
test('publishing without a target goes to your default project', () => {
  expect(DESCRIPTIONS.create_publish_session.description).toMatch(/your default project/);
});
```

  In `skill.test.ts`:

```ts
test('the skill handles the space refusals', () => {
  for (const s of ['quota_exceeded', 'share_links_not_approved', 'shared with you', 'viewer'])
    expect(skill, s).toContain(s);
  expect(skill).toMatch(/do not retry/i);
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server exec vitest run test/mcp/descriptions test/mcp/skill`. Expected: FAIL.
- [ ] **Step 3: Reword the descriptions.** Each must be true in both modes.
  - **`whoami`** adds that, with personal spaces, it reports the space's usage and quota, and whether this account may create share links. Call it before a large publish.
  - **`list_projects`:** the projects you can see. With personal spaces that means your own and those shared with you, with your role in each; otherwise every project.
  - **`get_project`:** "Without project_id it reads your default project."
  - **`create_project`:** creates it in your space.
  - **`list_artifacts` and `search_artifacts`:** "artifacts you can see".
  - **The two publish tools:** "or in your default project". With personal spaces, viewers cannot publish.
  - **`create_share_link`** adds: viewers cannot make links, and on some Pinwalls an admin must approve the account first. A refusal is final; tell the user.
  - **`revoke_share_link`:** with personal spaces, the project's owner may revoke any link on its artifacts, and an editor the links they made. Otherwise the link's creator, the artifact's publisher or an admin.
- [ ] **Step 4: Edit the skill,** keeping it at 160 lines or fewer, so at most 26 lines more:
  - **§2:** `whoami` also gives usage, quota and `can_create_share_links`. `list_projects` lists your projects and those shared with you, with your role. As a viewer you read and comment, but you do not publish or share.
  - **§4, two new refusals:**
    - `quota_exceeded`: do not retry; tell the person that their space, or the project owner's, is full;
    - `forbidden` with reason `role`: you are a viewer; the user can ask the owner.
  - **§7:** `forbidden` with `share_links_not_approved`: an admin must approve the account; do not retry.
  - **§8:** the lines for `whoami` and `list_projects`.
- [ ] **Step 5: Run** `pnpm --filter @pinwall/server exec vitest run test/mcp` and `pnpm --filter @pinwall/web test src/pages/connect` (the web embeds `SKILL.md`). Expected: PASS, with the 1.0 MCP tests unchanged.
- [ ] **Step 6: Commit** `docs(mcp): describe the tools and the skill for personal spaces, quotas and approval`.

### Task 5: CHANGELOG 1.1.0, known limitations and version 1.1.0 (model: sonnet)

**Files:**
- Modify:
  - `CHANGELOG.md`;
  - the six `package.json` files of the Global Constraints;
  - `deploy/helm/pinwall/Chart.yaml`;
  - `README.md` and `deploy/helm/pinwall/README.md` (the `--version` line only);
  - `deploy/compose/docker-compose.yml` and `deploy/compose/docker-compose.postgres-s3.yml` (the image tag only);
  - `tools/test/docs.test.ts`.

**Interfaces:**
- Consumes:
  - `release.ts check` and `releaseNotes`, unchanged. `releaseNotes` publishes the `## 1.1.0` section verbatim as the GitHub release body;
  - Task 1's nested-frame finding.
- Produces: version `1.1.0` everywhere `checkVersions` reads, and `## 1.1.0` above `## 1.0.0` in `CHANGELOG.md`.

- [ ] **Step 1: Write the failing test** in `docs.test.ts`; keep the 1.0.0 test.

```ts
test('the changelog has a 1.1.0 section above 1.0.0, with the upgrade note and the new commands', async () => {
  const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const start = changelog.search(/^## 1\.1\.0$/m);
  const end = changelog.search(/^## 1\.0\.0$/m);
  expect(start).toBeGreaterThan(-1); expect(start).toBeLessThan(end);
  const section = changelog.slice(start, end);
  for (const s of ['PINWALL_VISIBILITY', 'pinwall transfer', 'pinwall visibility team --confirm', '### Known limitations'])
    expect(section, s).toContain(s);
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/tools test test/docs`. Expected: FAIL.
- [ ] **Step 3: Write `## 1.1.0`** in original wording.
  - **`### Upgrading from 1.0`** comes first.
    - Nothing changes for members until the operator sets `PINWALL_VISIBILITY=personal`. `team` stays the default.
    - Migration `0003` runs at start and gives every project an owner. 1.0 backups restore into 1.1.
    - The new per-person rate limits apply in both modes.
    - To switch, set `personal` and move whole spaces with `pinwall transfer --from <user> --to <user>`. What members published into someone else's project stays with that project's owner.
    - Going back to `team` after `personal` is refused until `pinwall visibility team --confirm`.
    - Link both new guides.
  - **`### Added`:** personal spaces and project members; approval to share outside Pinwall; quotas; the admin additions (usage, approval, quota overrides, Delete all content, Share links, Look up a link); Delete all my content; the abuse contact, terms and privacy links; `whoami` usage, quota and link permission; the two CLI commands.
  - **`### Changed`:** the publish limit (60 per 10 minutes) counts every publish path; new limits for content grants, share links, projects and member look-ups; a startup warning for `team` mode with open admission; the "no roles claim" warning only with a member group rule; expired content grants kept 30 days; the MCP descriptions and the skill speak of your projects.
  - **`### Known limitations`**, one bullet each:
    - Other JSON routes answer 500, without a crash, when a chunked request body breaks off; sending it again works. An inline publish answers 400.
    - Delete all my content (`/me/purge`) writes its `moderation` log line before it runs, with no outcome.
    - SQLite search ranking (FTS5) uses whole-index statistics, so text in other spaces can change the order, never the membership, of a person's results. PostgreSQL is unaffected.
    - Only if Task 1 recorded it: in single-domain mode, the nested frames of a page whose owner is not approved do not load. Content-domain mode is unaffected, and approval lifts it. If so, say it in `docs/authoring.md` and `docs/open-instance.md#a-separate-content-domain` too.
- [ ] **Step 4: Bump the version** in each file listed. Leave `values.yaml` `image.digest` empty, since the release workflow sets it.
  - `pnpm install --frozen-lockfile`. Expected: the lockfile is unchanged.
  - `pnpm --filter @pinwall/tools exec tsx src/release.ts check v1.1.0`. Expected: `v1.1.0: every version is 1.1.0, and CHANGELOG.md has its section`.
  - `pnpm build && node apps/server/dist/main.mjs version`. Expected: `1.1.0`.
  - `pnpm chart:check`. Expected: pass.
  - `… release.ts notes v1.1.0 sha256:$(printf 0%.0s {1..64}) --out "$(mktemp)"`. Expected: the 1.1.0 section, then the image section.
- [ ] **Step 5: Run** `pnpm --filter @pinwall/tools test && pnpm lint`. Expected: PASS.
- [ ] **Step 6: Commit** `chore(release): set version 1.1.0 and write the 1.1.0 changelog`.

### Task 6: Acceptance for 1.1 — runner items, upgrade spec, checklist (model: opus)

**Files:**
- Create: `e2e/acceptance/upgrade.spec.ts`
- Modify:
  - `tools/src/acceptance.ts`;
  - `tools/test/acceptance.test.ts`;
  - `docs/acceptance.md`;
  - `tools/test/docs.test.ts`: `NOT_SERVER_SETTINGS` gains `PINWALL_ACCEPTANCE_UPGRADE_FROM`.

**Interfaces:**
- Consumes:
  - `runImage`, `removeContainers` (`e2e/support/docker.ts`);
  - `setupAndSignIn`, `signIn`, `publishSite`, `apiClient` (`e2e/support/node-api.ts`);
  - the server suites below;
  - M13's `pnpm test:e2e:keycloak`, whose `spaces.spec.ts` walks acceptance 2, 3 and 9 through the web.
- Produces:

```ts
// tools/src/acceptance.ts
export type ItemId = '1' | '2' | '3' | '3a' | '3b' | '4' | '5' | '6' | '7' | '8' | '9' | '10'
  | '1.1-1' | '1.1-2' | '1.1-3' | '1.1-4' | '1.1-5' | '1.1-6' | '1.1-7' | '1.1-8' | '1.1-9';
// ITEMS: the twelve 1.0 items unchanged, then the nine 1.1 items in spec §11 order. renderReport keeps its shape.
```

  New constants, built with the existing `serverSuite`. Every filter is written in full, because `pathsOf` checks that `<filter>.test.ts` exists.

  | Constant | Label | Filters |
  | --- | --- | --- |
  | `IDOR` | `IDOR suite, team and personal` | `test/spaces/idor-rest`, `test/spaces/idor-mcp`, `test/spaces/idor-sse`, `test/spaces/idor-content`, `test/spaces/idor-publish`, `test/spaces/idor-members`, `test/spaces/search`, `test/spaces/scope-guard` |
  | `OPEN_SIGN_UP` | `open sign-up` | `test/auth/oidc/policy`, `test/spaces/warnings`, `test/spaces/projects` |
  | `EXPOSURE` | `exposure approval` | `test/moderation/exposure`, `test/moderation/framed-only` |
  | `MODERATION` | `admin tools and transfer` | `test/moderation/admin-users`, `test/moderation/admin-moderation`, `test/moderation/purge`, `test/moderation/transfer`, `test/moderation/transfer-cli` |
  | `QUOTA` | `quotas` | `test/moderation/quota` |
  | `UPGRADE` | `1.0 data in 1.1` | `test/spaces/migration`, `test/spaces/restore-v10` |
  | `GUARD` | `visibility guard` | `test/spaces/visibility`, `test/spaces/visibility-cli` |
  | `MEMBERS` | `project members` | `test/spaces/members-acceptance`, `test/spaces/members-removal` |

  | Item | Title | Automated | Manual |
  | --- | --- | --- | --- |
  | `1.1-1` | the IDOR suite passes in both modes on every surface | `IDOR` | — |
  | `1.1-2` | a first Google sign-in gets an empty space and sees only its own work | `OPEN_SIGN_UP`, `IDOR`, `KEYCLOAK` | `open-sign-up` |
  | `1.1-3` | without approval no link, no raw link, no top-level content; links gone when approval goes | `EXPOSURE`, `MODERATION`, `KEYCLOAK` | — |
  | `1.1-4` | a publish over the quota is refused on every path, leaving nothing | `QUOTA` | — |
  | `1.1-5` | usage, transfer, delete all content, share-link list and look-up; no admin route reads or moves a space | `MODERATION`, `KEYCLOAK` | — |
  | `1.1-6` | a 1.0 database and a 1.0 backup behave as 1.0 in team mode, and get owners in personal mode | `UPGRADE`, `ACCEPTANCE_SPECS` | — |
  | `1.1-7` | personal to team is refused until `pinwall visibility team --confirm` | `GUARD` | — |
  | `1.1-8` | on pinwall.happybooth.vn, after the transfer, the owner sees all 4 artifacts and a second account none | `MODERATION` | `owner-instance` |
  | `1.1-9` | project members as viewer, editor and after removal, and nothing beyond that project | `MEMBERS`, `KEYCLOAK` | `members-live` |

- [ ] **Step 1: Update the runner tests** in `acceptance.test.ts`.
  - **The id list:** the 21 ids, in order.
  - **The brief's manual slugs:** add `open-sign-up`, `owner-instance` and `members-live`.
  - **"every test file and config a command names exists":** the expected set gains each new filter as `apps/server/<filter>.test.ts`.
  - **"items that share a command share it exactly":** the six 1.0 commands, then `IDOR`, `OPEN_SIGN_UP`, `EXPOSURE`, `MODERATION`, `QUOTA`, `UPGRADE`, `GUARD`, `MEMBERS`. `byLine('1.1-6')` is the `UPGRADE` line, then the Playwright line.
  - **"the Playwright acceptance suite holds …":** add `upgrade.spec.ts`.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/tools test test/acceptance`. Expected: FAIL.
- [ ] **Step 3: Write `upgrade.spec.ts`.**
  - **Setup:** serial, on ports `18122` and `18123`, with volumes `pinwall-acc-up-<random>` and `pinwall-acc-rs-<random>`, all removed in `afterAll`.
  - **The image under test:** `PINWALL_ACCEPTANCE_IMAGE`, by default `pinwall:acceptance`.
  - **The image it upgrades from:** `PINWALL_ACCEPTANCE_UPGRADE_FROM`, by default `ghcr.io/dungnguyenv/pinwall@sha256:6cc968c9702bbf676fbd049cca63980c8dfc21b7df90f9c74d4e88cd2592e68b`, the v1.0.0 index. Confirm the digest with `docker buildx imagetools inspect ghcr.io/dungnguyenv/pinwall:1.0.0`.
  - **Pulling:** `runImage` runs with `--pull never`, so `beforeAll` pulls the 1.0.0 image when `docker image inspect` fails.

```ts
type Snapshot = { config: unknown; me: unknown; projects: unknown; artifacts: unknown;
  versions: Record<string, unknown>; threads: Record<string, unknown>; files: Record<string, string>; search: string[] };
async function snapshot(api: Api): Promise<Snapshot>;
  // GET /api/v1/config/public (minus the server's version string if it has one, nothing else), /me, /projects, /artifacts;
  // per artifact /versions and /comments; sha256 of every file of every version through /a/:id/v/:n/raw (follow the grant);
  // ids of GET /api/v1/artifacts?q=chup%20anh. Every snapshot reads in the same order, so view-dependent fields match.

test('1.1-6: a 1.0.0 installation upgraded in place answers exactly as before in team mode', …);
  // A = runImage(upgradeFrom, volume up) → setupAndSignIn → project 'Ảnh' → site v1 + v2 ('Dịch vụ chụp ảnh', img/photo.png),
  // a second artifact in the default project, a thread with a reply on v1, a password share link → s0 = snapshot;
  // tar = A.exec(['pinwall','backup','--out','-']).stdout (exit 0); A.stop()
  // B = runImage(image, volume up) → its log has the migration line → signIn → expect(snapshot).toEqual(s0);
  // the share link asks for its password, then serves the page; B.stop()
test('1.1-6: a 1.0.0 backup restores into 1.1 as if 1.1 had migrated it', …);
  // C = runImage(image, volume rs), no setup → C.exec(['pinwall','restore','--in','-'], { stdin: tar }) exit 0, stderr 'restore complete'
  // → signIn → expect(snapshot).toEqual(s0); C.stop()
test('1.1-6: switching the upgraded installation to personal gives each project to its owner', …);
  // runImage(image, volume up, env { PINWALL_VISIBILITY: 'personal' }) → signIn → config.visibility 'personal';
  // every project has owner.id === me.id and role 'owner'; GET /artifacts lists the ids of s0
```

  Any other difference between snapshots is a defect against the roadmap's "1.0 shape and content" constraint. Report it; do not normalize it away.
- [ ] **Step 4: Edit `docs/acceptance.md`.**
  - **The intro** names both specs.
  - **New section `## Before tagging 1.1.0`:**
    1. every automated suite at the candidate (Task 7);
    2. [claude-code](#claude-code) on a 1.1.0 image in `personal` mode (Task 7);
    3. the manual parts of 1.1-2, 1.1-8 and 1.1-9, which run on `pinwall.happybooth.vn` after the release in spec §13 order (Task 9). The suites prove those items before the tag.
  - **"The automated part"** gains a 1.1 table with the same columns, naming the test files. It notes that CI runs every 1.0 test unchanged in `team` mode, which completes 1.1-6.
  - **"Results"** gains the rows `open-sign-up | 1.1-2`, `owner-instance | 1.1-8` and `members-live | 1.1-9`, each "not run yet".
  - **New sections,** each with exact steps and expected results:
    - **`open-sign-up`:**
      1. In a private window, sign in with a Google account that has no Pinwall role. Expected: the empty library with its three ways to start.
      2. In a scratch folder, run `claude mcp add --transport http pinwall-acceptance <origin>/mcp` and authenticate as that account.
      3. Have Claude Code publish a one-page site. Expected: a review link.
      4. Check what the account can see. Expected:
         - "All artifacts" lists only that page;
         - searching for words of the owner's artifacts finds nothing;
         - `/a/<owner artifact id>` shows the not-found page;
         - MCP `list_artifacts` and `search_artifacts` return only its own page.
      5. Clean up with `claude mcp remove pinwall-acceptance` and Delete all my content.
    - **`owner-instance`:**
      - the owner's OIDC account sees the 4 artifacts in two projects: in the web, in search, and through its Claude Code `list_artifacts`;
      - the local Owner account sees an empty library;
      - a second Google account sees none of them in lists, search or MCP, and `/a/<id>` answers not found.
    - **`members-live`:**
      1. The owner creates the project "Acceptance 1.1" and publishes a page in it.
      2. The owner adds the second account as Viewer. Expected: it sees only that project, under Shared with me. It can comment, but it has no Upload, and an MCP publish into the project is refused with reason `role`.
      3. The owner makes it Editor, and it publishes. Expected: the owner's Settings → Usage grows by that version's size, and the second account's does not.
      4. An admin approves it, and it makes a share link and keeps the artifact open. Then the owner removes it. Expected: within 25 s the tab shows the unavailable state, and the link answers gone.
      5. At every step, the owner's other projects stay not found for it.
      6. Clean up: remove the approval, and delete the project.
- [ ] **Step 5: Run.**
  1. `pnpm --filter @pinwall/tools test`. Expected: PASS.
  2. `pnpm exec playwright test -c e2e/acceptance.config.ts upgrade`. Expected: 3 passed.
  3. `pnpm test:acceptance`, with Docker running, the test stack up (`docker compose -f docker-compose.test.yml up -d --wait`) and the `PINWALL_TEST_*` env of `test:integration` set. Expected: every automated line `pass`.

  Paste the report table in the commit body. Fix a failure in the milestone that owns the behavior; never weaken a check.
- [ ] **Step 6: Commit** `test: add the 1.1 acceptance items, a real 1.0.0 upgrade spec and the live checks`.

### Task 7: Final whole-branch review and candidate verification (model: opus)

This review is also M14's milestone review: one review per milestone, as ruled for v1.1.

**Files:**
- Create: `.superpowers/sdd/2026-11-13-pinwall-m14-release/` with `progress.md` and the reviewer's `final-review-v1.1-report.md`.
- Modify: `docs/acceptance.md` (the run records), and whatever the fix wave changes.

**Interfaces:**
- Consumes: `v1.1` after Tasks 1–6, and the tag `v1.0.0` (`027decd`) as the base.
- Produces: a candidate commit on `v1.1` with every suite green, recorded in `docs/acceptance.md`.

- [ ] **Step 1: Dispatch the reviewer** (Opus, read-only) on `git diff v1.0.0..v1.1`, with this checklist:
  1. Every row of the roadmap's "Access inventory": its 1.1 rule in the code, and an IDOR case for it in both modes.
  2. The spec §15 anti-goals, one by one.
  3. `team` mode is 1.0: every edit to a 1.0 test file (`git diff v1.0.0..v1.1 --stat -- '*.test.ts' '*.test.tsx' 'e2e/'`), each with the ledger ruling that allowed it.
  4. The `SYSTEM_SCOPE` allow-list, and that no admin route moves a space.
  5. Docs against code: settings, labels, CLI messages, log fields and rate numbers.
  6. The deferred items in `.superpowers/sdd/deferred.md` and the v1.1 ledgers, marking any that must be fixed before 1.1.0.
  7. Release readiness: `release.ts check v1.1.0`, the CHANGELOG, and acceptance.

  Output: Critical, Important and Minor findings, and a verdict.
- [ ] **Step 2: Fix wave** (Opus, on `v1.1`).
  - Fix the Critical and Important findings, and the deferred items marked "before 1.1.0".
  - Each fix gets a test, and docs follow any change in behavior.
  - Minors go to `deferred.md` with a ruling.
- [ ] **Step 3: Verify the candidate,** with Docker and the test stack running. Each command must pass:
  - `pnpm lint && pnpm typecheck && VITEST_MAX_WORKERS=2 pnpm test:integration`;
  - `pnpm test:e2e && pnpm test:e2e:keycloak && pnpm test:acceptance`;
  - `pnpm licenses:check && pnpm chart:check && actionlint`;
  - `pnpm --filter @pinwall/tools exec tsx src/release.ts check v1.1.0`.
- [ ] **Step 4: Run Claude Code against a 1.1.0 image.**
  - Build `docker build -t pinwall:1.1.0-candidate .`.
  - Run it with `--read-only --tmpfs /tmp --cap-drop ALL`, `PINWALL_VISIBILITY=personal` and `PINWALL_SHARE_LINKS=approved`.
  - Do the [claude-code](../../../docs/acceptance.md#claude-code) check.

  Expected: the review link comes back. `whoami` shows usage and `can_create_share_links: false` for an account that is not approved. The log holds no token and no upload URL.
- [ ] **Step 5: Record and commit.**
  - Add an "Automated runs" row: date, candidate commit, what ran, controller, result.
  - Add a Results row for claude-code on 1.1.0.
  - Commit `docs: record the 1.1.0 candidate runs`.

### Task 8: Merge into `main` and release 1.1.0 (manual, with the owner)

**Interfaces:**
- Consumes: the verified candidate. `release.yml` builds only from a tag on the default branch or on `release/<major>.<minor>`.
- Produces: the GitHub release `v1.1.0`, and the image index digest `D` that Task 9 deploys.

- [ ] **Step 1: Merge locally.** On `main`, run `git merge --ff-only v1.1`; `v1.1` was cut from `main`'s head, `2668d04`. If `main` has moved, run `git merge --no-ff v1.1` and rerun Task 7 Step 3.
- [ ] **Step 2: STOP and ask the owner,** in Vietnamese, in one message:
  - the final review's verdict, the candidate commit and the suite results;
  - may we push `main`? CI runs on it;
  - then may we push the tag `v1.1.0`? It starts `release.yml`, which publishes the signed image, the chart on GHCR and the GitHub release;
  - would they rather rehearse with `v1.1.0-rc.1` on `release/1.1` first? It is not needed by default, because the workflow and tools are unchanged since 1.0.0 ran green;
  - Task 9 Step 1's questions.

  Wait for the answer, and do nothing else meanwhile.
- [ ] **Step 3: Push `main`.** Run `git push origin main`, then `gh run watch` the CI run. Expected: every job green. A red job stops the release: fix it on `v1.1`, merge, and ask again.
- [ ] **Step 4: Tag.** Run `git tag -a v1.1.0 -m "Pinwall 1.1.0"` (annotated, like `v1.0.0`) and `git push origin v1.1.0`, then `gh run watch` the release run. Expected: `verify`, `test`, `image`, `chart` and `release` are green.
- [ ] **Step 5: Verify the release.**
  - `docker buildx imagetools inspect ghcr.io/dungnguyenv/pinwall:1.1.0` gives `D`. The tags `1.1`, `1` and `latest` point at `D`.
  - `cosign verify ghcr.io/dungnguyenv/pinwall@D --certificate-identity https://github.com/dungnguyenv/pinwall/.github/workflows/release.yml@refs/tags/v1.1.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com` verifies.
  - `gh attestation verify oci://ghcr.io/dungnguyenv/pinwall@D --repo dungnguyenv/pinwall` verifies.
  - `helm show values oci://ghcr.io/dungnguyenv/charts/pinwall --version 1.1.0` shows `digest: D`.
  - `docker run --rm ghcr.io/dungnguyenv/pinwall:1.1.0 version` prints `1.1.0`.
- [ ] **Step 6: Record.** Add an "Automated runs" row for the release and these checks. Commit `docs: record the 1.1.0 release` on `main`, and push it only with the next push the owner allows.

### Task 9: Rollout on `pinwall.happybooth.vn` (manual, with the owner)

**Interfaces:**
- Consumes: `D` from Task 8; the homelab session `k8s-homelab-9e`, which owns `infra/argocd/apps/pinwall.yaml` in `k8s-homelab/k8s-cluster` and the Zitadel config; the Argo apps `pinwall-app` (OCI chart, manual sync) and `pinwall`; namespace `pinwall` and CNPG database `pinwall`; the local Owner `usr_jbhbf9fhf1z9e4rf09yh` and the owner's OIDC account `usr_wzxa74rpvwajs1m9hyke`.
- Produces: 1.1.0 live in `personal` mode with the owner's 4 artifacts in their OIDC account's space; open sign-up; the Results rows for `owner-instance`, `members-live` and `open-sign-up`.

- [ ] **Step 1: Ask the owner,** in Task 8 Step 2's message:
  - the value of `PINWALL_ABUSE_CONTACT`, an email or an https URL;
  - whether to set `PINWALL_TERMS_URL` and `PINWALL_PRIVACY_URL`, and to what;
  - which second Google account to use.

  Then read the live values with `KUBECONFIG=~/.kube/oci-cp.yaml kubectl -n argocd get app pinwall-app -o jsonpath='{.spec.source.helm.values}'`. Expected: chart `1.0.0`, and a member rule set (`PINWALL_OIDC_MEMBER_GROUPS`, or member emails). With no member rule, stop and tell the owner: the instance is already open.
- [ ] **Step 2: Back up 1.0.0.**
  - `mkdir -p ~/Backups/pinwall`, then `KUBECONFIG=~/.kube/oci-cp.yaml kubectl -n pinwall exec deploy/pinwall -- pinwall backup --out - > ~/Backups/pinwall/pinwall-1.0.0-$(date +%F-%H%M).tar`.
  - Check it: `tar -tf <file> | head -1` gives `manifest.json`, and the file is about 13 MB or more.
  - Ask the owner not to publish until Step 4 is done.
- [ ] **Step 3: Message `k8s-homelab-9e`** with exactly this:

```text
Pinwall 1.1.0 is released. Please change infra/argocd/apps/pinwall.yaml (pinwall-app), apply it, sync pinwall-app, and tell me when the pod is Ready:
- source.targetRevision: 1.1.0
- image.digest: <D>   (bump with the chart, as the file says)
- env, added:
    PINWALL_VISIBILITY: personal
    PINWALL_SHARE_LINKS: approved
    PINWALL_QUOTA_BYTES: 500MB
    PINWALL_QUOTA_ARTIFACTS: "200"
    PINWALL_QUOTA_FILES: "50000"
    PINWALL_MAX_UPLOAD_BYTES: 50MB
    PINWALL_PREVIEW_TTL: 2h
    PINWALL_ABUSE_CONTACT: <owner's value>
    [PINWALL_TERMS_URL / PINWALL_PRIVACY_URL: <only if the owner gave them>]
- KEEP PINWALL_OIDC_MEMBER_GROUPS (and the rest of the member rule) unchanged. I will tell you when it may go.
The backup on 1.0.0 is taken. Re-keying the OIDC account (same users.id) can happen before or after the transfer.
```

- [ ] **Step 4: Check the deploy** once the homelab session reports Ready.
  - `kubectl -n pinwall exec deploy/pinwall -- pinwall version` prints `1.1.0`, and the pod's image is `…@D`.
  - The log since start shows the migration to `0003_spaces`, with no `spaces.guard` refusal and no open-admission warning.
  - `curl -s https://pinwall.happybooth.vn/api/v1/config/public` has `"visibility":"personal"`, `"share_links":"approved"` and the abuse contact.

  If the pod does not become Ready, the member rule keeps the instance closed. Ask the homelab session to roll back to chart `1.0.0` with digest `sha256:6cc968c9702bbf676fbd049cca63980c8dfc21b7df90f9c74d4e88cd2592e68b`. 1.0.0 cannot run on a migrated database, so restore the Step 2 backup into an emptied database with `pinwall restore --in -`.
- [ ] **Step 5: Transfer.** Run `KUBECONFIG=~/.kube/oci-cp.yaml kubectl -n pinwall exec deploy/pinwall -- pinwall transfer --from usr_jbhbf9fhf1z9e4rf09yh --to usr_wzxa74rpvwajs1m9hyke`. Use ids, because the two accounts may share an email, and a shared email is refused.
  - Expected: `Moved 2 projects with 4 artifacts from … to …. Share links handed over: 0. Memberships dropped: 0.`
  - If the owner's account opened Pinwall first, an extra line `The default project of … is now named "Default (from Owner)"` appears. It is harmless.
- [ ] **Step 6: Check acceptance 8 and 9 before sign-up opens.** While the member rule holds, the second Google account needs the `pinwall-member` role; ask `k8s-homelab-9e` to grant it.
  - Run [owner-instance](../../../docs/acceptance.md#owner-instance). Expected: the owner's OIDC account sees all 4 artifacts; the local Owner and the second account see none.
  - Run [members-live](../../../docs/acceptance.md#members-live) with the owner and the second account.

  If any check fails, stop. The member rule stays, and the owner decides what follows.
- [ ] **Step 7: Open sign-up.** Message `k8s-homelab-9e`: "Acceptance 8 and 9 passed on 1.1.0 at <time>. You may remove PINWALL_OIDC_MEMBER_GROUPS (and the second account's temporary role), then apply and sync pinwall-app." After their sync, check that the pod restarted on `D` and that the log has no open-admission warning.
- [ ] **Step 8: Check acceptance 2.** Run [open-sign-up](../../../docs/acceptance.md#open-sign-up) with a Google account that has no role.
- [ ] **Step 9: Record.**
  - Fill the three Results rows: the date; "1.1.0 (`D` shortened), pinwall.happybooth.vn, content-domain, PostgreSQL + S3"; who ran it; and the result. No ids and no emails.
  - Commit `docs: record the 1.1.0 rollout checks on the owner's instance` on `main`, and push only when the owner says.
  - Add a PROGRAM.md line: M14 done, and v1.1 released and rolled out.

---

## M14 done when

- **Acceptance:** every spec §11 item is automated and passing in `pnpm test:acceptance` at the tagged commit, or recorded in `docs/acceptance.md` with the manual check that proved it. Items 2, 8 and 9 have both.
- **Docs:** they carry every §11 item and every carried ledger item: the open-instance guide, open sign-up, the spaces and members guide, the README FAQ, CHANGELOG 1.1.0 with the upgrade note and the known limitations, backup, the skill and the MCP descriptions. `pnpm --filter @pinwall/tools test` passes.
- **Review:** the final review's Critical and Important findings are fixed.
- **Release:** `v1.1.0` is released and verified, after the owner's go.
- **Rollout:** `pinwall.happybooth.vn` runs 1.1.0 in `personal` mode, the owner's work sits in their OIDC account's space, and the homelab session has dropped `PINWALL_OIDC_MEMBER_GROUPS`.
