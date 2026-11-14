# Changelog

Every release of Pinwall, newest first. Versions follow [Semantic Versioning](https://semver.org/).

## 1.1.0

### Upgrading from 1.0

- **Nothing changes for your members until you set `PINWALL_VISIBILITY=personal`.** `team` stays
  the default: every member still sees every project, as in 1.0. The other new settings default
  to the 1.0 behavior too: `PINWALL_SHARE_LINKS=members`, no quotas, no abuse contact.
- **A migration, `0003_spaces`, runs when the server starts.** It gives every project an owner: the
  person who created it, or for a project whose creator is unknown the owner account, else the
  earliest active admin, else the earliest user. Take a backup first. A 1.0 backup restores into
  1.1, but 1.0 refuses a 1.1 backup.
- **The per-person rate limits apply in both modes.** See Changed below for the numbers.
- **A very slow upload now fails, in both modes.** One publish may run for at most 10 minutes, or
  for the time `PINWALL_MAX_UPLOAD_BYTES` takes at 64 KiB/s when that is longer, so an upload of
  the largest size that averages under 64 KiB/s ends with 408. See Changed below.
- **Before you set `PINWALL_SHARE_LINKS=approved`, approve the people who publish,** not only those
  who make links. A page opens outside Pinwall's viewer only when the person who published it, or
  in `personal` mode its project's owner, is approved, so the links to other pages stop until then.
- **To switch to personal spaces,** set `PINWALL_VISIBILITY=personal`, restart, and move whole
  spaces with `pinwall transfer --from <user> --to <user>`. Ownership follows the project, so what
  members published into someone else's project stays with that project's owner.
- **Going back to `team` after `personal` is refused** while more than one person owns a project,
  because every member would then see all of their projects. Run
  `pinwall visibility team --confirm` once, then start again.
- New settings: `PINWALL_VISIBILITY`, `PINWALL_SHARE_LINKS`, `PINWALL_QUOTA_BYTES`,
  `PINWALL_QUOTA_ARTIFACTS`, `PINWALL_QUOTA_FILES`, `PINWALL_ABUSE_CONTACT`, `PINWALL_TERMS_URL`
  and `PINWALL_PRIVACY_URL`. On an instance open to the public, also lower
  `PINWALL_MAX_UPLOAD_BYTES` to `50MB`; see Known limitations.
- Read [Spaces, projects and members](https://github.com/dungnguyenv/pinwall/blob/v1.1.0/docs/spaces.md)
  for the people who use a Pinwall, and
  [Running an open instance](https://github.com/dungnguyenv/pinwall/blob/v1.1.0/docs/open-instance.md)
  for the order to change an instance that already holds work.

### Added

- **Personal spaces.** With `PINWALL_VISIBILITY=personal`, each person sees only the projects they
  own and the ones they were added to, and gets a default project of their own. Admins manage
  accounts but do not browse anyone's work. The operator, who can read the database, still can.
- **Project members.** A project's owner adds people by email as editors, who also publish, or as
  viewers, who read and comment. The owner changes a role or removes someone, and everyone but the
  owner can leave. The project appears under **Shared with me**, and an agent connected with the
  person's account sees it too. Removal takes effect at once: the person's open pages and live
  updates stop, and the share links they made in the project are revoked.
- **Approval to share outside Pinwall.** With `PINWALL_SHARE_LINKS=approved`, only admins and the
  people an admin approved can make share links, open raw links or have their pages open as a page
  of their own. Everyone else still reviews inside Pinwall's viewer. Who published a version counts
  too: a version opens outside the viewer only when its publisher, or in `personal` mode its
  project's owner, is approved or an admin, whoever opens it, so adding an approved person or an
  admin to a stranger's project exposes nothing. Taking approval away revokes that person's links.
- **Quotas.** `PINWALL_QUOTA_BYTES`, `PINWALL_QUOTA_ARTIFACTS` and `PINWALL_QUOTA_FILES` cap what
  one person stores, how many artifacts they have and how many files all their versions hold, in
  both modes. A publish that does not fit is refused as `quota_exceeded`, HTTP 413, and leaves
  nothing behind. It is refused before anything is stored when its size is known up front (an
  inline publish, a restore, or an upload whose `Content-Length` alone is too large), and an
  upload stops as soon as its files go over what is left. Admins have no limit, and an admin can
  set other storage and artifact limits for one person. **Settings, Usage** shows a person where
  they stand.
- **Admin tools for an open instance.** **Admin, Users** shows each person's usage and has the
  approval switch, **Set limits…** and **Delete all content** (in `personal` mode). **Share links**
  lists every link that is neither revoked nor expired. **Look up a link** takes a reported share
  link, `/a/…` link or content address and names the artifact, project, owner and version without
  showing the page. From there an admin revokes the link, ends a version's open pages, or deletes
  the version or the artifact. Each of these actions writes one `moderation` line to the log.
- **Delete all my content.** In `personal` mode a person can delete every project they own, with
  its artifacts, comments and share links, after typing their email. Projects others shared with
  them, and their account, stay.
- **Abuse contact, terms and privacy.** `PINWALL_ABUSE_CONTACT` is shown on share pages, on the
  pages for links that are gone or not found, and on the sign-in page, where
  `PINWALL_TERMS_URL` and `PINWALL_PRIVACY_URL` are linked too.
- **For agents.** `whoami` reports the space's usage and quota and whether the account may create
  share links, where those apply. In `personal` mode the project tools show the person's role in
  each project.
- **Two commands.** `pinwall transfer --from <user> --to <user>` moves every project one person
  owns to another, by email or id, in one transaction. `pinwall visibility team --confirm` allows
  `team` mode after `personal` mode.
- **Guides.** Spaces, projects and members; running an open instance; open sign-up with Zitadel and
  Google, or with Google directly; and restoring a 1.0 backup into 1.1.

### Changed

- The publish limit, 60 per 10 minutes for each person, now counts every way to publish: upload
  URLs, inline publishes, web uploads and restoring a version. 1.0 counted only upload URLs.
- New per-person limits: 600 content grants an hour (review, raw links and previews), 30 share
  links an hour, 30 projects an hour, 30 member look-ups an hour, and 60 comment writes per 10
  minutes (new threads, replies, edits, resolves and reopens, over REST and MCP). They count by
  account, across browsers, tokens and addresses, in memory, so a restart clears them.
- At most 2 publishes per person, and 4 on the instance, run at once, restores included. Another
  answers 429 `rate_limited` with `Retry-After: 10`. Admins are exempt from the instance's 4, so
  they can still publish and restore when others hold every place, but each is held to 2 at once.
- One publish may hold its place for at most 10 minutes, or for the time
  `PINWALL_MAX_UPLOAD_BYTES` takes at 64 KiB/s when that is longer: about 24 minutes at the default
  95 MB. Past that deadline it ends with 408 `request_timeout` (`details.reason`
  `publish_deadline`), keeps nothing and gives its place back. This holds in every mode, `team`
  included: an upload of the largest size that averages under 64 KiB/s, which 1.0 took however
  long it ran, now fails with 408.
- A web upload whose body sends nothing for 60 seconds now ends with 408 `request_timeout`, as an
  upload URL's already did.
- Uploaded files go to storage as they arrive, instead of being held whole in memory.
- Review pages carry the annotator only up to 5 MB of HTML, and with at most 50 MB of such pages
  held in memory at once; see Known limitations.
- A `team` instance with an identity provider and no member rule logs a startup warning: anyone the
  provider signs in becomes a member and sees every project.
- The "no roles claim" warning appears only when a member group rule is set. Without one, a
  sign-in token that carries no roles claim is normal.
- Expired content grants are kept for 30 days, where 1.0 removed them when they expired, so that
  **Look up a link** can still name the owner of an address that is reported late.
- The MCP tool descriptions and the agent skill speak of your projects and your default project,
  and say what to do when a publish is refused for quota, for a viewer's role or for missing
  approval.

### Known limitations

- Until an admin approves a person (`PINWALL_SHARE_LINKS=approved`), the nested frames of their
  pages do not display in the review viewer, in either isolation mode. The viewer's sandbox never
  matches the frame policy those pages are served with. Approved people are not affected.
- A share link without comments redirects to the raw page, so that page shows no abuse contact.
  With `PINWALL_SHARE_LINKS=approved`, only approved people can make such links.
- Other JSON routes answer 500, without a crash, when a chunked request body breaks off. Sending it
  again works. An inline publish answers 400.
- **Delete all my content** (`/me/purge`) writes its `moderation` log line before it runs, so the
  line carries no outcome.
- SQLite search ranking (FTS5) uses statistics of the whole index, so text in other spaces can
  change the order, never the membership, of a person's results. PostgreSQL is unaffected.
- A zip upload is still read into memory whole before it is unpacked, up to
  `PINWALL_MAX_UPLOAD_BYTES` (95 MB by default). With four publishes running at once, set
  `PINWALL_MAX_UPLOAD_BYTES=50MB` on an open instance to keep that near 200 MB. Tar and tar.gz
  uploads stream.
- Several accounts can keep the instance's 4 publish places busy, cycle after cycle, each upload
  until its deadline, and everyone but admins gets 429 `server_busy` meanwhile. Blocking an account
  does not stop the uploads it is already running. Block the accounts: their places come back
  within the deadline.
- A review page larger than 5 MB of HTML, or one asked for while 50 MB of review pages are already
  held in memory, is served as it is stored, without the annotator: it takes point comments only,
  not comments on a selected text or element. That second case is never cached, so the next load
  gets the annotator again.
- Restoring a version makes whoever restores it its publisher. When an approved person restores a
  version that someone who is not approved published, the copy can be shared and opened outside
  Pinwall.
- With `approved`, only pages are held inside the viewer, not files. The content addresses
  Pinwall hands to someone who is not approved still serve their files to an image, script,
  stylesheet or `fetch` on any site until they expire (`PINWALL_PREVIEW_TTL`).
- A content address that a share link handed out keeps working until it expires even when the link
  is suspended because of its maker: one who was not approved when the instance switched to
  `approved`, or whom the identity provider no longer admits. The link itself stops at once.
- Content that was revoked or deleted, including by **Delete all my content**, answers 410 and can
  no longer be traced to its owner by **Look up a link**.
- Adding someone to a project needs no consent from them: any owner can add any account with a
  verified email, admins included, and add it again after it leaves.
- `PINWALL_QUOTA_FILES` has no per-person value. An upload checked by its `Content-Length` counts
  an archive's or a form's own bytes, so near the bytes limit it can be refused although its files
  would fit. Comments, projects and kept content grants are bounded by the rate limits, not by a
  quota.

## 1.0.0

### Added

- **Publishing.** An agent asks Pinwall for a one-time upload URL that expires within minutes and
  runs the command it gets back, so no CLI is installed and no long-lived secret sits in the shell.
  An agent without a shell publishes text files inline. A REST API, described by an OpenAPI
  document, serves scripts and CI, and the web app takes a file, a folder or an archive dropped onto
  it. A publish can be a single file or a tar, tar.gz or zip archive, and it is refused with a clear
  reason when it breaks a limit, uses an unsafe path or looks like an archive bomb. A new version
  names the version it replaces, so publishing on top of a newer one is refused.
- **Pages and Markdown.** HTML pages and multi-page sites keep their relative links, nested frames
  and `#anchor` links, in review as on the raw link. Markdown renders as a clean page with a table
  of contents and code highlighting. A publish warns about links that start at the server root.
- **Versions.** Every publish is an immutable, numbered version. Older versions can be restored as a
  new one, and links that follow the current version stay stable. Two versions compare side by side,
  with an overlay slider, as a source diff and as a rendered Markdown diff. Files are stored by
  their SHA-256 and shared between versions. An admin or a publisher can delete an artifact, a
  version or a comment for good, and its links answer "gone" at once.
- **Review.** A review viewer shows the page at desktop, tablet, phone and custom widths, in full
  screen if you like, and switches to a newly published version by itself.
- **Comments.** People pin comments on a text selection, an element or a point. Threads take
  replies and can be resolved and reopened. Anchors find their place again on a new version, and a
  resolved thread shows the version that fixed it. Agents read, answer and resolve the same threads
  over MCP.
- **Sharing.** A share link follows an artifact's current version or shows one version. It can carry
  a password, an expiry and permission to comment, and each link can be revoked alone.
- **Projects and search.** Projects group artifacts and carry instructions that agents read before
  they publish. Artifacts take tags, and full-text search over names, tags and page text ignores
  accents, so "chup anh" finds "chụp ảnh".
- **Agent connection.** An MCP server at `/mcp` with tools for identity and limits, projects,
  artifacts, publishing, comments and share links. Pinwall is the OAuth 2.1 server for its own MCP
  endpoint, with dynamic client registration, PKCE and resource indicators, so a provider never has
  to issue tokens for Pinwall. API tokens serve clients without OAuth. An agent skill for Claude
  Code and setup instructions for Claude Code, Cursor and Codex come with it.
- **Sign-in and access.** A built-in owner account, created with a one-time setup link and a
  passkey or a password, needs no identity provider. Any OpenID Connect provider can be added, with
  roles mapped from a claim such as `groups`, or from lists of verified emails and domains for
  providers like Google that send no groups. Pinwall checks with the provider again at least every
  24 hours, and an admin can end a person's sessions, tokens and share links at once.
- **Content isolation.** Two modes keep artifacts away from the app's session: a sandbox on the app's
  own host, and a separate content domain with one origin per version. The mode is an environment
  variable, and switching it leaves every artifact and share link working.
- **Operations.** One multi-arch (amd64 and arm64) container image that runs as a non-root user on a
  read-only root filesystem, with SQLite and local files by default, or PostgreSQL and S3-compatible
  storage. `pinwall backup` and `pinwall restore` move a whole installation between machines and
  between storage setups. Health and readiness probes, Prometheus metrics on a separate port and JSON
  logs are built in, and nothing is sent to any third party.
- **Configuration.** Infrastructure settings come from environment variables only, and a secret can
  be given as a file too. The admin page shows what the server runs with, and a generated reference
  lists every setting.
- **Deployment and release.** A hardened Helm chart that refers to the image by digest, and Docker
  Compose examples for SQLite and for PostgreSQL with S3. Release images and charts are signed and
  come with provenance attestations. The image also has an SBOM attestation for each platform,
  linux/amd64 and linux/arm64, and ships a list of its third-party licenses.

### Known limitations

- On identity providers that ignore `prompt=select_account`, such as Keycloak, "Not you?" on the
  agent consent page signs the same account back in. Sign out at the provider first.
- The version pickers of the compare screen list the newest 50 versions. To compare an older one,
  put its number in the address (`?from=<n>&to=<n>`).
- The rendered Markdown diff does not show the artifact's own images, since it runs in a sandbox
  with no address to load them from. The side-by-side view shows them.
- The compare screen does not follow live updates: reload it to see a version published since it
  opened.
- The review page shows the first 1000 comment threads of an artifact, the oldest first. The API
  and the MCP tools list them all.
- Search finds the words in the first 5 MB of each HTML page and the first 200 KB of each Markdown
  file, at most 20 MB per version, and up to 200,000 characters of text per version. Words past
  that are in the page but not in search.
- A page in a nested frame whose own Content-Security-Policy blocks the annotator cannot be
  commented on. The page the viewer opens still takes point comments when its policy blocks the
  annotator.
- After **Revoke now**, a live-update stream the person already has open is checked again within
  25 seconds, and can bring them new comments until then.
