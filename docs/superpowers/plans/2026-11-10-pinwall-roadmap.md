# Pinwall v1 Implementation Plan — Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Pinwall v1 — a self-hosted, open-source home for the pages AI agents make — exactly as the spec describes, shipped complete before the first public release.

**Architecture:** One Node.js 24 process. Hono serves the app origin (REST API, OAuth 2.1 authorization server, MCP endpoint, one-time upload URLs, the React SPA) and the artifact content (under `/c/<token>/` in single-domain mode, or on `<token>.<content host>` in content-domain mode). Kysely talks to SQLite (default) or PostgreSQL; a `BlobStore` talks to local disk (default) or S3. Everything that would have to be shared between several instances later sits behind an interface with an in-process implementation now.

**Tech Stack:** TypeScript, Node.js 24 LTS, pnpm workspaces, Hono + `@hono/node-server` + `@hono/zod-openapi`, zod, Kysely + better-sqlite3 + pg, `@aws-sdk/client-s3`, tar-stream + fflate, markdown-it + highlight.js, htmlparser2, openid-client, `@simplewebauthn/server|browser`, `@modelcontextprotocol/sdk`, pino, @prometheus-io/client, diff, tldts; React 19 + Vite + Tailwind CSS v4 + Radix UI + TanStack Query + React Router + react-i18next + lucide-react; esbuild for the annotator and server bundle; Vitest, Testing Library, oidc-provider (test IdP), Playwright; Biome for lint/format.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` — the plan argues from it; read both.

**How this plan is organized:** this roadmap fixes everything milestones share: repository layout, module boundaries, names, configuration, data model, routes, security model, and the annotator protocol. Each milestone has its own task-level plan, `docs/superpowers/plans/2026-11-10-pinwall-mN-<name>.md`, written against the real code once the milestones it depends on are merged. A milestone plan may refine anything here; if it changes a shared name, it updates this file in the same commit.

---

## Global Constraints

Every task's requirements implicitly include these. Values are copied from the spec.

- TypeScript end to end: Node.js 24 LTS, Hono for the HTTP server, React + Vite for the interface, the official MCP TypeScript SDK.
- License Apache-2.0; every package's `package.json` says `"license": "Apache-2.0"`.
- One container image; SQLite by default (WAL mode), blobs on local disk by default; PostgreSQL and S3-compatible storage optional, selected by configuration.
- One running instance in v1. Live-update fan-out, one-time upload URLs, OAuth codes, rate-limit counters and migration runs go behind interfaces with in-process (or DB-backed) implementations.
- Configuration by environment variables only for infrastructure settings, with a `*_FILE` variant for every secret. The admin UI shows and explains them; it never edits them.
- Never trust forwarded headers unless `PINWALL_TRUST_PROXY` says so. Every absolute URL, cookie flag and redirect is built from `PINWALL_PUBLIC_ORIGIN`, never from `Host` or `X-Forwarded-*`.
- `Cache-Control: no-transform` on every content response.
- Browser-facing errors are HTML pages, never raw JSON or stack traces.
- Default limits: one publish request ≤ 95 MB (`95_000_000` bytes); inline MCP publish ≤ 2 MB (`2_000_000` bytes) total.
- Access re-check with the IdP at least once every 24 hours (default 12 h, configurable, never above 24 h).
- Search is accent-insensitive: SQLite FTS5 `unicode61 remove_diacritics 2`; PostgreSQL `unaccent`. Vietnamese must match with and without diacritics.
- UI text in English only, every string through i18n (`react-i18next` in the SPA, the same `en.json` on the server).
- No telemetry, no request to any third party except the configured IdP and storage.
- Image: multi-arch (amd64, arm64), non-root, read-only root filesystem, well under 200 MB compressed, no headless browser.
- Visual style "B — neutral, ChatGPT-like"; dark mode follows the system setting.
- Do not copy plannotator's interface or branding.
- **Original work only.** Never copy code, prompts, skill text, documentation, tests, UI markup or styles from another project into this repository — not verbatim and not lightly edited — including plannotator `artifact-server` and its installed `artifact-server` skill, and any other repository, gist or blog. Learn ideas from public docs and standards (RFCs, W3C, MDN, library docs), then write your own. Using a library through its public API is fine; vendoring its source is not. Short snippets from a dependency's own docs (an import line, a config option) are fine.
- Dependencies must carry a license compatible with Apache-2.0 (MIT, ISC, BSD-2/3, Apache-2.0, 0BSD, BlueOak, CC0, Unlicense, Unicode, Python-2.0/PSF-2.0; MPL-2.0 only for build-time tools that never ship in the image or a bundle, e.g. lightningcss under Tailwind). No GPL, LGPL, AGPL, SSPL, BUSL, or unlicensed packages; check before adding one. M9 adds an automated license check and a `NOTICE` listing bundled third-party licenses.
- Conventional Commits; commit messages end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work stays local: no `git push`, no image push, no GitHub repository creation.

## Review Focus

Input classes the spec implies but no acceptance item names, most likely to bite first. Each has its test in the owning milestone.

1. **Unicode from macOS.** Archive entry names arrive in NFD, links in HTML in NFC; Vietnamese `đ`/`Đ` has no decomposition. Expected: file lookup matches regardless of normalization form; search for "dien thoai" finds "điện thoại". Owners: M1 Task 2 (`foldForSearch`), M4 (path normalization to NFC at ingest and at lookup).
2. **Behind a TLS-terminating proxy or tunnel.** The server sees `http://` and an internal `Host`. Expected: cookies are `Secure`, redirects, OAuth metadata and links all use the public origin. Owners: M1 Task 7 (`publicUrl` helper ignores `Host`), M2 (cookie flags), M6 (metadata documents).
3. **Agent retries an upload.** `curl` is retried after the publish succeeded but the response was lost, or after the URL expired. Expected: no duplicate version; the error says the session was already used and names the version it created, or says it expired and how to get a new one. Owner: M4.
4. **Upload rejected mid-stream** (too large, too many files, expansion bomb, path traversal, symlink, absolute path). Expected: a 4xx naming the exact reason; no version row, and no orphaned blobs left behind. Owner: M4.
5. **Archives made on macOS or by hand.** `__MACOSX/`, `._*`, `.DS_Store` entries, and a single wrapping folder (`tar -czf site.tgz site/`). Expected: junk skipped, a lone wrapping folder stripped, so the entry page resolves. Owner: M4.

---

## Repository layout

```
pinwall/
  package.json              # private workspace root: scripts build, test, lint, typecheck
  pnpm-workspace.yaml       # apps/*, packages/*
  tsconfig.base.json        # strict, ES2023, moduleResolution bundler
  biome.json
  Dockerfile  .dockerignore  docker-compose.test.yml   # test stack: postgres + minio
  LICENSE  NOTICE  README.md
  apps/
    server/                 # @pinwall/server — HTTP server + `pinwall` CLI
      src/
        main.ts             # CLI: serve | migrate | backup | restore
        deps.ts             # createDeps(config) → AppDeps
        app.ts              # buildApp(deps) → Hono<AppEnv>
        config/             # env schema, loader, secret key
        lib/                # ids, errors, clock, crypto, search folding
        db/                 # schema.ts (Kysely types), connect.ts, migrations/
        storage/            # BlobStore: local.ts, s3.ts
        infra/              # event-bus, one-time-store, rate-limiter, leases, scheduler
        http/               # middleware: request id, logging, security headers, origin check, errors, client ip, public url
        pages/              # server-rendered HTML (hono/jsx): error page, sign-in result pages
        auth/               # users, sessions, owner (password, passkey), api tokens, oidc, access re-check
        oauth/              # OAuth 2.1 authorization server for /mcp
        publish/            # ingest (archives, single files, inline), limits, upload sessions
        content/            # grants, content serving, annotator injection, markdown rendering, metadata extraction
        domain/             # projects, artifacts, versions, comments, shares, search, deletion + GC, diff
        api/                # REST routes (zod-openapi), one file per resource
        mcp/                # MCP server and tools
        ops/                # backup, restore, metrics
      test/                 # Vitest; helpers/ for test contexts
    web/                    # @pinwall/web — React SPA (Vite)
  packages/
    shared/                 # @pinwall/shared — API DTO zod schemas, annotator protocol types, i18n/en.json
    annotator/              # @pinwall/annotator — in-page script, bundled to one IIFE file
  skills/pinwall/SKILL.md   # Agent Skill for Claude Code
  deploy/helm/pinwall/  deploy/compose/
  .github/workflows/
  docs/
```

## Module boundaries and shared names

- `AppDeps` (`apps/server/src/deps.ts`): `{ config: Config; db: DbHandle; blobs: BlobStore; events: EventBus; oneTime: OneTimeStore; rateLimiter: RateLimiter; leases: LeaseManager; scheduler: Scheduler; logger: Logger; clock: Clock }`. Services are plain modules or factories taking `AppDeps`; no DI container.
- `AppEnv` (`apps/server/src/app.ts`): `{ Variables: { requestId: string; deps: AppDeps; auth: AuthContext | null } }`. `AuthContext = { user: UserRow; via: 'session' | 'api_token' | 'oauth'; sessionId?: string }`.
- Errors: `AppError(code: ErrorCode, status: number, message: string, details?: Record<string, unknown>)` in `apps/server/src/lib/errors.ts`. `ErrorCode` is one of `bad_request, unauthorized, forbidden, not_found, conflict, version_conflict, gone, payload_too_large, unsupported_media_type, rate_limited, upload_session_used, upload_session_expired, setup_required, setup_done, invalid_credentials, access_denied, internal`. JSON error body: `{ "error": { "code", "message", "details"? } }`.
- IDs: `newId(prefix)` → `<prefix>_<20 lowercase Crockford base32 chars>`; prefixes `usr prj art ver cmt shr tok cli pky gnt`. Content tokens: `newContentToken()` → 32 lowercase base32 chars (160 bits; valid DNS label). Bearer secrets: `newSecret()` → 43 base64url chars; API tokens are `pw_` + secret. Only SHA-256 hashes of secrets are stored (`hashSecret`).
- Time: all timestamps are integer epoch milliseconds in the DB and in the API (`*_at` fields). Code reads time only through `deps.clock.now()`.
- API conventions: JSON, `snake_case` fields, list endpoints return `{ items, next_cursor }`, cursor-based (opaque base64url). DTO schemas live in `@pinwall/shared` and are used by the server routes and the SPA alike.
- Server-side i18n: `t(key, vars?)` from `apps/server/src/lib/i18n.ts` reading `@pinwall/shared/i18n/en.json`.

## Configuration

`loadConfig(env)` in `apps/server/src/config/load.ts` returns `Config`; every secret also accepts `<NAME>_FILE`. Durations accept `ms` integers or `30s 15m 12h 7d`; sizes accept bytes or `KB MB GB` (decimal) and `KiB MiB GiB`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PINWALL_PUBLIC_ORIGIN` | `http://localhost:8080` | Origin only, no path. Source of every absolute URL. |
| `PINWALL_HOST` / `PINWALL_PORT` | `0.0.0.0` / `8080` | |
| `PINWALL_DATA_DIR` | `/data` | SQLite file, local blobs, generated secret key. |
| `PINWALL_DATABASE_URL` | `sqlite:<data dir>/pinwall.db` | `sqlite:<path>` or `postgres://…` (`_FILE` allowed). |
| `PINWALL_DATABASE_POOL_SIZE` | `10` | Postgres only. |
| `PINWALL_STORAGE` | `local` | `local` or `s3`. |
| `PINWALL_S3_BUCKET`, `_REGION` (`us-east-1`), `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_FORCE_PATH_STYLE` (`false`), `_PREFIX` (empty) | | Keys accept `_FILE`. |
| `PINWALL_ISOLATION` | `single-domain` | or `content-domain`. Change = restart. |
| `PINWALL_CONTENT_ORIGIN` | — | Required for `content-domain`, e.g. `https://pinwall-content.example`; content URLs are `<scheme>://<token>.<host>[:port]/`. Must not equal the app host or a parent of it; a warning is logged when it shares the app's registrable domain. |
| `PINWALL_SECRET_KEY` | generated | ≥ 32 bytes, base64 or hex. If unset, generated once into `<data dir>/secret.key` (mode 0600). Keys for encryption and HMAC are derived from it with HKDF per purpose. |
| `PINWALL_TRUST_PROXY` | `false` | `true` or a comma list of CIDRs; only then is `X-Forwarded-For` used for the client IP. |
| `PINWALL_OIDC_ISSUER`, `PINWALL_OIDC_CLIENT_ID`, `PINWALL_OIDC_CLIENT_SECRET` | — | All OIDC is off unless issuer + client id are set. |
| `PINWALL_OIDC_SCOPES` | `openid email profile offline_access` | |
| `PINWALL_OIDC_DISPLAY_NAME` | `Single sign-on` | Sign-in button label. |
| `PINWALL_OIDC_EXTRA_AUTH_PARAMS` | empty | `k=v&k=v`, e.g. `access_type=offline` for Google. |
| `PINWALL_OIDC_ROLES_CLAIM` | — | Claim holding groups/roles (string, array, or object keys). |
| `PINWALL_OIDC_ADMIN_GROUPS`, `PINWALL_OIDC_MEMBER_GROUPS` | — | Comma lists. |
| `PINWALL_ADMIN_EMAILS`, `PINWALL_MEMBER_EMAILS`, `PINWALL_MEMBER_DOMAINS` | — | Comma lists; verified emails only. If no member group/email/domain is set, every IdP identity is a member. |
| `PINWALL_ACCESS_RECHECK_INTERVAL` | `12h` | Must be ≤ `24h`. |
| `PINWALL_MAX_UPLOAD_BYTES` | `95000000` | One request. |
| `PINWALL_MAX_INLINE_BYTES` | `2000000` | MCP inline publish total. |
| `PINWALL_MAX_FILE_BYTES` | `50000000` | One file inside a version. |
| `PINWALL_MAX_VERSION_BYTES` | `500000000` | Expanded size of a version. |
| `PINWALL_MAX_FILES` | `10000` | Files per version. |
| `PINWALL_MAX_EXPANSION_RATIO` | `100` | Expanded ÷ compressed. |
| `PINWALL_SESSION_TTL` | `30d` | Sliding browser session. |
| `PINWALL_PREVIEW_TTL` | `12h` | Content grants for viewers and raw links. |
| `PINWALL_UPLOAD_SESSION_TTL` | `10m` | |
| `PINWALL_METRICS_PORT` | `9464` | Separate listener for `/metrics`; `0` disables. |
| `PINWALL_LOG_LEVEL` | `info` | |
| `PINWALL_WEB_DIR` | bundled | Directory of the built SPA. |

## Data model

Migration `0001_initial` (M1) creates every table below; later milestones add migrations only for changes. Portable column types: ids and strings `text`; timestamps, sizes and counters `bigint` on Postgres / `integer` on SQLite (pg `int8` parsed to `number`); booleans `integer` 0/1 in both; JSON as `text`.

| Table | Columns (PK first) |
| --- | --- |
| `users` | `id`, `kind` (`owner`/`oidc`), `email`, `email_verified`, `name`, `avatar_url`, `idp_role` (`admin`/`member`/null), `role_override` (`admin`/`member`/`blocked`/null), `oidc_issuer`, `oidc_subject` (unique with issuer), `idp_refresh_token` (encrypted), `idp_checked_at`, `disabled_at`, `disabled_reason`, `created_at`, `last_seen_at` |
| `password_credentials` | `user_id` (FK users, cascade), `hash`, `updated_at` |
| `passkeys` | `id`, `user_id` (FK cascade), `credential_id` (unique), `public_key`, `counter`, `transports` (JSON), `name`, `created_at`, `last_used_at` |
| `sessions` | `id_hash`, `user_id` (FK cascade), `auth_method`, `created_at`, `expires_at`, `last_seen_at`, `ip`, `user_agent` |
| `api_tokens` | `id`, `user_id` (FK cascade), `name`, `token_hash` (unique), `prefix`, `created_at`, `last_used_at`, `expires_at`, `revoked_at` |
| `oauth_clients` | `id`, `name`, `redirect_uris` (JSON), `created_at`, `last_used_at` |
| `oauth_grants` | `id`, `client_id` (FK cascade), `user_id` (FK cascade), `resource`, `scope`, `created_at`, `last_used_at`, `revoked_at` |
| `oauth_tokens` | `token_hash`, `grant_id` (FK cascade), `kind` (`access`/`refresh`), `created_at`, `expires_at`, `used_at` |
| `projects` | `id`, `name`, `instructions`, `is_default`, `archived_at`, `created_by` (FK users, set null), `created_at`, `updated_at` |
| `artifacts` | `id`, `project_id` (FK projects), `name`, `kind` (`html`/`markdown`), `current_version_id`, `latest_number`, `created_by` (FK users, set null), `created_at`, `updated_at` |
| `artifact_tags` | (`artifact_id` FK cascade, `tag`) |
| `artifact_views` | (`user_id` FK cascade, `artifact_id` FK cascade), `viewed_at` — feeds "Recent" |
| `versions` | `id`, `artifact_id` (FK cascade), `number` (unique with artifact), `parent_version_id`, `entry_path`, `title`, `theme_color`, `thumbnail_path`, `file_count`, `total_bytes`, `message`, `source` (`mcp`/`inline`/`api`/`web`/`restore`), `restored_from_version_id`, `meta` (JSON: warnings), `created_by` (FK users, set null), `created_at` |
| `version_files` | (`version_id` FK cascade, `path`), `sha256`, `size`, `content_type` |
| `blobs` | `sha256`, `size`, `created_at` |
| `content_grants` | `token`, `version_id` (FK cascade), `mode` (`review`/`raw`), `share_link_id` (FK cascade, null), `created_at`, `expires_at` |
| `share_links` | `id`, `artifact_id` (FK cascade), `version_id` (FK cascade, null = follow current), `token_hash` (unique), `password_hash`, `allow_comments`, `expires_at`, `created_by` (FK set null), `created_at`, `last_used_at`, `revoked_at` |
| `comments` | `id`, `artifact_id` (FK cascade), `version_id` (FK cascade — the version it was written on), `parent_id` (FK cascade, null = thread root), `author_user_id` (FK set null), `guest_name`, `share_link_id` (FK set null), `body`, `anchor` (JSON, roots only), `status` (`open`/`resolved`, roots only), `resolved_in_version_id` (FK set null), `resolved_by` (FK set null), `resolved_at`, `created_at`, `updated_at`, `edited_at` |
| `leases` | `name`, `holder`, `expires_at` |
| `tombstones` | (`kind` `artifact`/`content_grant`/`share_link`, `key` = artifact id / grant token / share `token_hash`), `deleted_at`, `expires_at` (null = kept) — migration `0002_publishing` (M4), which also indexes `version_files(sha256)`. Deleted things answer 410 from here. Blob GC defers while lease `maintenance:backup` is held. |
| `search_index` | SQLite: FTS5 virtual table `(artifact_id UNINDEXED, name, tags, body)` with `tokenize='unicode61 remove_diacritics 2'`. Postgres: table `(artifact_id PK FK cascade, name, tags, body, document tsvector)` + GIN index, `CREATE EXTENSION IF NOT EXISTS unaccent`. Text is passed through `foldForSearch` before indexing and querying in both. |

Effective role: `role_override ?? (kind = 'owner' ? 'admin' : idp_role)`; `blocked` or `disabled_at` set means no access. Deleting a version deletes the comment threads written on it (the UI says so).

## Routes

App origin (`PINWALL_PUBLIC_ORIGIN`):

| Path | Purpose | Milestone |
| --- | --- | --- |
| `GET /healthz`, `GET /readyz` | liveness; readiness (DB + blob store) | M1 |
| `/api/v1/*` | REST API (OpenAPI at `/api/v1/openapi.json`); cookie session or bearer | M2+ |
| `/api/v1/auth/*` | setup, password, passkeys, sign-out | M2 |
| `GET /auth/oidc/start`, `GET /auth/oidc/callback` | OIDC browser redirects | M3 |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | OAuth metadata | M6 |
| `POST /oauth/register`, `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke` | OAuth 2.1 AS for MCP; `/oauth/authorize` hands off to SPA route `/oauth/consent?request=<id>` | M6 |
| `GET /api/v1/oauth/requests/:id`, `POST /api/v1/oauth/requests/:id/decision` | consent page API (session only): GET → `{ client_name, client_uri, redirect_host, scopes, user: { name, email } }`; POST `{ approve: boolean }` → `{ redirect_to }` (the SPA then sets `window.location`). DTOs `OAuthConsentRequest` (`client_uri` and `user.email` nullable), `OAuthDecisionRequest` and `OAuthDecisionResult` live in `packages/shared/src/api/oauth-consent.ts`, defined by M7 and served by M6 | M6 (page and DTOs in M7) |
| `GET /api/v1/admin/config` | admin only: effective settings as `AdminConfig` (`packages/shared/src/api/admin-config.ts`), one entry per env var name, secrets never included (only whether they are set) | M7 |
| `/mcp` | MCP Streamable HTTP; bearer only (OAuth access token or API token) | M6 |
| `POST /upload/:token` | one-time upload URL; no cookies, no bearer | M4 |
| `GET /a/:artifactId/raw`, `GET /a/:artifactId/v/:n/raw` | members: redirect to a fresh raw content grant | M4 |
| `GET /s/:shareToken` | share link: password page → share viewer (if comments allowed) or redirect to raw content | M5 |
| `GET /c/:contentToken/*` | content, single-domain mode only (404 in content-domain mode) | M4 |
| everything else (`GET`, `Accept: text/html`) | SPA `index.html`: `/`, `/projects/:id`, `/a/:id`, `/a/:id/v/:n`, `/a/:id/compare`, `/search`, `/settings/*`, `/admin/*`, `/signin`, `/setup`, `/oauth/consent`, `/connect`, `/s/:token` (viewer) | M7/M8 |

Content host (content-domain mode): `<contentToken>.<content host>/*`. Both modes reserve the path `__pinwall/` inside a grant: `__pinwall/annotator.js`, `__pinwall/markdown.css`.

User-facing links always live on the app origin (`/a/:id`, `/a/:id/v/:n`, `/s/:token`) and resolve to a content URL in whichever mode is current; raw content URLs are never handed out as permanent links.

## Security model

- **Sessions:** cookie `__Host-pinwall_session` when the public origin is https (else `pinwall_session`), `HttpOnly; Secure (https); SameSite=Lax; Path=/`, value a 32-byte secret, stored as a hash, sliding expiry `PINWALL_SESSION_TTL`.
- **CSRF:** a cookie-authenticated request with a method other than GET/HEAD/OPTIONS is accepted only if `Origin` equals the public origin (missing or `null` is rejected) and `Sec-Fetch-Site`, when present, is `same-origin`. Bearer requests do not read cookies. `/mcp` and `/upload/*` never read cookies.
- **App pages** send `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src <content>; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`, where `<content>` is `'self'` in single-domain mode and `<scheme>://*.<content host>[:port]` in content-domain mode (the lesson of their #132). Plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`, and HSTS when https.
- **Content responses** never read cookies and never set them. Every one carries `Cache-Control: private, max-age=300, no-transform`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. In single-domain mode every content response also carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation` (no `allow-same-origin`). Content requests are authorized only by the content token. App routes are never served on content hosts, and content never under app routes.
- **Review frame:** `<iframe sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation">` pointing at the content URL. Never `srcdoc`.
- **Annotator:** injected only into `text/html` responses of `review` grants, as `<script src="<grant base>/__pinwall/annotator.js" data-pinwall-annotator></script>` right after `<head>` (or at the top when there is no head). The viewer sends anchors and pin numbers to the page, never comment bodies.
- **Thumbnails** served from the app origin are raster images only (png, jpeg, webp, gif, avif), with `Content-Security-Policy: default-src 'none'; sandbox`; SVG thumbnails fall back to the generated card.
- **Rate limits** on sign-in, password, passkey, setup, OAuth token, share-password unlock and upload creation.

## Annotator ↔ viewer protocol

Types in `packages/shared/src/protocol.ts`. Every message is `{ pinwall: 1, type, ... }`; the viewer accepts a message only when `event.source` is its iframe's window or one of that window's descendant frames.

```ts
type Anchor = {
  page: string;                                   // file path in the version, e.g. "docs/index.html"
  kind: 'text' | 'element' | 'point';
  quote?: { exact: string; prefix: string; suffix: string };  // text anchors
  dom?: { path: string };                         // CSS selector path from <body>
  position: { x: number; y: number };             // fractions (0..1) of the document's scroll size
  viewport: { width: number };                    // frame width when created
};
// page → viewer
| { type: 'ready'; page: string; frameId: string }
| { type: 'anchor-picked'; anchor: Anchor; frameId: string }          // user chose a spot in comment mode
| { type: 'anchors-placed'; results: { id: string; found: boolean }[]; frameId: string }
| { type: 'pin-clicked'; id: string }
| { type: 'navigated'; page: string; frameId: string }
// viewer → page
| { type: 'set-mode'; mode: 'browse' | 'comment' }
| { type: 'show-anchors'; anchors: { id: string; number: number; resolved: boolean; anchor: Anchor }[] }
| { type: 'focus-anchor'; id: string }
```

## MCP tools (M6)

`whoami`, `list_projects`, `get_project` (includes agent instructions), `create_project`, `list_artifacts`, `search_artifacts`, `get_artifact` (versions and links), `create_publish_session`, `publish_inline`, `list_comments`, `reply_to_comment`, `resolve_comment`, `create_share_link`, `list_share_links`, `revoke_share_link`. M6 fixes schemas; `skills/pinwall/SKILL.md` documents them.

---

## Milestones

| # | Milestone | Plan file | Depends on | Status |
| --- | --- | --- | --- | --- |
| M1 | Foundation | `…-m1-foundation.md` | — | planned |
| M2 | Owner account, sessions, API tokens | `…-m2-identity.md` | M1 | |
| M3 | OIDC, roles, access re-check | `…-m3-oidc.md` | M2 | |
| M4 | Publishing and content serving | `…-m4a-publishing-core.md` (Tasks 1–6), `…-m4b-publishing-http.md` (Tasks 7–13) | M2 | |
| M5 | Comments, sharing, live updates, annotator | `…-m5-review-server.md` | M4 | |
| M6 | MCP, OAuth authorization server, agent skill | `…-m6-mcp.md` | M3, M5 | |
| M7 | Web app: shell, library, accounts, admin | `…-m7a-web-shell.md` (Tasks 1–7), `…-m7b-web-accounts-admin.md` (Tasks 8–12) | M3, M4 | |
| M8 | Web app: review, compare, comments, sharing | `…-m8-web-review.md` | M5, M7 | |
| M9 | Operations and release | `…-m9-ops-release.md` | M6, M8 | |

M3 and M4 can run in parallel, as can M5 with M7, and M6 with M8 — each pair on its own git worktree and branch, merged into `main` when done.

### M1 Foundation (spec §3.1, §3.12 health, §7)
Workspace, config loader, DB layer with the full initial schema on SQLite and Postgres, blob stores (local, S3), infra primitives, HTTP skeleton (security headers, HTML/JSON errors, health, SPA fallback), `pinwall serve|migrate`, Dockerfile, test stack. **Done when** `pnpm lint && pnpm typecheck && pnpm test` pass, the Postgres/MinIO suites pass against `docker-compose.test.yml`, and the image answers `/healthz` running read-only.

### M2 Owner account, sessions, API tokens (§3.2)
Setup link printed at first start; owner created with password and/or passkey; password and passkey sign-in; sessions and sign-out; CSRF origin check; personal API tokens; `GET /api/v1/me`; `GET /api/v1/config/public` (setup needed, OIDC enabled + label, isolation mode, limits); admin users list, role override, **Revoke now** (sessions, API tokens, OAuth grants); auth middleware resolving cookie or bearer into `AuthContext`; rate limits. **Done when** API tests prove: setup link works once; owner signs in by password and by a software passkey; a token authenticates `/api/v1/me`; cross-origin POST with a session cookie is refused; cookies carry `Secure` when the public origin is https even though requests arrive over http; Revoke now ends every credential.

### M3 OIDC, roles, access re-check (§3.2; acceptance 3, 3b)
openid-client login with PKCE and state, `prompt=select_account` retry, role mapping from claim or email/domain lists, sign-in restriction, HTML "no access" page showing who signed in with "Use a different account", encrypted IdP refresh token, re-check job (≤ 24 h) that disables people removed from the IdP or groups and ends their credentials. **Done when** tests against an in-process `oidc-provider` IdP cover admin/member by groups, by emails/domains, denial page, and a removed member losing browser, API and token access after the re-check.

### M4 Publishing and content serving (§3.3–3.6, §3.10; acceptance 7–10 server side)
Archive ingest (tar, tar.gz, zip, single file) with every limit and the Review Focus 3–5 cases, content-addressed storage, projects (default project, instructions, archive), artifacts, versions (optimistic concurrency, restore), upload sessions and `/upload/:token`, web multipart upload endpoint, inline ingest service (used by M6), content grants and serving in both isolation modes (Range requests, MIME types, headers above, NFC lookup, directory index, absolute-link warnings), Markdown rendering (TOC, highlighting), metadata extraction (title, theme color, `og:image`/first image, text), search index, tags, source diff and rendered Markdown diff APIs, thumbnails, deletion and blob GC under a lease. **Done when** tests cover each and both isolation modes serve the same bytes.

### M5 Comments, sharing, live updates, annotator (§3.7 live update, §3.8, §3.9)
Comment threads (create with anchor, reply, edit, delete, resolve with version, reopen), permissions (author, publisher, admin), share links (public, password, expiry, per-artifact or per-version, revoke, allow comments, guest comments), `/s/:token` flow, SSE events (`version.published`, `comment.*`) via `EventBus`, the annotator package (text/element/point anchoring, re-attachment, pins, nested frames, `postMessage` protocol) and its injection into review HTML. **Done when** server tests and jsdom annotator tests pass and a Playwright smoke test pins a comment inside a nested frame.

### M6 MCP, OAuth AS, agent skill (§3.2 MCP OAuth, §3.11; acceptance 2, 3a, 4)
OAuth 2.1 AS (metadata, dynamic client registration, PKCE S256, resource indicator `<origin>/mcp`, consent request API, rotating refresh tokens, revocation, re-check on refresh), `/mcp` with the tool set above (bearer: OAuth or API token), publish session tool returning the `tar … | curl …` command, inline publish tool, `skills/pinwall/SKILL.md`, connect snippets for Claude Code, Cursor, Codex. **Done when** an MCP SDK client test completes the OAuth flow, publishes by upload URL and inline, lists and resolves comments; and `claude mcp add --transport http pinwall http://localhost:8080/mcp` works against a local server.

### M7 Web app: shell, library, accounts, admin (§4)
Design tokens (style B, light/dark), app shell with sidebar (+ New project, search, All artifacts, Projects, Recent, account), project page (counts, agent instructions box, thumbnail grid with generated cards; comment count and sharing state come from `ArtifactSummary.open_thread_count` and `share_link_count`, which M5 adds), All artifacts, search page, drag-and-drop upload, setup page, sign-in page (password, passkey, OIDC button), OAuth consent page, settings (profile, passkeys, API tokens), connect-an-agent page, admin (users with role override and Revoke now, configuration view with explanations of both isolation modes, served by the new `GET /api/v1/admin/config`), favicon and app icon, i18n wiring. **Done when** component tests pass and Playwright walks setup → sign-in → upload → project grid.

### M8 Web app: review, compare, comments, sharing (§3.6–3.9, §4)
Review viewer layout A (top bar with breadcrumb, version switcher, device sizes incl. custom width, compare, comments toggle with count, share; dockable comment panel; full-screen; sidebar collapsed to rail), pins via the annotator, comment composer and threads, live update (switch or offer to), compare (side by side, overlay slider, source diff, rendered Markdown diff), share dialog, share viewer page, delete version/artifact dialogs with the backup warning. **Done when** Playwright covers acceptance 4 (browser part) and 5 in both isolation modes.

### M9 Operations and release (§3.12, §3.13; acceptance 1, 6, 8 and the full suite)
`pinwall backup` / `pinwall restore` (self-contained archive, consistent snapshot under a lease, restore into any storage setup, refuses a non-empty target), Prometheus metrics, structured logs, final Dockerfile (multi-arch, non-root, read-only, size check), Helm chart, Compose example, GitHub Actions CI and release (cosign signing, provenance, SBOM, chart pinned by digest), README and author docs (opaque-origin consequences, isolation modes, Cloudflare notes), Keycloak e2e, and the Playwright acceptance suite for items 1–10. **Done when** every acceptance item is either automated and passing or listed with the manual check that proved it.

## Execution notes

- Implementers: Sonnet for mechanical tasks (scaffolding, CRUD routes, UI screens, chart, docs); Opus for security-sensitive or algorithmic tasks (auth, OIDC, OAuth AS, archive ingest, content serving and isolation, annotator anchoring, backup/restore) and for writing milestone plans.
- Reviews: one review per milestone over that milestone's diff, and one whole-branch review on the most capable model at the end. Implementers self-review and run the full test suite before each commit.
- Tests that need Postgres or S3 run when `PINWALL_TEST_POSTGRES_URL` / `PINWALL_TEST_S3_ENDPOINT` are set (`docker compose -f docker-compose.test.yml up -d` provides them) and are skipped otherwise, with the skip visible in the output.
