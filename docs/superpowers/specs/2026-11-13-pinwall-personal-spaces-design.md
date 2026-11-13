# Pinwall — personal spaces (v1.1) — design

Date: 2026-11-13 · Status: **decisions D1–D8 settled by the owner on 2026-11-13 (§12); ready for
milestone planning** ·
Builds on: `2026-11-10-pinwall-design.md` (the v1 spec, still binding wherever this
document says nothing).

Markers, as in the v1 spec:
- **(builder's call):** decided while writing; the owner can change it without a new round.
- **(D*n*):** a decision only the owner can make. The text describes the recommended option, and
  §12 lists the alternatives.

---

## 1. Why

The owner wants `pinwall.happybooth.vn` open to anyone with a Google account. Such a person signs
up and signs in through Zitadel (org Danny, Google as the only method) and can use Pinwall at once,
with no approval step.

Pinwall 1.0 is one shared library for all its members. The 1.0 source shows this:

| v1.0 behavior | Where |
| --- | --- |
| Artifact lists, search, versions and comments are filtered by project at most, never by who published them. Every member sees everything (spec §3.9: "visible to members only"). | `domain/artifacts.ts`, `domain/versions.ts`, `domain/comments.ts` |
| Any member can make a public share link, with or without a password, for any artifact, including other people's. | `api/shares.ts`, `domain/shares.ts` |
| Only admins manage users and configuration, use **Revoke now**, and delete other people's artifacts and comments. | `auth/guards.ts` |
| With no member group, email or domain rule, everyone the IdP signs in is a member. | `auth/oidc/policy.ts:47-53` |

Opening sign-up on 1.0 therefore lets a stranger:
- read all of the owner's work;
- publish it through a public share link;
- host any HTML they like under `*.artifacts.io.vn`, a domain whose reputation the owner's own
  pages depend on.

## 2. Goals

1. A person who signs in for the first time is a member at once and has a **space** of their own.
2. **Private by default.** Only the owner of a space can see what is in it. This covers:
   - projects, artifacts, versions, files and thumbnails;
   - comments;
   - search results and Recent;
   - live events;
   - content grants;
   - everything the MCP tools return.
3. **Sharing is a deliberate act.** There are two ways:
   - **project members:** a project's owner adds other Pinwall users as editors or viewers (§4.1);
   - **share links,** as in 1.0. Who may make a public link is controlled (§6).
4. **Open sign-up is safe enough to run** on a homelab:
   - a storage and artifact quota per person;
   - rate limits on publishing and on minting links;
   - admin tools to see usage, block a person and take content down.
5. **Upgrading changes nothing by itself.** An existing 1.0 team installation behaves exactly as
   before until its operator turns personal spaces on (§3).

## 3. Visibility modes (D6)

A new setting, `PINWALL_VISIBILITY`, controls visibility:

| Value | Meaning |
| --- | --- |
| `team` (default) | 1.0 behavior. Every member sees every project. Admins have the 1.0 powers. |
| `personal` | Each person sees only the projects they own. Admins see content only as §7 describes. |

- The default stays `team`, so 1.1 is a minor release under SemVer.
- Changing the value takes a restart, like `PINWALL_ISOLATION`.
- **Going from `personal` to `team` is guarded (builder's call).** It would show every private space
  to every member. Pinwall records the mode it last ran in. When the configuration says `team`, the
  last recorded mode was `personal`, and more than one person owns a project, the server refuses to
  start. Its message says what would happen and names the one-time CLI confirmation:
  `pinwall visibility team --confirm`.
- Going from `team` to `personal` needs no confirmation, because it only takes visibility away.
- **Warning on open admission (builder's call).** Pinwall logs a startup warning in this case:
  `team` mode, OIDC on, and no member rule. The warning says that anyone the identity provider signs
  in will see everything.

Everything below describes `personal` mode unless it says otherwise. The quota, rate-limit and
share-link settings apply in both modes.

## 4. The space model

### 4.1 The project is the unit of ownership (D3)

- Every project has exactly one **owner**, a Pinwall user. A person's space is the set of projects
  they own.
- An artifact belongs to a project, and so do its versions, files, comments and share links.
  Visibility always follows the project's owner.
- `created_by` on artifacts and versions keeps meaning "who published it". It no longer grants
  access by itself.
- **Project members (D3).** A project's owner can add other Pinwall users as **editor** or
  **viewer**.
  - **Who can be added:** a person who has signed in to Pinwall at least once. The owner adds them
    by email.
  - **No pending invitations, no mail and no invite links.** If nobody has that email yet, Pinwall
    says to ask the person to sign in once first.
  - **Several accounts with the same email.** When several active accounts share the email (the
    local owner account and an OIDC account can), the dialog lists them by name and sign-in method,
    and the owner picks one (builder's call).
  - **Only the owner manages members.** The owner adds, removes and changes roles. A member can
    leave a project.
  - **Email lookups are rate-limited,** because the answer shows whether an email has an account.
- **The access predicate.** It is written once: "projects this viewer owns or is a member of". The
  role then decides what the viewer may change (§4.3).
- **Project members exist only in `personal` mode (builder's call).** In `team` mode everyone sees
  everything already, so the members UI and API are hidden there. Stored memberships stay, and
  apply again if the mode goes back to `personal`.
- **Project instructions** for agents stay per project, as in 1.0. Editors' and viewers' agents read
  them. Only the owner edits them.

### 4.2 Default projects (builder's call)

- **`personal` mode.** Every person has their own default project, named "Default". It is created
  the first time they need one: a publish with no project, or opening the library with no project
  yet. Each owner has at most one default project.
- **`team` mode.** There is still one shared default project, as in 1.0: the oldest default
  project. Other people's default projects, left from an earlier `personal` period, show as
  ordinary projects.

### 4.3 What "see" and "change" mean

**In `personal` mode,** per project:

| Action | Owner | Editor | Viewer | Anyone else (admins included) |
| --- | --- | --- | --- | --- |
| See the project, its artifacts, versions, files, comments; search; Recent; live events | yes | yes | yes | no (not found) |
| Comment, reply, resolve, reopen; edit or delete own comments | yes | yes | yes | no |
| Publish a new artifact or version, restore a version | yes | yes | no | no |
| Rename, retag or delete an artifact or version | yes | only what they published | no | no |
| Delete other people's comments | yes | no | no | no |
| Create share links (subject to §6) | yes | yes | no | no |
| Revoke share links | any in the project | their own | no | no |
| Rename or archive the project, edit its instructions | yes | no | no | no |
| Add, remove or change members | yes | leave only | leave only | no |

- An artifact can move only between projects that the same person owns.
- **When a member is removed or leaves:**
  - their grants for the project's artifacts, their live streams and their unused upload URLs end,
    as when someone loses sight of a space (§5);
  - the share links they made on the project's artifacts are revoked;
  - their comments stay.

**In `team` mode:** the 1.0 rules apply unchanged.

### 4.4 Someone else's id answers like a missing one

- A request that names an id in someone else's space gets the same answer as an id that does not
  exist. That means `404 not_found` on REST, the same error on MCP, and the same page in the
  browser.
- It never answers 403, and the answer must not differ in its timing class (for example, no extra
  look-up only for ids that exist). Existence must not leak.
- This applies to every kind of id: projects, artifacts, version numbers, comments, share links,
  upload sessions, and content and raw-link tokens.

## 5. Every way to read or write must check the space

The access predicate must apply on **every** surface:
- REST: lists, reads, writes, counts, diff and compare, thumbnails, raw-link redirects.
- MCP: every tool.
- Full-text search.
- Recent (`artifact_views`).
- Live events (SSE).
- Content grants and content serving.
- Upload sessions and web upload targets.
- Restore.
- Share-link management.

The roadmap lists each of these with its file and line in the 1.0 code. Required behavior:

1. **Lists and search** return only visible items. Counts (open threads, share links, artifacts per
   project) count only visible items. Paging cursors cannot reach outside the space.
   - **Search must filter inside the index query.** 1.0 takes the best 1,000 hits of the whole
     instance and only then narrows them by project. Done that way, other people's matches would
     crowd out a person's own results, and the ranking would leak information about other spaces.
2. **Reads and writes by id** check the predicate first and treat a miss as §4.4.
3. **Recent** shows only artifacts the viewer can still see. A view recorded before a transfer
   (§8.2) must not surface someone else's artifact.
4. **Live events**:
   - Subscribing to an artifact's stream requires that the viewer can see the artifact.
   - A stream that carries events for many artifacts filters each event per subscriber.
   - When a person loses sight of an artifact (a transfer, removal from a project, a block, Revoke
     now), their open streams for it end.
5. **Content grants:**
   - A member gets a grant only through a checked route.
   - A grant keeps serving only while its user can still see the version's artifact (builder's call:
     this is checked on each content request, in the same query as the existing user-access check).
   - Share-link grants keep their own rules.
6. **Publishing:**
   - A publish session, an inline publish, a web upload and a restore may target only a project or
     artifact the publisher can see.
   - In 1.0 any member may publish a new version of any artifact. In `personal` mode only the space
     owner may.
   - The check runs again when the version is committed, not only when the session is made. So a
     one-time upload URL made before its target left the space (a transfer) is refused when used.
7. **MCP** goes through the same domain functions as REST. No tool may have its own query that skips
   the predicate.
8. **Share viewers (guests)** keep 1.0 behavior. A share link reaches exactly its artifact or
   version, and nothing else in the space.

Each item gets an automated **IDOR test**: user A tries to read or write user B's data by id through
the surface, and gets the not-found answer. The suite runs in both modes. In `team` mode the same
cases assert the 1.0 behavior. The suite is the release gate (§11).

## 6. Who may expose content outside Pinwall (D4)

Someone hosting a phishing page wants a public URL on a domain with a good reputation. Pinwall 1.0
hands out two kinds of such URL:
- **Share links**, which anyone can open.
- **Content URLs** for review and raw links. These are capability URLs: anyone who has one can use
  it for up to `PINWALL_PREVIEW_TTL` (12 h by default). Content responses carry no `frame-ancestors`
  (`content/serve.ts:46-70`), so such a URL works as a top-level page. It can also be framed by any
  site.

A new setting, `PINWALL_SHARE_LINKS`, controls who may **expose content outside Pinwall**:

| Value | Who may expose content |
| --- | --- |
| `members` (default) | Any member, as in 1.0. Nothing below changes. |
| `approved` | Admins, and members whom an admin has approved |

**What a person who is not approved cannot do, with `approved`:**
- **Create share links.** The share dialog says why and that an admin can allow it. MCP
  `create_share_link` and the REST route refuse with a clear message. Existing links still list and
  can be revoked.
- **Open raw links.** `/a/:id/raw`, `/a/:id/v/:n/raw` and the viewer's "Open original" answer with
  a page that explains the restriction.
- **Have pages open as a top-level page.** The review grants they are given, for any artifact they
  can see, serve only inside Pinwall's viewer:
  - a top-level load (`Sec-Fetch-Dest: document`, or a request without fetch metadata) is refused;
  - every response carries `Content-Security-Policy: frame-ancestors 'self' <app origin>`.

  `'self'` keeps the artifact's own nested frames working. The person still reviews their pages in
  the viewer, full screen included.

**Approval:**
- **Who approves:** an admin turns on "May expose content" for a person in **Admin → Users**.
- **Removing approval** revokes that person's share links. It uses the same mechanism as losing
  access in 1.0: grants are deleted and tombstoned, and the link's streams end.
- **The check runs every time a link is opened**, not only when it is created, the same way 1.0
  checks the maker's access (builder's call). So switching an existing installation to `approved`
  stops the links of people who are not approved yet. The guide says to approve people first.
- **An IdP group as the source of approval** is an option listed under D4.

**Residual risk, written down rather than solved.** An approved person can still abuse their links.
Pinwall's answer is accountability and takedown:
- every account is a verified Google identity at the IdP;
- admin look-up and takedown of a reported URL (§7);
- a per-person rate limit on minting grants (§9);
- an abuse contact shown on public pages (D8).

## 7. Admins (D1)

In `personal` mode an admin **does not browse other people's private content**. Instead an admin
gets moderation tools that work on metadata and on what is already public.

**Users** (existing page, extended). Each user row adds:
- **Usage:** projects, artifacts, versions, stored bytes, active share links, last publish time.
- **May expose content** (only meaningful with `PINWALL_SHARE_LINKS=approved`).
- **Quota override:** bytes and artifacts, or "default".
- **Block** and **Revoke now**, both as in 1.0.
- **Delete all content** (`personal` mode only). This deletes every project the person owns, with
  the same effects as deleting each artifact: links answer "gone" and blobs are collected. It needs
  the person's email typed to confirm. It destroys work but reveals none of it.

**No transfer in the app (builder's call).** An admin who could move a stranger's space into their
own could read it and move it back, and §7's promise would mean nothing. Transfer (§8.2) is
therefore a CLI command only, run by whoever operates the server, who can read the database anyway.

So the promise to people is exact:
- admins of the app cannot read your private work;
- the operator of the installation can, as with any self-hosted service.

**Share links** (new page). It lists every active share link in the instance, with:
- the artifact name and the owner's name and email;
- created, expires and last-used times;
- whether it has a password and whether it allows comments.

Its actions are: revoke the link, and delete the artifact.
- **No "open":** tokens are stored only as hashes, so the guest URL cannot be rebuilt, and an admin
  view would bypass the owner's password.
- An admin who has the URL from a report uses **Look up**.

**Look up a reported link** (new). An admin pastes a URL from an abuse report: a share URL, an
`<origin>/a/…` link, or a content URL (`/c/<token>/…` or `<token>.<content host>/…`). Pinwall
answers with:
- the artifact, its owner and the version;
- the share link or grant that the URL belongs to, if any.

From that answer the admin can act: revoke the link, end the version's grants, delete the version or
the artifact, or block the owner. The answer shows no content beyond what the reported URL already
exposes.

**Other rules:**
- Every moderation action is logged as a structured log line with the admin, the action and the
  target (builder's call: logs only, no audit table in v1.1).
- In `team` mode admins keep the 1.0 powers. The usage columns, approval, quota overrides, Share
  links and Look up work there too. "Delete all content" is hidden, because projects are shared.

## 8. Existing data (D2)

### 8.1 Migration `0003` (both modes)

**Projects:**
- Every project gets an owner. It is `created_by` where that is set.
- The 1.0 instance default project, and any project whose creator is unknown, goes to the first
  account that exists of:
  1. the owner account;
  2. the earliest admin;
  3. the earliest user.
- On an empty instance the project stays unowned, and the first person who needs a default project
  adopts it.

**Users get:**
- "may create share links": off;
- a bytes quota override and an artifacts quota override, both empty.

**Settings:** a small table of instance settings is added. It records the last visibility mode
(§3).

**Old backups:** a 1.0 backup must restore into 1.1 and end up exactly as if 1.1 had migrated that
database. Restore fills a column that an older archive lacks with the table default, so restore runs
the same owner backfill after loading the rows.

**Default project ids:** the 1.0 default project has the fixed id `prj_00000000000000000000`. It
keeps that id and becomes its new owner's default. Default projects created later get ordinary ids.
Two pieces of 1.0 code assume there is only one default project:
- restore deletes the default project when it is empty;
- the web app uploads into the default project from "All artifacts".

In `personal` mode both act on the viewer's own default project.

### 8.2 Transfer of content (CLI only)

`pinwall transfer --from <user> --to <user>`, with each user given by id or email, moves every
project A owns to B, in one transaction. It runs in either mode. §7 says why it is not in the app.
- An email that matches more than one user is refused, and the matching ids are listed.
- If both have a default project, A's becomes an ordinary project named "Default (from <A's
  name>)".
- Grants, streams and unused upload URLs of people who no longer see the moved projects end, as in
  §5.
- Share links keep working. They belong to the artifact, and their maker's own access is still
  checked as in 1.0.
- Project members stay members of the moved projects. If B was a member of one, that membership is
  dropped, because B now owns the project.

### 8.4 Switching an existing team installation to `personal` (builder's call)

- Ownership follows the project. Work that members published into the shared default project, or
  into a project someone else created, stays with that project's owner. Those members see empty
  spaces until the operator moves whole spaces with `pinwall transfer`.
- A finer split (each artifact into its publisher's own default project) is left for a later
  release, in case someone asks for it.
- The owner's own instance is not affected: everything there is published by one account.

### 8.3 The owner's own instance

Data on `pinwall.happybooth.vn`, read on 2026-11-13:

| What | Count |
| --- | --- |
| Users | 2: the local Owner, and the owner's OIDC account (admin) |
| Projects | 2: the instance default "Default", and "Block Brain" (made by Owner) |
| Artifacts, versions | 4 and 7, all published by Owner (about 13 MB) |
| Comments, share links, API tokens, OAuth grants | none |

Owner and the OIDC account stay **separate accounts**.

**After 1.1 deploys:**
1. Migration 0003 makes Owner the owner of both projects.
2. The owner runs `pinwall transfer` (through `kubectl exec`) from Owner to their OIDC account, and
   then sees all 4 artifacts in their own space.
3. Owner keeps an empty space and stays the break-glass admin.

**Interaction with the homelab's Zitadel work.** The homelab session plans to re-key the OIDC
account to the owner's new Danny-org user, changing `oidc_subject` while `users.id` stays the same.
Ownership is stored by `users.id`, so the re-key and the transfer can happen in either order.

## 9. Quotas and rate limits (D5)

**Quotas per person (both modes).**

| Setting | Default |
| --- | --- |
| `PINWALL_QUOTA_BYTES` | `0`, which means no limit |
| `PINWALL_QUOTA_ARTIFACTS` | `0`, which means no limit |

- **Admins are exempt.** An admin can override both values per person.
- **How stored bytes are counted (builder's call):** a sum of `versions.total_bytes`. This is the
  logical size, so each version counts in full even when files are shared. That makes the number
  easy to predict and to explain. Old versions free space when they are deleted.
- **Whose usage a version counts toward:**
  - in `personal` mode, the owner of the project it is in, so a transfer moves the usage with the
    space. That includes what editors publish there: the owner chooses the editors and can remove
    them. An editor's publish is checked against the owner's quota, and the error says it is the
    project owner's space that is full;
  - in `team` mode, the person who published it (`versions.created_by`), because projects are
    shared there. Nobody can fill another person's quota, and nobody escapes theirs by publishing
    into the shared default project.
- **Artifacts** are counted the same way.
- **When the quota is checked:**
  - when a publish session or web upload starts (refused at once if the person is already over);
  - again when a version is about to be committed, with its real size;
  - for inline publish and for restore.
- **A refused publish:**
  - creates no version and leaves no orphan blobs;
  - says how much is used, the limit, and how much the version needed;
  - suggests deleting old versions or asking an admin;
  - uses a new error code `quota_exceeded` (HTTP 413).
- **Visibility of usage:** people see their own usage and limits in **Settings**. The MCP `whoami`
  tool returns them too, so an agent can tell the person before it publishes.

**Per-person rate limits (builder's call: fixed rules in code, like 1.0's).**
- **Publishing:** the existing 60 per 10 minutes now counts every path (sessions, inline, web
  upload, restore), not only session creation.
- **Content grants** (review, raw-link and preview): 600 per hour.
- **Share links created:** 30 per hour.
- **Projects created:** 30 per hour.

These limits also fix the 1.0 deferred item "preview and raw-link calls not rate-limited".

**Recommended values for `pinwall.happybooth.vn`** (env, part of D5):
- `PINWALL_QUOTA_BYTES=500MB`
- `PINWALL_QUOTA_ARTIFACTS=200`
- `PINWALL_SHARE_LINKS=approved`
- `PINWALL_PREVIEW_TTL=2h`

## 10. What people see

- **A new person** lands on an empty library with three ways to start: connect an agent, drop a file
  or a folder, or create a project. The sidebar keeps its 1.0 labels. "All artifacts" means
  everything the person can see.
- **Projects shared with the person** appear in the sidebar under **Shared with me**, with the
  owner's name and the person's role.
- **Viewers** do not get the upload or publish controls.
- **Members panel** (on the project page, for the owner): add by email with a role, change a role,
  remove a member. Editors and viewers see the member list with names only. They get a **Leave
  project** action.
- **Settings → Usage** (new) shows stored bytes and artifacts against the person's limits. With D8-A
  it also offers **Delete all my content**.
- **Share dialog:** when the person may not create links, the dialog shows the reason instead of the
  form.
- **Admin:**
  - Users gets the additions from §7.
  - Two new pages: **Share links** and **Look up a link**.
  - **Configuration** lists the new settings with explanations, like the others.
- **Agents:** MCP tool descriptions and the Claude Code skill say "your projects" and "your
  artifacts". `whoami` returns the visibility mode, usage, limits, and whether the person may create
  share links.
- **All new text goes through i18n**, in English only, as in 1.0.

## 11. Release

**Version and data:**
- **v1.1.0** (D7), with migration `0003`.
- The backup format reads 1.0 backups (§8.1).
- The chart and the Compose example pass the new settings through as environment variables, as
  they do today. No new chart values are needed beyond documentation.

**Documentation:**
- `docs/configuration.md` is generated from the catalog and gets the new settings.
- `docs/sign-in.md` gets a new section, "Open sign-up", covering:
  - the Zitadel org with Google and the role claims, as the homelab sets them up;
  - Google directly;
  - the order of operations in §13.
- A new operator guide, "Running an open instance", covering:
  - the settings to use;
  - quotas;
  - share-link approval;
  - preview TTL;
  - how to handle an abuse report;
  - why a separate content domain matters even more there.
- The README FAQ, the CHANGELOG and the skill.

**Acceptance for v1.1** (added to `docs/acceptance.md`):
1. **The IDOR suite (§5)** passes in both modes for REST, MCP, SSE, search, Recent, raw links,
   content grants, upload targets and share management.
2. **A first-time Google sign-in** through Zitadel gives a member with an empty space. That person
   publishes from Claude Code and sees only their own work. The owner's artifacts do not appear in
   any list, search or MCP answer of theirs.
3. **Approval:** with `PINWALL_SHARE_LINKS=approved`, a member who is not approved:
   - cannot create a link through the web, REST or MCP;
   - cannot open a raw link;
   - finds that their review content URL, opened top-level or framed by another site, is refused.

   After approval all three work. When approval is removed, their links answer "gone".
4. **Quotas:** a publish over the quota is refused on every path, with no version and no leftover
   blobs. Admins are exempt, and a per-person override works.
5. **Admin tools:**
   - usage is shown;
   - `pinwall transfer` moves everything and ends the old grants;
   - "Delete all content" removes everything;
   - the share-link list and the look-up work;
   - no admin route returns private content that no link exposes, and no admin route moves a space.
6. **Upgrade:** a 1.0 database, and a 1.0 backup restored into 1.1, behave exactly as in 1.0 in
   `team` mode. Switching to `personal` gives each project to its owner as §8.1 says.
7. **The guard:** switching from `personal` to `team` is refused until `pinwall visibility team
   --confirm` has run.
8. **On `pinwall.happybooth.vn`:** after the transfer, the owner's OIDC account sees all 4
   artifacts, and a second Google account sees none of them.
9. **Project members:**
   - after being added as a viewer, the second account sees that project only, comments, and cannot
     publish;
   - as an editor, it publishes there, and that counts toward the owner's quota;
   - after removal, its open review tab loses the content, its stream ends and its links in that
     project answer "gone";
   - none of this works in another of the owner's projects.

## 12. Decisions for the owner

**Answers given on 2026-11-13:**
- D1-A: private, with moderation tools.
- D2-A: transfer by CLI.
- **D3-B, project members in v1.1:**
  - editor and viewer roles;
  - added by the email of an existing user;
  - managed by the owner only.
- D4-A, with approval through a switch in Pinwall.
- D5: the recommended values.
- D6-A: keep `team` mode as the default.
- D7: v1.1.0.
- D8-A: abuse contact, links, and self-service deletion.

The options are kept below for the record.

### D1. Can admins see everyone's content?

| Option | What it means |
| --- | --- |
| **A. Private, with moderation tools (recommended)** | As §7: usage numbers, all share links, look-up of reported URLs, block, delete. No browsing of private work. |
| B. Admins see everything | Simplest moderation. Strangers must trust the operator with everything they publish. |
| C. Private, plus a logged "break-glass" view | A with an audited way to open any artifact, after a stated reason. Needs an audit table and UI, so it fits v1.2. |

### D2. How the owner keeps their existing work

| Option | What it means |
| --- | --- |
| **A. Transfer content (recommended)** | The CLI from §8.2 moves Owner's 2 projects to the owner's OIDC account. Owner stays as the break-glass admin with an empty space. |
| B. Link Owner and the OIDC account into one user | One identity for both sign-in methods. Merging accounts is easy to get wrong, and email-based linking is a classic takeover path. |
| C. Owner sees every space | Same objection as D1-B. |

### D3. Projects and sharing between people

| Option | What it means |
| --- | --- |
| A. Personal projects only in v1.1 (was recommended) | Each person's own projects, a default project each, instructions per project as today. Sharing only through share links. Project members come in v1.2 without a data migration (§4.1). |
| **B. Project members in v1.1 (chosen)** | Invite another Pinwall user to a project as editor or viewer. A larger IDOR surface, member-management UI, and a later release. |

### D4. Exposing content outside Pinwall on an open instance

| Option | What it means |
| --- | --- |
| **A. `PINWALL_SHARE_LINKS=approved` (recommended for happybooth)** | As §6. Until an admin approves a person, their pages open only inside Pinwall's viewer, for themselves, with no share links and no raw links. The product default stays `members`. |
| B. Anyone may share, behind a warning page | Share links and raw links by people who are not approved open a Pinwall page first ("published by a user of this site, not by its operator"), then the content. Less friction. It deters, but does not stop, a phishing page. |
| C. Anyone may share, as in 1.0 | Rely on takedown alone. |

**Sub-question for A: where does approval live?**
- **Recommended:** a switch in **Admin → Users**, stored in Pinwall.
- **Or:** an IdP group, `PINWALL_OIDC_SHARE_GROUPS`, for example a Zitadel role `pinwall-sharer`.
  This follows 1.0's "the identity provider owns roles", and the homelab already manages Pinwall
  roles in Zitadel.
- **Both** can be offered, with "approved" meaning either one.

### D5. Quota and limit values

- **Recommended:** the defaults and the happybooth values from §9: 500 MB and 200 artifacts per
  person, admins exempt, per-person override, and a 2 h preview TTL.
- **Alternative:** stricter values, for example 100 MB, or loosen them later.

### D6. Keep a team mode?

| Option | What it means |
| --- | --- |
| **A. Keep `team` as the default, `personal` opt-in (recommended)** | Nothing changes on upgrade, so v1.1 stays a minor release. |
| B. Make `personal` the default | Safer for new installations, but changes what existing members see. That calls for 2.0. |
| C. Drop team mode | Simpler code, but breaks every team installation. |

### D7. Version and rollout

- **Recommended:** v1.1.0, rolled out in the order of §13.
- **Alternative:** 2.0.0, only if D6-B or D6-C is chosen.

### D8. Abuse reports and leaving

An instance open to any Google account needs a way for reports to reach the admin, and a way for a
person to take their data back out.

| Option | What it means |
| --- | --- |
| **A. Contact and links, plus self-service deletion (recommended)** | See below. |
| B. Contact only | Deletion goes through the admin. |
| C. Neither | Reports and deletion requests arrive by whatever channel people find. |

**What option A adds:**
- **`PINWALL_ABUSE_CONTACT`**, an email or URL. It is shown on:
  - the share viewer;
  - the "gone" and "not found" pages;
  - the sign-in page.
- **`PINWALL_TERMS_URL` and `PINWALL_PRIVACY_URL`**, shown as links on the sign-in page when set.
- **Settings → Delete all my content**, the same purge as the admin action, confirmed by typing the
  person's email.

Closing the Pinwall account itself, and the IdP account, stays out of scope. The account row stays
disabled, as admins see it today.

## 13. Rollout with the homelab (order matters)

1. Release 1.1.0. Deploy it on `pinwall.happybooth.vn` with:
   - `PINWALL_VISIBILITY=personal`;
   - the D4 and D5 values;
   - `PINWALL_OIDC_MEMBER_GROUPS` still set, so approval is still required.

   The Pinwall session announces this deploy to the homelab session before it changes anything on
   the cluster.
2. Transfer Owner's content to the owner's OIDC account (§8.3), and check acceptance item 8.
3. Only then does the homelab session remove `PINWALL_OIDC_MEMBER_GROUPS`, so that everyone who
   signs in is a member.

   This works today. With `PINWALL_OIDC_ROLES_CLAIM` and `PINWALL_OIDC_ADMIN_GROUPS` set and no
   member rule, Pinwall makes every signed-in person a member. `pinwall-admin` still makes an admin
   (`policy.ts:47-53`). A person with no role, whose token has no roles claim, is admitted at
   sign-in. The access re-check does not count the missing claim as a removal
   (`recheck.ts:181-186`).

   A small 1.1 fix: the one-time warning "a sign-in token had no roles claim" is logged only when a
   member group rule exists. Without one, a missing claim is normal.

**Removing the member rule before step 1 exposes everything.** In 1.0, every member sees and can
share all content.

## 14. Non-goals for v1.1

- Pending invitations, invite links, and mail to new members.
- Editors who manage members.
- Teams, or several organizations, inside one instance.
- Admin browsing of private content, and an audit table (D1).
- A sign-up form in Pinwall. Sign-up happens at the identity provider.
- Automatic abuse detection, and calls to outside reputation services (that would be phoning home,
  an anti-goal).
- Per-email allowlists, notifications, billing.

## 15. Anti-goals

- Any route, tool, stream or URL through which one person reads or changes another's private data.
- An answer that reveals whether an id exists in another space.
- An upgrade that changes what members of an existing installation can see, in either direction,
  without the operator asking for it.
- Silently exposing private spaces when the mode changes.
- An admin quietly reading private work.
