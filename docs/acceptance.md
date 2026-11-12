# Acceptance checklist

Pinwall 1.0 is done when every item of the design's acceptance list (§9 of the design spec) is
either proven by an automated suite that passes or by a manual check recorded below. This page
holds the record, the steps of each manual check, and how the automated part runs.

## Before tagging 1.0.0

As of the 1.0.0 release candidate, this definition is not met yet. Nothing below counts until it is
run against the commit that will be tagged, and recorded on this page.

1. **Every automated suite, at the tag candidate.** The last full run was at `b40e80d`, and later
   fixes changed the PostgreSQL connection handling, backup and restore. Run, from a clean checkout
   of the candidate commit, `pnpm lint`, `pnpm typecheck`, `pnpm test:integration`, `pnpm test:e2e`,
   `pnpm test:e2e:keycloak` and `pnpm test:acceptance`, and add a row to
   [Automated runs](#automated-runs). `e2e/acceptance-report.md` is not kept in the repository, and
   a copy of it from an earlier commit proves nothing about this one.
2. **The manual checks, on the image built from that commit** (`pnpm test:acceptance` leaves it as
   `pinwall:acceptance`). None of them has been run on a release image yet:
   - [claude-code](#claude-code) (item 2). The one recorded run was from source on an earlier
     branch, so it has to be repeated on the image.
   - [review-loop](#review-loop) (item 4), right after it, in the same Claude Code session.
   - [claude-desktop](#claude-desktop) (item 3a) and then [cloudflare-tunnel](#cloudflare-tunnel)
     (item 8), over one quick tunnel. They need `cloudflared`, Claude Desktop and an internet
     connection.
   - [fresh-install](#fresh-install) (item 1). Its timing includes the image pull, so it needs a
     published image: run it on a pre-release such as `v1.0.0-rc.1` once one is pushed, or on
     1.0.0 itself right after the release, and record which.
   - [zitadel](#zitadel) and [google](#google) (items 3 and 3b), each with an account at that
     provider. The automated suites cover these items with simulated providers and a real
     Keycloak, so these two checks are strongly advised rather than required.
   - [two-machines](#two-machines) (item 6) stays optional.
3. **The release workflow has never run on GitHub.** The first run of `release.yml` (the signing,
   the attestations, the chart push, the image tags and the GitHub release) would be the 1.0.0 tag
   itself, unless it is rehearsed first with a pre-release tag on a fork. Whether to rehearse is
   the owner's decision; record a rehearsal under [Automated runs](#automated-runs) when there is
   one.

## Automated runs

One row per run of the automated suites, or of the release workflow, that counts for a release:
the date, the commit, what ran, who ran it and the outcome. Keep older rows.

| Date | Commit | What ran | Who | Result |
| --- | --- | --- | --- | --- |
| | | | | not run yet at the 1.0.0 candidate |

## Results

One row per manual check. Fill in a row each time a check is run against a release candidate:
the date, the Pinwall version (or the image digest, for an unreleased build), who ran it and the
outcome. Keep older rows; add new ones below them.

| Check | Item | Date | Pinwall version or digest | Who | Result |
| --- | --- | --- | --- | --- | --- |
| [claude-code](#claude-code) | 2 | 2026-11-12 | branch `m6-mcp` at `b006d69`, run from source (SQLite, single-domain), Claude Code 2.1.263 | controller | pass |
| [claude-desktop](#claude-desktop) | 3a | | | | not run yet |
| [zitadel](#zitadel) | 3, 3b | | | | not run yet |
| [google](#google) | 3 | | | | not run yet |
| [review-loop](#review-loop) | 4 | | | | not run yet |
| [cloudflare-tunnel](#cloudflare-tunnel) | 8 | | | | not run yet |
| [fresh-install](#fresh-install) | 1 | | | | not run yet |
| [two-machines](#two-machines) (optional) | 6 | | | | not run yet |

The `claude-code` run above was the M6 live check: `claude mcp add --transport http pinwall
http://localhost:8080/mcp` showed "Needs authentication", the browser sign-in registered the
client and showed the consent page, and `publish ./site to Pinwall` returned the review link on the
first line of the answer 16 seconds after the request. It was run from source, before the release
image existed, so it does not count for 1.0.0: repeat it on the release image with the steps in
[claude-code](#claude-code) and add a row.

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

The manual checks cover what a test runner cannot reach: real identity providers with their own
accounts, the real Claude clients, and Cloudflare in front of a public https address.

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
   [the README's Zitadel recipe](../README.md#zitadel), for a Pinwall reachable at the address you
   registered. Create three users: one with `pinwall-admin`, one with `pinwall-member` and one
   with no role.
2. Start Pinwall with the README's environment lines for Zitadel, plus
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
   [the README's Google recipe](../README.md#google), with your own lists: an admin address in
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
   commands in [the README's backup section](../README.md#backup-and-restore), and copy the archive
   to the second host.
2. On the second host, start a new, empty install and restore the archive into it with
   `docker exec -i <container> pinwall restore --in - < pinwall.tar`.

Expected: the restore logs `restore complete`; the owner signs in with the same password; the
artifacts, their versions, comments and share links are all there; and the pages show the same
content as on the first host.
