# Changelog

Every release of Pinwall, newest first. Versions follow [Semantic Versioning](https://semver.org/).

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
  24 hours, and an admin can end a person's sessions and tokens at once.
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
