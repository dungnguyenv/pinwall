# Pinwall — design

Date: 2026-11-10 · Status: draft for review · License: Apache-2.0
Repository: github.com/dungnguyenv/pinwall

Pinwall is an open-source, self-hosted home for the pages AI agents make.
An agent (Claude Code first, any MCP client after) publishes an HTML page, a
folder of pages, or a Markdown document; people open it, look at it at
several screen sizes, pin comments on it, and the agent reads those comments,
fixes the page, and publishes the next version. Every version is kept until
an admin or its publisher deletes it.

Statements marked **(builder's call)** were decided while writing this
document rather than by the product owner; they can be changed without going
back to them. Everything else was decided by the owner.

---

## 1. Why this exists

The owner runs several Claude Code accounts. Each claude.ai account keeps its
own artifacts, so work published from one account is invisible from the
others. A self-hosted server that every account, machine and agent talks to
solves that.

The owner deployed the most complete existing project, plannotator
`artifact-server` v0.1.2, on Kubernetes on 2026-11-10 and hit these problems.
Pinwall exists to do the same job without them:

| Problem with the existing option | Consequence |
| --- | --- |
| Content must live on a second registrable domain; the server refuses to start otherwise, and the maintainers declined an opt-out (their #113) | Users must buy and configure a second domain before anything works |
| MCP OAuth needs the IdP to put `<origin>/mcp` in the access token's `aud`; Zitadel, Google and most IdPs cannot | Every agent connection falls back to a hand-issued API key |
| MCP refuses file content; uploads need the `artifactserver` CLI and Node 24 on every machine | Extra install per machine; the CLI's macOS Keychain storage silently saves an empty credential without a TTY (their #131) |
| An unadmitted IdP identity at sign-in gets a raw JSON 403, no account switch (their #130) | Users stuck in a loop until they clear the IdP session |
| The review viewer renders in a `srcdoc` frame whose CSP has no `frame-src` (their #132), and `/favicon.svg` is not routed (their #133) | Multi-page artifacts with iframes show blank boxes in review; no tab icon |
| Postgres + S3 + Helm required, 700+ MB of node_modules in the image | Heavy for one person or a small team |

What the existing project gets right, and Pinwall keeps: one store for every
agent, immutable versions, comments tied to exact versions and readable by
the agent, a separate origin for untrusted content, signed releases pinned by
digest.

## 2. Who it is for

Individuals and organizations alike, kept simple. Pinwall is **not** a
permissions product: identity and group membership are delegated to the
organization's identity provider (Zitadel, Keycloak, Authentik, Google
Workspace, Okta…). A person running it alone needs no identity provider at
all.

## 3. Goals for v1

v1 ships complete before the first public release (no early public MVP).

### 3.1 Install and run

- One multi-arch (amd64, arm64) container image. `docker run` with a data
  volume is a working installation: SQLite in WAL mode and blobs on the local
  filesystem.
- Optional PostgreSQL and S3-compatible object storage for larger
  installations, selected by configuration.
- **One running instance in v1**, with either storage setup; it scales up,
  not out. The code must not make running several instances later a
  rewrite: whatever would have to be shared between instances (live-update
  fan-out, one-time upload URLs, OAuth codes, rate-limit counters, migration
  runs) goes behind an interface with an in-process implementation now.
- A Helm chart and a Docker Compose example.
- Configuration by environment variables, with `*_FILE` variants for every
  secret. **Environment variables are the only source of infrastructure
  settings** (isolation mode, public origins, OIDC, storage); the admin UI
  shows them and explains them but does not edit them, so Helm and GitOps
  never drift from the running config. Application data (projects, share
  links, members' role overrides) lives in the database **(builder's call)**.

### 3.2 Sign-in and access

- **Built-in owner account** for single-person installs, no IdP needed
  (passkey, with a password fallback **(builder's call)**). Created on first
  start through a one-time setup link printed in the log **(builder's call)**.
- **OIDC sign-in** with any standards-compliant provider. Roles come from the
  IdP: a configurable claim (e.g. `groups`) maps to `admin` / `member`. For
  providers without a groups claim — Google among them — admins and allowed
  members are given as lists of verified emails and email domains instead
  **(builder's call: no provider-specific code such as Google's Directory
  API; personal Google accounts work when listed)**. Optionally restrict
  sign-in to listed groups or email domains. No per-project ACLs in v1.
- **Losing access**: someone removed from the IdP or from the allowed groups
  loses access **within 24 hours**. Pinwall re-checks with the IdP whenever it
  renews a session or an MCP token, at least once every 24 hours; this needs
  the IdP's refresh token, stored encrypted with a key supplied by
  environment variable. Admins also have **"Revoke now"**, which ends a
  person's browser sessions, MCP tokens and API tokens at once.
- Browser errors are HTML pages, never raw JSON. A sign-in that resolves to
  an identity without access shows **who** was signed in and offers **"Use a
  different account"**, which makes the identity provider ask again who is
  signing in: Pinwall ends the IdP session first (OpenID Connect RP-Initiated
  Logout) when the provider supports it, then restarts the login with
  `prompt=select_account`.
- Personal API tokens for scripts.
- **MCP clients authenticate with OAuth 2.1 issued by Pinwall itself**:
  Pinwall is the authorization server for its own MCP resource (dynamic
  client registration, PKCE, resource indicators, protected-resource
  metadata), and the user signs in through the owner account or the
  configured IdP during that flow. The IdP never has to mint a token for
  Pinwall's audience — the fix for the `aud` problem in §1. API tokens remain
  accepted as bearer credentials for clients without OAuth.

### 3.3 Two content-isolation modes

Untrusted artifact HTML must never run with access to the application's
session. Both modes are supported, and both the setup and the admin settings
explain the trade-off in plain words.

| Mode | Where content is served | Isolation | Needs |
| --- | --- | --- | --- |
| **Single domain** (default) | Same hostname as the app, under a path prefix, every response sent with `Content-Security-Policy: sandbox …` without `allow-same-origin` **(builder's call: path prefix rather than subdomains, so no wildcard DNS or certificate is needed)** | Content runs in an opaque origin: cannot read or set the app's cookies, its requests are cross-site for cookie purposes. Weaker than separate sites: shares the registrable domain with whatever else runs there | Nothing extra |
| **Separate content domain** (recommended for production) | A wildcard host per version on a domain used for nothing else, e.g. `<token>.pinwall-content.example` | Full browser isolation between app and content and between versions | A second domain and a wildcard certificate |

In both modes content access is authorized by an unguessable capability token
in the URL (path segment or host label) — short-lived for previews, long-lived
for share links — never by a cookie on the content side **(builder's call)**.
Consequences of opaque-origin content (no `localStorage`, no cookies, no
service workers) are documented for authors and in the agent skill.

The mode is set by environment variable; changing it is a restart. Links
people hold must survive the change: artifact links and share links are
URLs on the application origin that resolve to the content in whichever mode
is current, never raw content URLs **(builder's call)**.

### 3.4 Content types

- **HTML**: a single file, or a folder (multi-page sites, CSS, JS, images,
  video, nested iframes of the artifact's own pages). Relative links, nested
  frames and in-page `#anchor` links work in the review viewer exactly as on
  the raw link.
- **Markdown**: rendered as a clean page with a table of contents, code
  highlighting, and the same commenting as HTML.

### 3.5 Publishing

- **MCP**: the agent asks for a publish session for a target (new artifact in
  a project, or new version of an artifact with the expected current version
  id). Pinwall returns a one-time upload URL that expires within minutes,
  plus the exact command to run, e.g.
  `tar -czf - -C ./site . | curl --fail-with-body --data-binary @- "<url>"`.
  The response of that request is the published version with its links. No
  CLI to install, no long-lived secret in the shell, no file bytes passed
  through the model. Single-file publishes use the same path.
- **Inline publish for MCP clients without a shell** (Claude Desktop,
  claude.ai connectors): a tool that takes text files (HTML, Markdown, CSS,
  JS, SVG) directly as arguments, capped at a small total size (default 2 MB
  **(builder's call)**). Agents with a shell are steered to the upload URL.
- **REST API** (documented with OpenAPI) for scripts and CI.
- **Web upload** by drag and drop of a file, folder or archive
  **(builder's call)** — useful for onboarding and for people without agents.
- Limits: maximum file size, version size, file count, archive expansion
  ratio; rejects path traversal, symlinks, absolute paths, zip/tar bombs.
  One upload is one request; the default maximum per publish is 95 MB, under
  Cloudflare's 100 MB request cap on its Free and Pro plans, and is
  configurable **(builder's call; chunked or resumable upload is post-v1)**.
- Optimistic concurrency: a new version names the version it replaces;
  publishing on top of a newer one is refused with a clear error.

### 3.6 Versions and comparison

- Every publish creates an immutable version. History, restore (makes an old
  version current by creating a new version), and stable links that follow
  the current version.
- **Visual comparison** of two versions: side by side, and an overlay with a
  slider. **Source diff** of changed files; **rendered diff** for Markdown.
- Files are stored content-addressed (SHA-256) and shared between versions.
- **Deletion**: an admin, or the artifact's publisher, can permanently delete
  an artifact, a single version, or a comment — for the day an agent
  publishes a secret or personal data. Deleted content stops being served
  at once (its links and share links answer "gone"), and files no longer
  referenced by any remaining version are removed from storage. Backups made
  before the deletion still contain it; the UI says so when deleting.

### 3.7 Review viewer (the main screen)

- Layout "A — focus on the page": the page takes most of the screen; a slim
  top bar carries breadcrumb (project / artifact), version switcher, device
  sizes, compare, comments toggle with count, share. The comment panel docks
  on the right and can be closed. A full-screen mode hides all chrome.
- **Device sizes**: desktop, tablet, phone presets plus custom width.
- **Live update**: when a new version is published while the viewer is open,
  it switches to it without a reload (or offers to, if the reviewer is
  mid-comment), keeping comments in place.
- The artifact renders in a sandboxed iframe pointing at its content URL —
  not `srcdoc` — so the artifact's own policy, nested frames and anchors
  behave as on the raw link **(builder's call)**.

### 3.8 Comments

- Pin a comment on a text selection, an element, or a point on the page.
  Threads with replies; resolve and reopen; edit and delete own comments.
- **Anchors survive new versions**: each anchor stores a text quote with
  surrounding context, a DOM path, and a position fallback (in the spirit of
  W3C Web Annotation selectors). On a new version, comments re-attach where
  the anchor still matches and are flagged where it does not. A resolved
  comment shows the version that resolved it ("resolved in v3").
- **How comments reach inside the page** **(builder's call)**: the artifact
  runs in an opaque origin the viewer cannot read, so element and text
  comments need a small Pinwall annotator script inside the page. It is
  injected **only into review-mode HTML responses** — including the artifact's
  own nested frames — and talks to the viewer by `postMessage`. Raw links and
  share links are served byte-for-byte as published. Pinwall never relaxes an
  artifact's own Content-Security-Policy; where that policy blocks the
  annotator, the page still gets point comments placed on the viewer's
  overlay.
- The agent sees the same threads over MCP: list unresolved comments with
  their anchor text and location, reply, and mark resolved with the version
  that addressed them.
- Comments are visible to signed-in members; share-link viewers can see and
  write comments only if the share link allows it **(builder's call)**.

### 3.9 Sharing

- Default: visible to members only.
- Share links per artifact (follow current version) or per version:
  public, password-protected, with expiry; each link revocable on its own.
- Not in v1: per-email allowlists for outside viewers (needs mail delivery)
  **(builder's call; see §9)**.

### 3.10 Projects and search

- Projects group artifacts. Create, rename, archive. A default project
  exists.
- **Project instructions for agents**: free text per project that the agent
  reads over MCP before publishing (language, colors, conventions), like
  Claude Projects' instructions.
- Tags on artifacts.
- Full-text search over names, tags and the text extracted from HTML and
  Markdown, accent-insensitive (Vietnamese must match with and without
  diacritics): SQLite FTS5 with `unicode61 remove_diacritics 2`; the
  Postgres equivalent with `unaccent` **(builder's call)**.

### 3.11 Agent integration

- MCP server at `/mcp` (Streamable HTTP) with tools for: identity and
  limits, projects (list, get with instructions), artifacts (list, search,
  get, versions), publish session, comments (list, reply, resolve), share
  links. Exact tool set and schemas are the builder's.
- A ready-to-install Agent Skill for Claude Code (and a copy-paste setup page
  in the UI for Claude Code, Cursor, Codex) that teaches the publish → review
  → fix loop.
- Review loop is **pull**: the person asks the agent to "read the comments
  and fix"; the agent fetches unresolved comments. Pushing comments into a
  live session is not in v1.

### 3.12 Operations

- `pinwall backup` writes one **self-contained** archive: a consistent
  snapshot of the database and every referenced file, whatever the storage
  setup. `pinwall restore` rebuilds an installation from it into **any**
  supported storage setup, which is also the upgrade path from SQLite + local
  disk to Postgres + S3 **(builder's call)**. Both are covered by automated
  tests.
- `/healthz`, `/readyz`, Prometheus `/metrics`, structured JSON logs.
- No telemetry sent anywhere.

### 3.13 Release and trust

- Multi-arch image, non-root, read-only root filesystem, small (target well
  under 200 MB compressed **(builder's call)**).
- Signed images and release artifacts with provenance attestations and an
  SBOM; versioned with SemVer; images referenced by digest in the chart.

## 4. Look and feel

Decided with mockups during design:

- **Visual style "B — neutral, ChatGPT-like"**: white and greys, sans-serif,
  black rounded primary buttons, the interface stepping back so the artifact's
  own colors stand out. One accent color for identity. Dark mode follows the
  system setting from day one.
- **App shell like Claude / ChatGPT**: a collapsible left sidebar with
  "+ New project", search, "All artifacts", the **Projects** list, and
  **Recent** artifacts; account at the bottom. Opening an artifact collapses
  the sidebar to an icon rail.
- **Project page**: title, counts, the agent-instructions box, artifacts as a
  **thumbnail grid** (name, version, comment count, sharing state).
  Thumbnails come from the artifact's `og:image` or first image, else a
  generated card from its title and theme color; real screenshots may come
  later through an optional renderer **(builder's call: no headless browser
  in the main image)**.
- Learn from Claude's and OpenAI's interfaces: simple, quiet, effective.
- UI text is English only in v1, built on an i18n framework so other
  languages can be added by translation alone.
- A real favicon and app icon.

## 5. Non-goals for v1

- Fine-grained permissions or per-project membership (beyond admin/member
  from the IdP and share links).
- Mermaid/SVG, image, PDF or video artifacts as their own types.
- Pushing comments into a running agent session.
- Hosted SaaS, multi-tenancy, billing.
- Running server-side code or build steps for artifacts.
- Git-backed history, import from plannotator, a docs website or public demo
  instance, UI languages other than English.
- Per-email allowlists for outside viewers (§3.9).
- Several Pinwall instances serving one installation (HA); v1 runs one
  instance (§3.1).
- Chunked or resumable uploads (§3.5).
- Provider-specific group lookups such as Google's Directory API (§3.2).

## 6. Anti-goals — failure even if it technically works

- Requiring a second domain, Kubernetes or Postgres to get started.
- An agent needing a long-lived secret in its shell to publish.
- Any raw JSON or stack trace shown to a person in a browser.
- Silent failure: an operation that reports success without having done the
  work (the class of bug behind their #131).
- Content that can act with the application's session in either isolation
  mode.
- Copying plannotator's interface or branding.
- Phoning home.

## 7. Constraints

- TypeScript end to end: Node.js 24 LTS, Hono for the HTTP server, React +
  Vite for the interface. The official MCP TypeScript SDK.
- Apache-2.0.
- One container image; SQLite by default.
- Must work behind a TLS-terminating reverse proxy or tunnel (Cloudflare
  Tunnel, nginx, Traefik) with a configured public origin; never trust
  forwarded headers unless configured to.
- Responses must survive intermediaries: `Cache-Control: no-transform` on
  content, so proxies such as Cloudflare do not rewrite pages.

## 8. Left to the builder

Database access layer and migration tool, UI component library, MCP tool
names and schemas, the anchoring algorithm's details, SSE vs WebSocket for
live updates, rate-limit and quota defaults, thumbnail generation details,
OIDC library, passkey library, test strategy and CI layout, the exact size
target of the image, and the order of work.

## 9. Acceptance — v1 is done when

1. `docker run -v pinwall:/data -p 8080:8080 ghcr.io/dungnguyenv/pinwall` and
   the setup link give a working single-domain installation in under five
   minutes.
2. In Claude Code: `claude mcp add --transport http pinwall <origin>/mcp`,
   sign in through the browser, then "publish ./site to Pinwall" returns a
   review link within a minute — with no CLI installed and no token pasted.
3. The same with OIDC against Zitadel and Keycloak with groups mapped to
   admin/member, and against Google with admins and members given by email
   and domain lists; an unadmitted identity gets the "use a different
   account" page.
3a. From Claude Desktop (no shell), a single HTML file is published inline
   and gets a review link.
3b. A member removed from the IdP group loses access to the browser, MCP and
   API within 24 hours with no admin action, and immediately after "Revoke
   now".
4. A comment pinned on v1, "read the comments and fix" in Claude Code, and an
   open review tab switches to v2 with the comment still anchored and marked
   resolved in v2.
5. A multi-page artifact with nested iframes, videos and `#anchor` links
   looks and behaves the same in review as on its raw link, in both
   isolation modes.
6. Backup on one machine, restore on another, everything present; and a
   SQLite + local-disk backup restored into Postgres + S3.
7. Search for "chup anh" finds an artifact containing "chụp ảnh".
8. Behind Cloudflare Tunnel, raw and share links deliver pages
   byte-for-byte as published.
9. Deleting a version that contained a secret: its links answer "gone" at
   once, and its files are removed from storage unless another version still
   uses them.
10. Switching the isolation mode and restarting leaves every artifact link
    and share link working.

## 10. Decided while writing (owner to check)

The builder's calls above, in one place, so the owner can veto any of them:

1. Owner account: passkey with password fallback, created through a one-time
   setup link printed in the log (§3.2).
2. Google and other IdPs without a groups claim: roles from email and domain
   lists; no provider-specific code (§3.2).
3. Single-domain mode serves content under a path prefix, not subdomains, so
   it needs no wildcard DNS or certificate (§3.3).
4. Content is authorized by capability tokens in the URL, never by cookies on
   the content side; artifact and share links live on the app origin and
   survive a mode switch (§3.3).
5. Web upload by drag and drop is in v1 (§3.5).
6. Inline publish capped at 2 MB by default; one upload request capped at
   95 MB by default; chunked upload after v1 (§3.5).
7. The review viewer frames the content URL, not `srcdoc` (§3.7).
8. The comment annotator is injected only into review-mode HTML, never into
   raw or share links, and never relaxes the artifact's own CSP (§3.8).
9. Share-link viewers see and write comments only if the link allows it
   (§3.8).
10. No per-email allowlists for outside viewers in v1 (§3.9).
11. Accent-insensitive search with SQLite FTS5 / Postgres `unaccent` (§3.10).
12. Backups are self-contained and restore into any storage setup (§3.12).
13. Infrastructure settings come only from environment variables (§3.1).
14. Image well under 200 MB; thumbnails from `og:image` / first image /
    generated card, no headless browser in the main image (§3.13, §4).
