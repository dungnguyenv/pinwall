# Acceptance checklist

A Pinwall release is done when every item of its acceptance list is either proven by an automated
suite that passes or by a manual check recorded below. Pinwall 1.0 has the items `1` to `10` of §9
of [the design spec](superpowers/specs/2026-11-10-pinwall-design.md). Pinwall 1.1 adds the items
`1.1-1` to `1.1-9` of §11 of
[the personal spaces design](superpowers/specs/2026-11-13-pinwall-personal-spaces-design.md), and
every 1.0 item still holds. This page holds the record, the steps of each manual check, and how the
automated part runs.

## Before tagging 1.1.0

Nothing below counts until it is run against the commit that will be tagged, and recorded on this
page. Where the 1.1.0 candidate stands:

1. **Every automated suite, at the tag candidate:** `pnpm lint`, `pnpm typecheck`,
   `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:e2e:keycloak` and `pnpm test:acceptance`,
   recorded in [Automated runs](#automated-runs). Not run yet: it is part of the final review of the
   candidate.
2. **[claude-code](#claude-code) on a 1.1.0 image in `personal` mode,** with
   `-e PINWALL_VISIBILITY=personal` added to the `docker run` of its first step. Not run yet: it is
   part of the final review too.
3. **The manual parts of 1.1-2, 1.1-8 and 1.1-9:** [open-sign-up](#open-sign-up),
   [owner-instance](#owner-instance) and [members-live](#members-live). They need real Google
   accounts and the owner's own instance, so they run on `pinwall.happybooth.vn` after the release,
   in the order of §13 of the personal spaces design: deploy 1.1.0 with the member rule still set,
   transfer the owner's content and check owner-instance, and only then remove the member rule and
   check open-sign-up and members-live. The automated suites prove these items before the tag;
   these checks confirm them on the live instance.

## Before tagging 1.0.0

Nothing below counts until it is run against the commit that will be tagged, and recorded on this
page. Where the 1.0.0 candidate stands:

1. **Every automated suite, at the tag candidate.** Done locally at `3df932a` and on GitHub at
   `a132d03` (see [Automated runs](#automated-runs)). Repeat on the commit that is tagged if it
   changes code. `e2e/acceptance-report.md` is not kept in the repository, and a copy of it from
   an earlier commit proves nothing about another one.
2. **The manual checks.** [fresh-install](#fresh-install) (item 1), [claude-code](#claude-code)
   (item 2), [review-loop](#review-loop) (item 4) and [cloudflare-tunnel](#cloudflare-tunnel)
   (item 8) have been run (see [Results](#results)). Still to do:
   - [claude-desktop](#claude-desktop) (item 3a), over a quick tunnel. It needs `cloudflared`,
     Claude Desktop and an internet connection.
   - [zitadel](#zitadel) and [google](#google) (items 3 and 3b), each with an account at that
     provider. The automated suites cover these items with simulated providers and a real
     Keycloak, so these two checks are strongly advised rather than required.
   - [two-machines](#two-machines) (item 6) stays optional.
3. **The release workflow.** Rehearsed with `v1.0.0-rc.1` on the `release/1.0` branch: every job
   passed, and the image signature, the provenance and SBOM attestations and the chart were
   checked afterwards (see [Automated runs](#automated-runs)).

## Automated runs

One row per run of the automated suites, or of the release workflow, that counts for a release:
the date, the commit, what ran, who ran it and the outcome. Keep older rows.

| Date | Commit | What ran | Who | Result |
| --- | --- | --- | --- | --- |
| 2026-11-12 | `3df932a` | `pnpm lint`, `pnpm typecheck`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:e2e:keycloak`, `pnpm test:acceptance` | controller | pass |
| 2026-11-12 | `a132d03` | GitHub Actions CI on `main` (all seven jobs) | GitHub Actions | pass |
| 2026-11-12 | `610f611` (`v1.0.0-rc.1`) | `release.yml` rehearsal: tag check, CI, image for amd64 and arm64, cosign signature, provenance and SBOM attestations, chart push, GitHub pre-release. Afterwards: `cosign verify` with the documented identity, `gh attestation verify` for the provenance and the SBOMs, the chart pulled with the image digest in its values | controller | pass |

## Results

One row per manual check. Fill in a row each time a check is run against a release candidate:
the date, the Pinwall version (or the image digest, for an unreleased build), who ran it and the
outcome. Keep older rows; add new ones below them.

| Check | Item | Date | Pinwall version or digest | Who | Result |
| --- | --- | --- | --- | --- | --- |
| [claude-code](#claude-code) | 2 | 2026-11-12 | branch `m6-mcp` at `b006d69`, run from source (SQLite, single-domain), Claude Code 2.1.263 | controller | pass |
| [claude-code](#claude-code) | 2 | 2026-11-12 | 1.0.0 image built locally from `3df932a` (`--read-only`, `--cap-drop ALL`, SQLite, single-domain), Claude Code 2.1.263 | controller | pass |
| [claude-desktop](#claude-desktop) | 3a | | | | not run yet |
| [zitadel](#zitadel) | 3, 3b | | | | not run yet |
| [google](#google) | 3 | | | | not run yet |
| [review-loop](#review-loop) | 4 | 2026-11-12 | 1.0.0 image built locally from `8061ff3`, behind a Cloudflare quick tunnel (https origin), Claude Code 2.1.263 | controller | pass |
| [cloudflare-tunnel](#cloudflare-tunnel) | 8 | 2026-11-12 | same run as review-loop, cloudflared 2026.10.7 | controller | pass |
| [fresh-install](#fresh-install) | 1 | 2026-11-12 | `ghcr.io/dungnguyenv/pinwall:1.0.0-rc.1` (`sha256:40eca17a…`), pulled from GHCR on a home connection | controller | pass, 49 s |
| [two-machines](#two-machines) (optional) | 6 | | | | not run yet |
| [open-sign-up](#open-sign-up) | 1.1-2 | | | | not run yet |
| [owner-instance](#owner-instance) | 1.1-8 | | | | not run yet |
| [members-live](#members-live) | 1.1-9 | | | | not run yet |

The `claude-code` run above was the M6 live check: `claude mcp add --transport http pinwall
http://localhost:8080/mcp` showed "Needs authentication", the browser sign-in registered the
client and showed the consent page, and `publish ./site to Pinwall` returned the review link on the
first line of the answer 16 seconds after the request. It was run from source, before the release
image existed, so it does not count for 1.0.0.

The second `claude-code` row repeats it on an image built from the candidate commit, run read-only
with every capability dropped. The sign-in, consent and publish steps behaved the same. The review
link opened the review screen with the page in its frame 20 seconds after the request. The
container's log held no token, code, upload address or consent request id.

The `review-loop` and `cloudflare-tunnel` rows come from one run behind a quick tunnel, on the
tunnel's https origin. Claude Code connected through the tunnel and published the fixture folder.
A comment "Make this bold" was pinned on a paragraph, and Claude Code was asked to read the comments
and fix them. Without a reload, the open tab switched to v2 with the paragraph in bold, and the card
read "Resolved in v2" with its pin on the same paragraph. Through the tunnel, the raw link of v1,
the files behind its grant and a public share link all hashed the same as the local files. Every
content response carried `no-transform`, and Cloudflare reported `DYNAMIC`, so nothing was cached
or rewritten. The agent's reply showed `&lt;strong&gt;` because the agent wrote the entity itself;
the `reply_to_comment` description now says the text is plain.

## The automated part

`pnpm test:acceptance` builds the image as `pinwall:acceptance`, then runs every suite below once,
prints a table of the items with their results, and writes it to `e2e/acceptance-report.md`. It
exits with 1 when the build or any suite fails. To test an image you built already, name it in
`PINWALL_ACCEPTANCE_IMAGE` and the build is skipped. The install checks use port 8080, as the
spec's command does; `PINWALL_ACCEPTANCE_PORT` moves them when 8080 is taken. Docker must be
running, and Chromium installed for Playwright (`pnpm exec playwright install chromium`).

| Item | Automated by | Manual check |
| --- | --- | --- |
| 1 | `e2e/acceptance/install.spec.ts`: the built image on a fresh volume, setup link, owner account, upload, review, in under five minutes | [fresh-install](#fresh-install), with the image pull |
| 2 | `apps/server/test/mcp/agent-flow`: OAuth sign-in of an MCP client, upload URL, published folder | [claude-code](#claude-code) |
| 3 | `apps/server/test/auth/oidc/flow` (Zitadel-, Keycloak- and Google-like providers) and `pnpm test:e2e:keycloak` (a real Keycloak 26) | [zitadel](#zitadel), [google](#google) |
| 3a | `apps/server/test/mcp/agent-flow`, part C: `publish_inline` from an agent without a shell | [claude-desktop](#claude-desktop) |
| 3b | `apps/server/test/auth/oidc/flow`, parts D to H: access lost within 24 hours by the job alone, and at once on Revoke now | [zitadel](#zitadel), step 6 |
| 4 | `apps/server/test/mcp/agent-flow`, part D (the agent's side), and `pnpm test:e2e:review` (an open review tab moves to v2 with the comment resolved in v2) | [review-loop](#review-loop) |
| 5 | `pnpm test:e2e:review`: a multi-page artifact with nested frames, a video and anchors, in review and raw, in both isolation modes | none |
| 6 | `e2e/acceptance/backup-restore.spec.ts`: SQLite and local disk backed up, restored into the Postgres + S3 Compose example | [two-machines](#two-machines) (optional) |
| 7 | `e2e/acceptance/install.spec.ts`: "chup anh" finds "chụp ảnh" | none |
| 8 | `apps/server/test/api/review-flow` and `publishing-flow`: raw and share links serve the stored bytes | [cloudflare-tunnel](#cloudflare-tunnel) |
| 9 | `e2e/acceptance/install.spec.ts`: links of a deleted version answer 410 at once; its files leave the volume unless another version uses them | none |
| 10 | `e2e/acceptance/install.spec.ts`: single-domain, content-domain and back on one volume, every raw and share link serving the same bytes | none |

The 1.1 items run in the same command. Their server suites run every case in `team` and in
`personal` mode, and also on Postgres and S3 when the test database and bucket variables of
`pnpm test:integration` are set, with the test stack up: set them for a run that counts.
`e2e/acceptance/upgrade.spec.ts` starts the published 1.0.0 image, by the digest of its
multi-platform index, and pulls it first when it is not on the machine.
`PINWALL_ACCEPTANCE_UPGRADE_FROM` names another 1.0 image to upgrade from.

| Item | Automated by | Manual check |
| --- | --- | --- |
| 1.1-1 | `apps/server/test/spaces/idor-rest`, `idor-mcp`, `idor-sse`, `idor-content`, `idor-publish`, `idor-members` and `search`: the owner, an editor, a viewer and a stranger on REST, MCP, live streams, search, Recent, raw links, content grants, upload targets and share management, in both modes. `scope-guard`: only the allow-list acts without a viewer | none |
| 1.1-2 | `apps/server/test/auth/oidc/policy`, `spaces/warnings` and `spaces/projects`: with no member rule everyone who signs in is a member, with a default project of their own. The 1.1-1 suites. `e2e/keycloak/spaces.spec.ts` (`pnpm test:e2e:keycloak`), walk "acceptance 2": a first sign-in through a real Keycloak lands on an empty space, and search and `/a/<id>` show nothing of another person's | [open-sign-up](#open-sign-up) |
| 1.1-3 | `apps/server/test/moderation/exposure` and `framed-only`: without approval no share link on REST or MCP, no raw link, and content only inside Pinwall's viewer; links stop when approval goes. The 1.1-5 suites. `e2e/keycloak/spaces.spec.ts`, walk "acceptance 3": the same through the web, and the link gone once the admin takes approval back | none |
| 1.1-4 | `apps/server/test/moderation/quota`: an upload URL, an inline publish over REST and MCP, a web upload and a version restore over the quota each answer `quota_exceeded` (413) and leave no version and no blob; admins are exempt; a per-person override applies | none |
| 1.1-5 | `apps/server/test/moderation/admin-users`, `admin-moderation`, `purge`, `transfer` and `transfer-cli`: usage, the transfer and the grants it ends, Delete all content, the share-link list and the look-up; no admin route returns private content or moves a space. `e2e/keycloak/spaces.spec.ts`, walk "acceptance 3": the admin pages | none |
| 1.1-6 | `apps/server/test/spaces/migration` and `restore-v10`: a 1.0 database and a 1.0 archive get their owners as §8.1 says. `e2e/acceptance/upgrade.spec.ts`: the published 1.0.0 image, upgraded in place to the image under test, answers every read the same as before in `team` mode, its 1.0.0 backup restored into an empty 1.1 answers the same, and in `personal` mode each project is its owner's | none |
| 1.1-7 | `apps/server/test/spaces/visibility` and `visibility-cli`: `serve` refuses `team` after `personal` while more than one person owns projects, until `pinwall visibility team --confirm` | none |
| 1.1-8 | `apps/server/test/moderation/transfer` and `transfer-cli`: the transfer moves every project to the account it names, which then sees all of it, and in `personal` mode the account it came from no longer does | [owner-instance](#owner-instance) |
| 1.1-9 | `apps/server/test/spaces/members-acceptance` and `members-removal`: a viewer, an editor, a removal, and nothing in the owner's other projects. `e2e/keycloak/spaces.spec.ts`, walk "acceptance 9": the same through the web | [members-live](#members-live) |

CI completes 1.1-6: it runs every 1.0 test unchanged against 1.1 in the default `team` mode, and
those tests compare whole response bodies.

The manual checks cover what a test runner cannot reach: real identity providers with their own
accounts, the real Claude clients, Cloudflare in front of a public https address, and the owner's
own instance.

## fresh-install

Acceptance 1 including the image pull. The automated walk times `docker run` to the page in
review with the image already on the machine (it runs the image it just built), so it leaves out
the download.

1. Use a machine that does not have the image yet, or remove it first with
   `docker image rm ghcr.io/dungnguyenv/pinwall`. This needs the published image, so run it once
   the release is pushed.
2. Start a timer and run exactly:

   ```sh
   docker run -v pinwall:/data -p 8080:8080 ghcr.io/dungnguyenv/pinwall
   ```

3. Open the setup link it prints, name the owner, turn on **Password**, choose one and select
   **Create owner account**.
4. Select **Upload**, then **Choose files or an archive**, and pick a one-file HTML page. Select
   **Open** in the "Published" notice.
5. Stop the timer when the page shows in the review screen.

Expected: under five minutes in all, on an ordinary home connection. Record the time and the
connection in the results. Afterwards remove the container and the `pinwall` volume.

## claude-code

Acceptance 2 with the real Claude Code.

1. Start the image on a fresh volume and create the owner account with a password:

   ```sh
   docker run -d --name pinwall-check -v pinwall-check:/data -p 8080:8080 pinwall:acceptance
   docker logs pinwall-check 2>&1 | grep setup_url
   ```

2. In an empty folder, create `site/index.html` with a heading of your choice.
3. Run `claude mcp add --transport http pinwall http://localhost:8080/mcp`.
4. Start `claude`, type `/mcp`, choose **pinwall**, then **Authenticate**. The browser opens
   Pinwall's sign-in and then its consent page; select **Allow**. (Without a browser on that
   machine, `claude mcp login pinwall --no-browser` prints the address to open elsewhere.)
5. Ask: "publish ./site to Pinwall".

Expected: a review link within a minute of the request, with no token pasted and nothing
installed besides Claude Code; the link opens the page in the review screen; the container's log
has no token, code or upload URL in it. Afterwards run `claude mcp remove pinwall` and remove the
container and its volume.

## review-loop

Acceptance 4 with the real Claude Code, after [claude-code](#claude-code) (keep its install and
its connection).

1. Open the review link of the published site in the browser.
2. Select **Comment mode**, select a few words of the page, type "Make this bold" and select
   **Comment**.
3. Leave the tab open. In Claude Code, ask: "read the comments on that page and fix them".

Expected: without a reload, the open tab switches to v2, the words are bold, and the comment
card, still pinned on the same words, shows "Resolved in v2".

## zitadel

Acceptance 3 and 3b with a real Zitadel (Zitadel Cloud or your own instance).

1. Set up the project, the roles `pinwall-admin` and `pinwall-member` and the application as in
   [the Zitadel recipe](sign-in.md#zitadel), for a Pinwall reachable at the address you
   registered. Create three users: one with `pinwall-admin`, one with `pinwall-member` and one
   with no role.
2. Start Pinwall with the recipe's environment lines for Zitadel, plus
   `PINWALL_ACCESS_RECHECK_INTERVAL=5m`, and create the owner account.
3. Select **Continue with Zitadel** and sign in as the admin. Expected: the library, and **Admin**,
   **Users** opens.
4. Sign out, then sign in as the member. Expected: the library; `/admin/users` says "Only admins can
   do this."
5. Sign out, then sign in as the user with no role. Expected: "No access with this account" with
   that user's name. Select **Use a different account**. Expected: Zitadel asks who is signing in
   again; sign in as the member and you are in.
6. Acceptance 3b. As the admin, in **Admin**, **Users**, select **Revoke now** for the member.
   Expected: the member's open tab is signed out at its next request, and an API token the member
   made answers 401 at once. Let the member sign in again, then remove their role in Zitadel and
   wait for the recheck interval. Expected: the member loses access without any admin action.

## google

Acceptance 3 with a real Google OAuth client.

1. Create the OAuth client and set the variables as in
   [the Google recipe](sign-in.md#google), with your own lists: an admin address in
   `PINWALL_ADMIN_EMAILS`, a domain you control in `PINWALL_MEMBER_DOMAINS`, and a personal Gmail
   address in `PINWALL_MEMBER_EMAILS`.
2. Sign in with each of these accounts in turn, signing out in between.

Expected: the listed admin address is an admin; an address in the listed domain is a member; the
listed personal Gmail address is a member; a Gmail address on no list gets the "No access with this
account" page.

## claude-desktop

Acceptance 3a. Claude Desktop connects only to a public https address, which is why this check is
manual. It needs `cloudflared` and Claude Desktop.

1. Start a quick tunnel to the install and note the `https://<name>.trycloudflare.com` origin it
   prints:

   ```sh
   cloudflared tunnel --url http://localhost:8080
   ```

2. Restart Pinwall with that address, on a fresh volume, and create the owner account through the
   new setup link:

   ```sh
   docker run -d --name pinwall-check -v pinwall-check:/data -p 8080:8080 \
     -e PINWALL_PUBLIC_ORIGIN=https://<name>.trycloudflare.com -e PINWALL_TRUST_PROXY=true \
     pinwall:acceptance
   ```

3. In Claude Desktop, open **Settings**, **Connectors**, **Add custom connector**, enter
   `https://<name>.trycloudflare.com/mcp`, and sign in to Pinwall when asked.
4. Ask it to publish a one-file HTML page that it writes in the conversation.

Expected: Claude uses the inline publishing tool (it has no shell), answers with a review link, and
the link opens the page.

## cloudflare-tunnel

Acceptance 8, over the same tunnel as [claude-desktop](#claude-desktop).

1. Make a fixture folder with `index.html` (an email address in the text, an inline `<script>`,
   runs of extra spaces and blank lines, and links to the next two files), `app.js` and an image,
   then publish it (from the library, or with Claude Code connected to the tunnel's address).
2. Create an API token under **Settings**, **API tokens** and put it in `PINWALL_TOKEN`. Fetch every
   file through the raw link of version 1 and through a public share link (one without a
   password), then hash it:

   ```sh
   curl -sSL --compressed -H "Authorization: Bearer $PINWALL_TOKEN" "<origin>/a/<id>/v/1/raw" | shasum -a 256
   curl -sSL --compressed "<origin>/s/<token>" | shasum -a 256
   ```

   For `app.js` and the image, follow the raw link once with `curl -sI`, and fetch the files from
   the grant address its `location` header gives (`<grant>app.js`, and so on).
3. Hash the local files with `shasum -a 256`.
4. Check the headers of each content response with `curl -sI`.

Expected: every hash matches its local file (Cloudflare neither obfuscated the email address nor
minified anything), and `cache-control` contains `no-transform` on every content response.

## two-machines

Acceptance 6 between two hosts. Optional: the automated suite already restores into a separate
Postgres + S3 install on one host.

1. On the first host, back up an install that has artifacts, comments and a share link, with the
   commands in [the backup guide](backup.md#backup-and-restore), and copy the archive
   to the second host.
2. On the second host, start a new, empty install and restore the archive into it with
   `docker exec -i <container> pinwall restore --in - < pinwall.tar`.

Expected: the restore logs `restore complete`; the owner signs in with the same password; the
artifacts, their versions, comments and share links are all there; and the pages show the same
content as on the first host.

## open-sign-up

Acceptance 1.1-2 with a real Google account, on an instance with open sign-up: `personal` mode and
no member rule, as in [Open sign-up](sign-in.md#open-sign-up). On `pinwall.happybooth.vn` it runs
once the member rule is removed. `<origin>` below is the instance's address.

1. In a private window, sign in with a Google account that has no Pinwall role.

   Expected: the empty library, "Your space is empty", with its three ways to start: connect an
   agent, drop a file or a folder, or create a project.
2. In a scratch folder, run `claude mcp add --transport http pinwall-acceptance <origin>/mcp`. Start
   `claude`, type `/mcp`, choose **pinwall-acceptance**, then **Authenticate**, and sign in as that
   account. The consent page says whom it signs in as: if that is not the new account, choose
   **Not you?** first.
3. Have Claude Code publish a one-page site.

   Expected: a review link.
4. Check what the account can see.

   Expected:
   - "All artifacts" lists only that page;
   - searching for words of the owner's artifacts finds nothing;
   - `/a/<owner artifact id>` shows the not-found page, "Artifact not available";
   - asked through Claude Code, the MCP tools `list_artifacts` and `search_artifacts` return only
     its own page.
5. Clean up: run `claude mcp remove pinwall-acceptance`, and as that account choose **Delete all my
   content** in **Settings → Usage**.

## owner-instance

Acceptance 1.1-8 on `pinwall.happybooth.vn`, right after `pinwall transfer` has moved the local
Owner's content to the owner's OIDC account. The second Google account must be able to sign in:
give it the member role at the identity provider, or run that part once the member rule is removed.

Expected:

- the owner's OIDC account sees the 4 artifacts, in two projects: in the web, in search, and
  through its Claude Code `list_artifacts`;
- the local Owner account sees an empty library;
- a second Google account sees none of them in lists, search or MCP, and `/a/<id>` of each answers
  not found.

## members-live

Acceptance 1.1-9 on `pinwall.happybooth.vn`, with the owner's OIDC account and the second Google
account of [open-sign-up](#open-sign-up). Connect Claude Code as the second account as in its step
2, and keep it connected until the end.

1. The owner creates the project "Acceptance 1.1" and publishes a page in it.
2. The owner opens the project, chooses **Members**, types the second account's email, chooses
   **Viewer** and **Add**.

   Expected: the second account sees only that project of the owner's, under **Shared with me**. It
   can comment, but it has no **Upload**, and a publish into the project through MCP is refused with
   the reason `role` (ask Claude Code to quote the tool's answer).
3. The owner makes it **Editor**, and it publishes a page into the project.

   Expected: the owner's **Settings → Usage** grows by that version's size, and the second
   account's does not.
4. An admin approves the second account with the **may expose content** switch in **Admin,
   Users**. The second account makes a share link of its page, and keeps the artifact open in
   review. Then the owner removes it in **Members**.

   Expected: within 25 seconds its open tab shows "Artifact not available", and the share link,
   opened in a private window, shows "Link no longer available".
5. At every step, the owner's other projects stay not found for the second account: in its lists,
   in search, through MCP and at `/a/<id>`.
6. Clean up: take the approval back, delete the project's artifacts, and **Archive** the project
   (Pinwall has no way to delete a project, other than Delete all my content).
