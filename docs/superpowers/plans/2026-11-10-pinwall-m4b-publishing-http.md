# Pinwall M4b — Publishing over HTTP and Content Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put M4a's publishing services on HTTP and serve what they store:
- one-time upload URLs (`/upload/:token`), plus REST for publishing, projects, artifacts, versions, diffs and deletion;
- capability-token content serving in both isolation modes, with Markdown rendering;
- previews, raw links and raster thumbnails.

**Architecture:**
- **Routes:** REST routes live in `api/` on M2's OpenAPI router. `POST /upload/:token` and the raw links `/a/:id/raw` and `/a/:id/v/:n/raw` are plain Hono routes on the app.
- **Content:** `content/` owns grants, the content router (`/c/:token/*` in single-domain mode, `<token>.<content host>` in content-domain mode) and Markdown pages. `mountContent` runs ahead of every app middleware that could add app headers or touch cookies.
- **Annotator:** injection is M5's. M4b leaves the `transformReviewHtml` hook in `mountContent` and serves review grants unmodified.
- **Deletion:** removes rows in one transaction, records tombstones so links answer 410, and hands the freed shas to M4a's `collectBlobs`.

**Tech Stack:** Hono 4 + `@hono/node-server` + `@hono/zod-openapi`, zod 4, Kysely, markdown-it 15 + markdown-it-anchor 10 + highlight.js 11 (`highlight.js/lib/common`), diff 9, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` (§3.3–3.6, §3.10; acceptance 7–10 server side).

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md` holds the shared names, data model, routes and Security model. Its Global Constraints apply to every task.

**Depends on:**
- **M4a** (`2026-11-10-pinwall-m4a-publishing-core.md`, Tasks 1–6). Read its "Interface handed to M4b".
- **M1:** `AppEnv`, `Config`, `publicUrl`, `wantsHtml`, `newContentToken`, `createTestContext`, `dialects`.
- **M2:** `buildApiRouter`/`registerXRoutes`, `jsonBodyLimit`, `page`, `Timestamp`, `Label`, `encodeCursor`/`decodeCursor`, `requireAuth`, `authOf`, `effectiveRole`, `hasAccess`, `resolveAuth`, `bearerResolvers`, `enforceRateLimit`, `RateRule`, `createSignedInUser`, `createUserToken`, `apiInit`, `setupOwner`.

Where merged code differs in a name or signature, the code wins: change the import and keep the behavior. Task numbers continue from M4a.

**Worktree:** M4 runs on its own worktree in parallel with M3. Keep code in `publish/`, `content/`, `domain/` and the new `api/` files. Shared files get additive lines only: `app.ts`, `main.ts`, `api/router.ts`, `db/schema.ts`, `db/migrations/index.ts`, `test/db/migrate.test.ts`, `packages/shared/src/api/index.ts` and `en.json`. Put every new en.json key in one block grouped by prefix (`publish.*`, `content.*`, `project.*`, `artifact.*`, `version.*`).

## Global Constraints

The roadmap's Global Constraints apply, plus these for M4:
- **Limits, verbatim:** `PINWALL_MAX_UPLOAD_BYTES` (request, counted while streaming), `PINWALL_MAX_FILE_BYTES`, `PINWALL_MAX_VERSION_BYTES`, `PINWALL_MAX_FILES`, `PINWALL_MAX_EXPANSION_RATIO`, `PINWALL_MAX_INLINE_BYTES`, read from `config.limits`. TTLs from `config.ttl.previewMs` (`PINWALL_PREVIEW_TTL`) and `config.ttl.uploadSessionMs` (`PINWALL_UPLOAD_SESSION_TTL`).
- **Atomic publish.** A rejected publish commits no artifact, version or file row. Every blob the failed upload added that no version references is removed.
- **Paths** are stored in NFC, at most 512 characters, relative, without `.`/`..`/empty segments, backslashes or control characters. `__pinwall/` is reserved in every version.
- **Content response headers, verbatim:** `Cache-Control: private, max-age=300, no-transform`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. In single-domain mode only, add `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation`. Content responses never read or set cookies and never carry app headers (`frame-ancestors`, `X-Frame-Options`). Content is authorized only by the token.
- **Links people hold live on the app origin** (`/a/:id`, `/a/:id/raw`, `/a/:id/v/:n/raw`). Content URLs are built per request from the current `config.isolation` and are never returned as permanent links.
- **Raw grants serve stored bytes unchanged** in both modes: no re-encoding, no charset conversion, no injection.
- **Version numbers are never reused.** The next number is `artifacts.latest_number + 1`, so the link of a deleted version answers gone, not someone else's content.
- **Both databases:** DB tests run in `describe.each(dialects)`. Search indexing during a commit or a delete goes through `searchUpsert/searchDelete({ db: trx, dialect })`, inside the transaction.
- **One migration:** `0002_publishing` (Task 3). It is the only schema change in M4.
- **i18n:** every message a person can read goes through `t()`, with the exact copy given in the task. Messages quote at most the first 100 characters of a path, ending in `…`.

## Review Focus

The list covers all of M4. Tasks 1–6 are in M4a, Tasks 7–13 in M4b.

1. **Unicode from macOS.** Archive names arrive in NFD, while links in HTML are NFC and percent-encoded. Vietnamese `đ` has no decomposition. Expected: names are stored in NFC, a request in either form or encoding finds the file, and NFC/NFD twins in one archive count as duplicates. → Task 1 `normalizes NFD names to NFC`; Task 6 `NFD names are stored in NFC` and `a rejected upload …: duplicate`; Task 9 `finds a file whatever the normalization form and percent-encoding`.
2. **An agent retries an upload.** The retry comes after a success whose response was lost, or after the URL expired. Expected: no duplicate version. The error says the URL was used and names the version it made, or says it expired and how to get a new one. → Task 7 `a retried upload names the version it created`, `an expired session says how to get a new one`.
3. **An upload rejected mid-stream:** too large, too many files, expansion bomb, traversal, link, absolute path. Expected: a 4xx naming the exact reason and limit, no version row, no orphaned blob. → Task 6 `a rejected upload leaves no version and no orphan blobs: %s`; Task 7 `an oversized streamed body is 413 without Content-Length`.
4. **Archives made on macOS or by hand:** `__MACOSX/`, `._*`, `.DS_Store`, and a lone wrapping folder (`tar -czf site.tgz site/`). Expected: junk skipped, folder stripped, entry page found. → Task 1 `skips macOS junk and directories`, `strips one wrapping folder`; Task 6 `macOS junk is skipped and a wrapping folder stripped`.
5. **The documented command as curl really sends it.** curl sends the body chunked, without `Content-Length`, with `Content-Type: application/x-www-form-urlencoded` and `Expect: 100-continue`. Expected: Pinwall detects the archive by its magic bytes, counts the limit on streamed bytes, and publishes. → Task 6 `curl's default content type is ignored for archives`; Task 7 `the documented command publishes over a real socket`.

---

### Task 7: Publish sessions, `/upload/:token`, REST inline and web upload (model: opus)

**Files:**
- Create: `apps/server/src/publish/{sessions.ts,upload-route.ts}`, `apps/server/src/api/publish.ts`, `packages/shared/src/api/publish.ts`
- Modify: `apps/server/src/app.ts` (mount `POST /upload/:token` beside the API router, with no auth middleware), `apps/server/src/api/router.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/publish-sessions.test.ts`, `apps/server/test/api/publish-rest.test.ts`

**Interfaces:**
- Consumes: Task 6 `ingestUpload`, `ingestFiles`, `ingestInline`, `publishLinks`, `PublishOutcome`; Task 5 `checkTarget`, `PublishTarget`; M2 `requireAuth`, `authOf`, `hasAccess`, `enforceRateLimit`, `RateRule`, `jsonBodyLimit`, `apiInit`, `createSignedInUser`; M1 `newSecret`, `hashSecret`, `publicUrl`, `OneTimeStore`.
- Produces:

```ts
// publish/sessions.ts
export const UPLOAD_RECEIPT_TTL_MS = 86_400_000;
export const PUBLISH_SESSION_RATE: RateRule = { name: 'publish-session', limit: 60, windowMs: 600_000 };   // per user id
export interface UploadSession { target: PublishTarget; actorId: string; source: VersionSource; message: string | null; expiresAt: number }
export type UploadReceipt = { state: 'open' | 'running'; expiresAt: number } | { state: 'done'; expiresAt: number; result: PublishResult };
export function createPublishSession(deps: AppDeps, actor: UserRow, p: { target: PublishTarget; message: string | null;
  source: 'api' | 'mcp'; directory?: string; file?: string }): Promise<PublishSession>;   // M6's create_publish_session calls this with source 'mcp'
export function uploadCommands(url: string, hint: { directory?: string; file?: string }): { archive: string; single_file: string };
export function runUpload(deps: AppDeps, token: string, input: UploadInput): Promise<PublishResult>;
export function toPublishResult(config: Config, o: PublishOutcome): PublishResult;
// shared api/publish.ts (snake_case DTOs; each also exports its z.infer type)
export const PublishTargetInput;   // z.union([z.strictObject({ artifact_id: z.string(), expected_version_id: z.string() }),
                                   //   z.strictObject({ project_id: z.string().nullable().optional(), name: z.string().trim().min(1).max(200).optional(),
                                   //     tags: z.array(z.string()).max(20).optional() })])
export const CreatePublishSessionRequest;   // { target, message?: string(max 2000), directory?: string(1..1024), file?: string(1..1024) }
export const PublishSession;     // { upload_url, expires_at, commands: { archive, single_file }, max_upload_bytes }
export const PublishWarning;     // { code: 'root_absolute_url', file, url, message }
export const PublishResult;      // { artifact_id, version_id, version_number, kind, entry_path, file_count, total_bytes, review_url, raw_url, warnings }
export const InlinePublishRequest;   // { target, message?, files: z.array({ path: string(1..512), content: string }).min(1).max(1000) }
// api/publish.ts (server)
export function toPublishTarget(i: PublishTargetInput): PublishTarget;   // {} → new artifact in the default project
```

  Routes:
  - `POST /api/v1/publish-sessions` (`requireAuth`, `jsonBodyLimit`, `PUBLISH_SESSION_RATE` keyed by user id) → 201 `PublishSession`, source `api`.
  - `POST /api/v1/publish/inline` (`requireAuth`; body limit `2 × maxInlineBytes + 65_536`) → 201 `PublishResult`, source `inline`.
  - `POST /api/v1/publish/upload` (`requireAuth`; multipart; body limit `maxUploadBytes`) → 201 `PublishResult`, source `web`. Fields: `target` (JSON text), `message?`, then a `path` text field before each `file` part, matched by order. Without `path` fields, each part's filename is its path. A single part named `*.zip|*.tar|*.tgz|*.tar.gz` with no `path` goes to `ingestUpload` (sniffed); anything else goes to `ingestFiles`. Missing target or files → 400 `t('publish.upload.form')`.
  - `POST /upload/:token` → 201 `PublishResult`. It reads neither cookies nor `Authorization`, takes the body as `Readable.fromWeb(c.req.raw.body)`, and accepts `?filename=`. Errors are JSON (M1 `wantsHtml` excludes `/upload/`).

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; `create(body)` posts `/api/v1/publish-sessions` with a member's cookie; `put(url, buf, headers?)` = `ctx.app.request(url, { method: 'POST', body: buf, headers })`):

```ts
test('a publish session returns a one-time URL and ready commands', async () => {
  const s = await (await create({ target: {} })).json();
  expect(s.upload_url).toMatch(/^http:\/\/localhost:8080\/upload\/[A-Za-z0-9_-]{43}$/);
  expect(s.expires_at).toBe(clock.now() + 600_000);
  expect(s.commands.archive).toBe(`tar -czf - -C ./site . | curl --fail-with-body --data-binary @- "${s.upload_url}"`);
  expect(s.commands.single_file).toBe(`curl --fail-with-body -H 'Content-Type: text/html' --data-binary @./index.html "${s.upload_url}"`);
});
test('commands follow the given directory or file', ...);
  // directory 'my site' → "-C 'my site' ."; file 'notes/plan.md' → "-H 'Content-Type: text/markdown' --data-binary @notes/plan.md";
  // file 'deck.pdf' → `curl --fail-with-body --data-binary @deck.pdf "${url}?filename=deck.pdf"`; file "it's.html" → @'it'\''s.html'
test('an upload publishes and returns links', ...);
  // put(url, tgz) → 201 { artifact_id: /^art_/, version_number: 1, kind: 'html', review_url: `http://localhost:8080/a/${id}`,
  //   raw_url: `http://localhost:8080/a/${id}/v/1/raw`, warnings: [] }; version source 'api', created_by the member
test('a retried upload names the version it created', async () => {   // Review Focus 2
  // first put → 201; the same put again →
  expect(r2.status).toBe(409);
  expect((await r2.json()).error).toMatchObject({ code: 'upload_session_used',
    details: { artifact_id: id, version_id: vid, version_number: 1, review_url: `http://localhost:8080/a/${id}` } });
  // versions count 1
});
test('an expired session says how to get a new one', async () => {   // Review Focus 2
  // clock.advance(600_001); put → 410
  expect(error).toMatchObject({ code: 'upload_session_expired', details: { expired_at: s.expires_at } });
  expect(error.message).toContain('create_publish_session'); expect(error.message).toContain('/api/v1/publish-sessions');
});
test('an unknown upload URL is not_found', ...);
test('a rejected upload leaves the session usable until it expires', ...);   // body with '../x' → 400; then a good body → 201
test('an upload in progress refuses a second one', ...);   // first put on a slow stream not yet ended; second put → 409 upload_session_used, details { in_progress: true }
test('a stale target fails at session creation', ...);     // expected_version_id stale → 409 version_conflict; unknown artifact → 404
test('the documented command publishes over a real socket', async () => {   // Review Focus 5
  // serve({ fetch: ctx.app.fetch, port: 0 }) from @hono/node-server; http.request(POST /upload/<token>, headers
  //   { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked', expect: '100-continue' });
  // on 'continue', write the tar.gz in 3 chunks, end → 201, body.version_number 1
});
test('an oversized streamed body is 413 without Content-Length', ...);   // Review Focus 3: PINWALL_MAX_UPLOAD_BYTES=10000, chunked 20 KB
  // over the socket → 413 { code: 'payload_too_large', details: { limit: 'max_upload_bytes', max: 10000 } }; no versions; no blobs
test('a declared Content-Length over the limit is refused before reading', ...);   // content-length 10001 → 413
test('upload URLs ignore cookies and bearer tokens', ...);   // cookie 'pinwall_session=junk' + 'authorization: Bearer junk' → 201, no set-cookie header
test('session creation needs auth and is rate limited per user', ...);   // no auth → 401; 60 creates → 201; the 61st → 429
test('a session whose creator lost access cannot upload', ...);   // role_override 'blocked' after creation → 403 access_denied; then unblock → 201
test('inline publish over REST', ...);   // POST /api/v1/publish/inline { target: {}, files: [{ path: 'index.md', content: '# Hi' }] } → 201 kind 'markdown', source 'inline'
test('web upload of a dropped folder and of one archive', ...);
  // FormData: target '{}', path 'site/index.html' + file, path 'site/a.css' + file → 201 entry 'index.html', source 'web';
  // one file part 'site.zip' → archive; no target → 400; cross-origin cookie POST → 403 (M2 origin check)
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/publish-sessions test/api/publish-rest`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Store keys:** `h = hashSecret(token)`. `upload:<h>` → `UploadSession`, TTL `uploadSessionMs`. `upload-receipt:<h>` → `UploadReceipt`, TTL `UPLOAD_RECEIPT_TTL_MS`. The token is `newSecret()` and the URL is `publicUrl(config, '/upload/' + token)`.
  - **`runUpload`, in this order (the Review Focus 2 guarantee):**
    1. `take('upload:' + h)`.
    2. If it is null, peek the receipt:
       - `done` → `new AppError('upload_session_used', 409, t('publish.session.used', { number }), { artifact_id, version_id, version_number, review_url })`;
       - `open` or `running` before `expiresAt` → the same code with `t('publish.session.running')` and `{ in_progress: true }`;
       - past `expiresAt` → `new AppError('upload_session_expired', 410, t('publish.session.expired'), { expired_at })`;
       - no receipt → `notFound(t('publish.session.unknown'))`.
    3. Put the receipt `running`. Load the actor; `!hasAccess` → `access_denied` 403.
    4. `ingestUpload` with the session's target, source and message.
    5. Success → put the receipt `done` with the result.
    6. Any failure while `now < expiresAt` → put the session back with TTL `expiresAt - now` and the receipt `open`; then rethrow.
  - **`uploadCommands`:** the directory defaults to `./site` and the file to `./index.html`. A path that is not all `[A-Za-z0-9_./-]` is single-quoted (`'` → `'\''`). A file ending in `.html`/`.htm` gets `-H 'Content-Type: text/html'`, one ending in `.md` gets `-H 'Content-Type: text/markdown'`, any other file appends `?filename=<encodeURIComponent(basename)>`.
  - en.json:
    - `"publish.session.used": "This upload URL was already used; it published v{{number}}. Ask for a new publish session to publish again."`
    - `"publish.session.running": "An upload with this URL is already in progress."`
    - `"publish.session.expired": "This upload URL has expired. Ask for a new one with the create_publish_session tool or POST /api/v1/publish-sessions."`
    - `"publish.session.unknown": "This upload URL is not valid."`
    - `"publish.upload.form": "Send multipart/form-data with a target field and at least one file."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add publish sessions with one-time upload URLs, inline REST publish and web upload`.

### Task 8: Projects, artifacts and versions REST — list, search, recent, tags, move, restore (model: sonnet)

**Files:**
- Create: `apps/server/src/api/{projects.ts,artifacts.ts,versions.ts}`, `packages/shared/src/api/{projects.ts,artifacts.ts}`
- Modify: `apps/server/src/domain/{projects.ts,artifacts.ts,versions.ts}` (list, update, view functions), `apps/server/src/api/router.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/{projects,artifacts,versions}.test.ts`

**Interfaces:**
- Consumes: Task 5 domain; Task 6 `publishFiles`; M2 `page`, `Label`, `Timestamp`, `encodeCursor`, `decodeCursor`, `requireAuth`, `authOf`; M1 `searchQuery`, `publicUrl`.
- Produces:

```ts
// domain additions
export const SEARCH_MAX_CHARS = 256; export const SEARCH_MAX_WORDS = 32;
export function listProjects(deps, p: { archived: boolean; limit: number; cursor: string | null }): Promise<{ items: (ProjectRow & { artifact_count: number })[]; nextCursor: string | null }>;
  // order is_default desc, created_at, id; cursor { d, c, i }
export function listArtifacts(deps, p: { projectId?: string; tag?: string; q?: string; limit: number; cursor: string | null }): Promise<{ items: ArtifactRow[]; nextCursor: string | null }>;
  // without q: updated_at desc, id desc, cursor { u, i }; with q: search order, cursor { o } (offset), offset + limit capped at 1000;
  // projectId absent → artifacts of archived projects left out
export function updateArtifact(deps: AppDeps, id: string, p: { name?: string; projectId?: string; tags?: string[] }): Promise<ArtifactRow>;   // then reindexArtifact
export function recordView(deps, userId: string, artifactId: string): Promise<void>;   // upsert artifact_views.viewed_at = now
export function listRecent(deps, userId: string, limit: number): Promise<ArtifactRow[]>;   // viewed_at desc, ≤ 20
export function listVersions(deps, artifactId, p: { limit; cursor }): Promise<{ items: VersionRow[]; nextCursor }>;   // number desc
export function listVersionFiles(deps, versionId, p: { limit; cursor }): Promise<{ items: VersionFileRow[]; nextCursor }>;   // path asc
// shared api/projects.ts
export const Project;              // { id, name, instructions, is_default: boolean, archived_at: Timestamp|null, artifact_count, created_at, updated_at }
export const ProjectList;          // page(Project)
export const CreateProjectRequest; // { name: Label, instructions?: z.string().max(20_000) }
export const UpdateProjectRequest; // { name?: Label, instructions?: z.string().max(20_000), archived?: boolean }
// shared api/artifacts.ts
export const VersionSummary;       // { id, number, title|null, entry_path, theme_color|null, has_thumbnail, file_count, total_bytes, message|null,
                                   //   source, restored_from_version_id|null, warnings: PublishWarning[], created_by|null, created_at, is_current }
export const ArtifactSummary;      // { id, project_id, name, kind, tags: string[], current_version: VersionSummary|null, latest_number,
                                   //   created_by|null, created_at, updated_at, links: { review, raw } }   (publicUrl /a/:id and /a/:id/raw)
export const ArtifactList;         // page(ArtifactSummary)
export const UpdateArtifactRequest;// { name?: z.string().trim().min(1).max(200), project_id?: string, tags?: z.array(z.string()).max(20) }
export const VersionList; export const VersionFile; /* { path, size, content_type, sha256 } */ export const VersionFileList;
export const RestoreRequest;       // { expected_version_id: string }
```

  Routes, all `requireAuth`, with `limit` 1–200 (default 50) and `{n}` as `z.coerce.number().int().min(1)`:

  | Route | Success |
  | --- | --- |
  | `GET /projects?archived=` | 200 `ProjectList` |
  | `POST /projects` | 201 `Project` |
  | `GET /projects/{id}` | 200 `Project` |
  | `PATCH /projects/{id}` | 200 `Project` |
  | `GET /artifacts?project_id=&tag=&q=` (`q` max 256 chars) | 200 `ArtifactList` |
  | `GET /artifacts/recent?limit=` (≤ 20) | 200 `ArtifactList`, `next_cursor: null` |
  | `GET /artifacts/{id}` | 200 `ArtifactSummary`, 410 when deleted |
  | `PATCH /artifacts/{id}` | 200 `ArtifactSummary` |
  | `GET /artifacts/{id}/versions` | 200 `VersionList` |
  | `GET /artifacts/{id}/versions/{n}` | 200 `VersionSummary` |
  | `GET /artifacts/{id}/versions/{n}/files` | 200 `VersionFileList` |
  | `POST /artifacts/{id}/versions/{n}/restore` | 201 `VersionSummary` |

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`):

```ts
test('search finds Vietnamese without diacritics', async () => {   // acceptance 7
  const { artifact } = await publishFiles(ctx, member, { 'index.html': '<p>Dịch vụ chụp ảnh cưới</p>' });
  for (const q of ['chup anh', 'chụp ảnh', 'CHUP'])
    expect((await getJson(`/api/v1/artifacts?q=${encodeURIComponent(q)}`)).items.map((a: { id: string }) => a.id)).toEqual([artifact.id]);
});
test('search covers name and tags and follows the current version', ...);
  // PATCH name 'Bảng giá' → q 'bang gia' found, the old name not; tags ['Khách hàng'] → q 'khach' found;
  // v2 without 'cưới' → q 'cuoi' → []
test('search input is capped', ...);   // q of 257 chars → 400 bad_request; 40 words where the 33rd onward match nothing → still finds by the first 32
test('the list orders by last update and pages with a cursor', ...);   // 3 artifacts, limit 2 → 2 + next_cursor; page 2 → 1 + null; garbage cursor → 400
test('artifacts of archived projects leave the default list', ...);   // archive project P → not in /artifacts; in /artifacts?project_id=P
test('tags are normalized and capped', ...);   // PATCH tags [' Đồ Án ', 'đồ án', 'X'] → ['x', 'đồ án']; 21 tags → 400; a 41-char tag → 400
test('move to another project', ...);   // PATCH project_id Q → listed under Q; 'prj_nope' → 404; archived → 409
test('projects: create, rename, instructions, archive', ...);
  // POST { name: 'Site', instructions: 'Dùng tiếng Việt' } → 201; PATCH rename; archive → archived_at set and gone from ?archived=false;
  // ?archived=true lists it; the default project comes first with artifact_count; archiving it → 409 t('project.defaultArchive')
test('recent lists what the user viewed, newest first', ...);   // recordView(a), advance, recordView(b) → [b, a]; another user's views not shown
test('versions list newest first, files page by path', ...);    // 3 versions → [3, 2, 1], is_current on 3; files limit 1 pages
test('restore over REST', ...);   // POST /versions/1/restore { expected_version_id: v2 } → 201 number 3, source 'restore'; stale → 409 version_conflict
test('a deleted artifact is gone', ...);   // addTombstones artifact + delete the row → GET /artifacts/{id} → 410 gone
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/projects test/api/artifacts test/api/versions`. Expected: FAIL.
- [ ] **Step 3: Implement.** Search keeps the first `SEARCH_MAX_WORDS` words of `foldForSearch(q)` and passes them to `searchQuery`. Map rows to DTOs in one `toArtifactSummary(deps, rows)` that batch-loads tags and current versions (no N+1). `warnings` come from `JSON.parse(meta).warnings`. `has_thumbnail` is `thumbnail_path !== null`.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add projects, artifacts and versions REST with accent-insensitive search, tags and restore`.

### Task 9: Content grants and serving in both isolation modes (model: opus)

**Files:**
- Create: `apps/server/src/content/{grants.ts,serve.ts,routes.ts,hooks.ts,error-page.ts}`
- Modify: `apps/server/src/app.ts` (call `mountContent(app, contentHooks)` right after the deps-injection middleware, before `appSecurityHeaders` and every route), `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/content/{grants,serve}.test.ts`, `apps/server/test/helpers/content.ts`

**Interfaces:**
- Consumes: Task 3 `isTombstoned`, `addTombstones`; Task 6 `publishFiles`; M1 `Config`, `newContentToken`, `BlobStore.get(sha, range)`, `t`.
- Produces:

```ts
// content/grants.ts
export type GrantMode = 'review' | 'raw';
export function createGrant(deps: AppDeps, p: { versionId: string; mode: GrantMode; shareLinkId?: string | null; ttlMs?: number }): Promise<ContentGrantRow>;
  // token newContentToken(), expires_at = now + (ttlMs ?? config.ttl.previewMs)
export function contentBaseUrl(config: Config, token: string): string;
  // single: `${publicOrigin}/c/${token}/`; content: `${scheme}://${token}.${host}${port ? ':' + port : ''}/`
export function contentUrl(config: Config, token: string, path?: string): string;   // base + path, each segment encodeURIComponent
export interface ResolvedGrant { grant: ContentGrantRow; version: VersionRow }
export function resolveGrant(deps: AppDeps, token: string): Promise<ResolvedGrant>;
  // no row: tombstoned → gone(t('content.gone.message')), else notFound; expires_at <= now → gone(t('content.expired.message'), { expired: true })
export function purgeExpiredGrants(deps: AppDeps): Promise<number>;
// content/hooks.ts — the seam M5 fills
export type HtmlTransform = (html: Buffer, ctx: { grant: ContentGrantRow; version: VersionRow; path: string; baseUrl: string }) => Buffer | Promise<Buffer>;
export interface ReservedAsset { contentType: string; body(): Buffer }
export interface ContentHooks { transformReviewHtml?: HtmlTransform; reservedAssets?: Record<string, ReservedAsset> }   // keys under __pinwall/, e.g. 'markdown.css'
export const contentHooks: ContentHooks;   // what buildApp passes; M4 ships it empty here, Task 10 adds markdown.css, M5 adds transformReviewHtml and 'annotator.js'
// content/serve.ts
export const CONTENT_SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';
export function contentHeaders(config: Config): Record<string, string>;
export function serveContent(c: Context<AppEnv>, token: string, rawPath: string, hooks: ContentHooks): Promise<Response>;
// content/routes.ts
export function contentHostToken(config: Config, hostname: string): string | 'unknown' | null;   // token, a content-host name without a valid token, or not a content host
export function mountContent(app: Hono<AppEnv>, hooks: ContentHooks): void;
// content/error-page.ts
export function renderContentErrorPage(kind: 'not_found' | 'gone' | 'expired' | 'error'): string;   // self-contained HTML, inline style, no external references
// test/helpers/content.ts
export const CONTENT_ENV = { PINWALL_PUBLIC_ORIGIN: 'https://pinwall.test', PINWALL_ISOLATION: 'content-domain', PINWALL_CONTENT_ORIGIN: 'https://pw-content.test' };
export function fetchContent(ctx: TestContext, token: string, path: string, init?: RequestInit): Promise<Response>;
  // single: ctx.request(`/c/${token}/${path}`); content: ctx.app.request(`https://${token}.pw-content.test/${path}`, init)
```

- [ ] **Step 1: Write the failing tests.** `serve.test.ts` runs `describe.each([['single-domain', {}], ['content-domain', CONTENT_ENV]])` on SQLite; `grants.test.ts` runs `describe.each(dialects)`. Each test publishes with `publishFiles` and makes a raw grant unless it says otherwise.

```ts
test('content URLs per mode', ...);   // single 'http://localhost:8080/c/<tok>/'; CONTENT_ENV 'https://<tok>.pw-content.test/';
  // PINWALL_CONTENT_ORIGIN https://pw-content.test:8443 → 'https://<tok>.pw-content.test:8443/'; contentUrl(…, 'a b/é.html') → '…/a%20b/%C3%A9.html'
test('serves files with exactly the content headers', async () => {
  const r = await fetchContent(ctx, token, 'index.html');
  expect(r.headers.get('cache-control')).toBe('private, max-age=300, no-transform');
  expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(r.headers.get('etag')).toBe(`"${sha256(html)}"`);
  expect(r.headers.get('content-security-policy')).toBe(mode === 'single-domain' ? CONTENT_SANDBOX_CSP : null);
  expect(r.headers.get('x-frame-options')).toBeNull();
});
test('never reads or sets cookies', ...);   // cookie 'pinwall_session=x; __Host-pinwall_session=y' → no set-cookie; body equals the request without cookies
test('the root serves the entry and directories their index', ...);
  // entry 'report.html' (only file) → '' serves it; 'docs/' → docs/index.html; 'docs' → 308, location 'docs/'; 'docs?x=1' → location 'docs/?x=1';
  // 'md/' with only md/index.md → serves md/index.md
test('finds a file whatever the normalization form and percent-encoding', async () => {   // Review Focus 1
  // published 'Tài liệu/ảnh 1.png' (NFC)
  for (const form of ['NFC', 'NFD'] as const) {
    const p = 'Tài liệu/ảnh 1.png'.normalize(form).split('/').map(encodeURIComponent).join('/');
    expect((await fetchContent(ctx, token, p)).headers.get('etag')).toBe(`"${pngSha}"`);
  }
});
test('dot segments and encoded slashes do not escape the version', ...);   // '../x', '%2e%2e/x', 'a%2F..%2F..%2Fx', 'a%5Cb', 'a%00b' → 404
test('range requests for video', ...);
  // 'v.mp4' of 1000 bytes: 'bytes=0-99' → 206, content-range 'bytes 0-99/1000', content-length '100', the exact bytes;
  // 'bytes=900-' → 900–999; 'bytes=-10' → 990–999; 'bytes=2000-' → 416, content-range 'bytes */1000';
  // 'bytes=0-1,5-6' → 200 full; if-range '"other"' → 200 full; accept-ranges 'bytes' on every file response
test('If-None-Match answers 304', ...);
test('HEAD returns headers only', ...);   // content-length set, empty body
test('missing files get a 404 page with content headers', ...);   // 404 text/html, body contains t('content.notFound.title'), sandbox CSP in single mode
test('expired grants are gone', ...);   // advance previewMs + 1 → 410, body contains t('content.expired.title')
test('grants of deleted versions are gone', ...);   // addTombstones content_grant + delete the version row → 410, t('content.gone.title')
test('unknown tokens are not found', ...);
test('isolation: content never under app routes, app never on content hosts', ...);
  // content mode: GET http://localhost/c/<tok>/ on the app host → 404; https://<tok>.pw-content.test/api/v1/config/public → 404 content page, not JSON;
  // https://pw-content.test/ and https://nottoken.pw-content.test/ → 404; single mode: https://<tok>.pw-content.test/ is just an app request (no content)
test('reserved __pinwall paths come only from hooks', ...);
  // '__pinwall/nope.js' → 404; with hooks.reservedAssets { 'x.js': { contentType: 'text/javascript; charset=utf-8', body: () => Buffer.from('1') } } → 200 + content headers
test('review grants pass through the transform hook; raw grants never do', ...);
  // a test app with hooks.transformReviewHtml appending '<!--t-->': review index.html ends with '<!--t-->', etag = sha of the transformed body, no range support;
  // the raw grant body equals the stored bytes; a review CSS file is unchanged
// grants.test.ts
test('a grant lives for PINWALL_PREVIEW_TTL', ...);   // expires_at === now + 43_200_000; resolveGrant ok
test('purge removes only expired grants', ...);
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/content/serve test/content/grants`. Expected: FAIL.
- [ ] **Step 3: Implement.** `serveContent` follows this decision order. Every response, including errors and 3xx, carries `contentHeaders(config)` and nothing that reads or sets cookies.
  1. Only GET and HEAD are served; anything else → 405 with `Allow: GET, HEAD`.
  2. `resolveGrant`. A 404 or 410 renders `renderContentErrorPage` (`not_found`, `gone`, or `expired` when `details.expired`). `serveContent` catches every error itself, so M1's app error page never answers on content: an unexpected error is logged and answered 500 with `renderContentErrorPage('error')`.
  3. Split `rawPath` on `/` and `decodeURIComponent` each segment. A `URIError`, or a decoded segment that is `.` or `..` or contains `/`, `\` or NUL → 404. Join and NFC-normalize.
  4. A first segment of `__pinwall` → `hooks.reservedAssets[rest]`, else 404.
  5. Resolve the file: `''` → `version.entry_path`. A path ending in `/` → `index.html`, then `index.md`, under it. An exact file → that file. Otherwise, if `<p>/index.html` or `<p>/index.md` exists → 308 with relative `Location: <last segment>/` plus the original query. Else 404.
  6. A matching `If-None-Match` → 304.
  7. A `text/html` file of a review grant with `hooks.transformReviewHtml` → read it whole, transform, ETag = SHA-256 of the result, 200.
  8. Otherwise, a single `bytes=` range (`a-b`, `a-`, `-n`), honored only when `If-Range` is absent or equals the ETag. Several ranges → 200. Unsatisfiable → 416. Body from `blobs.get(sha, range)` through `Readable.toWeb`, with `Content-Length` and `Accept-Ranges: bytes`.

  `mountContent` registers two things:
  - Content-domain mode: an `app.use('*')` that reads the hostname from `new URL(c.req.url)`, which `@hono/node-server` builds from `Host`; never `X-Forwarded-Host`. A token host → `serveContent`; `'unknown'` → content 404; otherwise `next()`. Also `app.all('/c/*')` → 404.
  - Single-domain mode: `GET /c/:token` → 308 `Location: <token>/`, and `GET /c/:token/*` → `serveContent`.

  en.json:
  - `"content.notFound.title": "Not found"`, `"content.notFound.message": "This file is not part of the artifact."`
  - `"content.gone.title": "Deleted"`, `"content.gone.message": "This version was deleted and is no longer available."`
  - `"content.expired.title": "Link expired"`, `"content.expired.message": "This preview link has expired. Open the artifact in Pinwall again."`
  - `"content.error.title": "Something went wrong"`, `"content.error.message": "Pinwall could not serve this file. Try again."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`. Expected: PASS, including M1's security-header tests (app pages keep their CSP).
- [ ] **Step 5: Commit** `feat(server): serve artifact content through capability grants in single-domain and content-domain modes`.

### Task 10: Markdown rendering (model: sonnet)

**Files:**
- Create: `apps/server/src/content/{markdown.ts,markdown-css.ts}`
- Modify: `apps/server/src/content/serve.ts` (Markdown branch), `apps/server/src/content/hooks.ts` (`contentHooks.reservedAssets['markdown.css']`)
- Test: `apps/server/test/content/markdown.test.ts`

**Interfaces:**
- Consumes: Task 9 `serveContent`, `ContentHooks`, `fetchContent`; Task 6 `publishFiles`.
- Produces:

```ts
export const MARKDOWN_CSS_PATH = '__pinwall/markdown.css';
export interface Heading { level: number; id: string; text: string }
export function slugify(text: string): string;   // NFC, lowercase, whitespace → '-', drop chars other than \p{L}\p{N}-_; '' → 'section'
export function renderMarkdown(src: string): { html: string; headings: Heading[]; title: string | null };
export function renderMarkdownPage(src: string, pagePath: string): string;   // whole HTML document
export function renderMarkdownFragment(src: string): string;                 // body HTML only, no TOC (Task 12 diff)
export const markdownCss: string;                                            // Pinwall's own stylesheet, light and dark
```

- [ ] **Step 1: Write the failing tests.**

```ts
test('renders headings with ids and a table of contents', () => {
  const page = renderMarkdownPage('# Báo giá\n\n## Chụp ảnh\n\n### Giá\n\n## Liên hệ\n', 'index.md');
  expect(page).toContain('<h2 id="chụp-ảnh">');
  expect(page).toMatch(/<nav class="pw-toc"[^>]*>.*href="#chụp-ảnh".*href="#giá".*href="#liên-hệ"/s);
  expect(page).toContain('<title>Báo giá</title>');
});
test('duplicate headings get unique ids', ...);   // '## A\n\n## A' → ids 'a' and 'a-1'
test('no table of contents below two headings', ...);
test('highlights fenced code with known languages only', ...);   // ```ts → 'hljs-keyword'; ```nope with '<b>' → '&lt;b&gt;', no 'hljs-'
test('links the stylesheet relative to the page', ...);   // 'index.md' → href="__pinwall/markdown.css"; 'docs/a/b.md' → href="../../__pinwall/markdown.css"
test('a Markdown entry is served rendered, and ?source returns it raw', ...);
  // grant on { 'index.md': '# Hi' }: '' → 200 text/html; charset=utf-8, contains '<article class="pw-md-body">', etag = sha of the body;
  // '?source' → text/markdown; charset=utf-8, body === '# Hi', etag = sha of the stored file
test('any .md file is served as a page', ...);   // 'docs/x.md' → rendered; relative link '[n](y.md)' stays 'y.md'
test('markdown.css is served from __pinwall', ...);   // content-type 'text/css; charset=utf-8', contains '.pw-md' and '@media (prefers-color-scheme: dark)'
test('raw HTML in Markdown passes through', ...);   // '<details><summary>x</summary>y</details>' kept (content is sandboxed)
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/content/markdown`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **markdown-it:** `{ html: true, linkify: true, typographer: false }`; markdown-it-anchor with `slugify` and `tabIndex: false`.
  - **Highlighting:** `highlight` uses `hljs.highlight(code, { language, ignoreIllegals: true })` from `highlight.js/lib/common` only when `hljs.getLanguage(lang)` knows the language; otherwise it escapes the code (no auto-detect).
  - **Table of contents:** h2 and h3, shown when there are at least 2.
  - **Page layout:** `<!doctype html><html><head>` with charset, viewport, `<title>` (the first heading, else the file's basename), and `<link rel="stylesheet" href="<'../' × depth>__pinwall/markdown.css">`; then `<body><div class="pw-md"><nav class="pw-toc" aria-label="Contents">…</nav><article class="pw-md-body">…</article></div></body></html>`.
  - **Serving:** a `.md` path without `?source` → rendered page, ETag = SHA-256 of the body, no Range, and review grants go through `transformReviewHtml`.
  - **`markdownCss`:** original styles for the layout, typography, tables, code and `.hljs-*` token colors. Neutral style B, light and dark.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test test/content`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): render Markdown versions with a table of contents and code highlighting`.

### Task 11: Preview API, raw links, thumbnails, isolation switch (model: opus)

**Files:**
- Create: `apps/server/src/api/content.ts`, `apps/server/src/content/raw-links.ts`, `packages/shared/src/api/content.ts`
- Modify: `apps/server/src/app.ts` (`mountRawLinks(app)` before the SPA fallback), `apps/server/src/api/router.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/preview.test.ts`, `apps/server/test/content/{raw-links,isolation-switch}.test.ts`

**Interfaces:**
- Consumes: Task 9 `createGrant`, `contentUrl`, `fetchContent`, `CONTENT_ENV`; Task 8 `recordView`, `listRecent`; Task 5 `getArtifact`, `getVersionByNumber`; Task 1 `isRasterImage`; M2 `resolveAuth`, `bearerResolvers`, `requireAuth`, `createUserToken`; M1 `wantsHtml`, `publicUrl`, `createTestContext`.
- Produces:

```ts
// shared api/content.ts
export const ContentGrant;   // { url: string, mode: 'review' | 'raw', expires_at: Timestamp, isolation: 'single-domain' | 'content-domain' }
export const PreviewQuery;   // { mode: z.enum(['review', 'raw']).default('review') }
// content/raw-links.ts
export function mountRawLinks(app: Hono<AppEnv>): void;   // GET /a/:artifactId/raw and /a/:artifactId/v/:n/raw, each behind resolveAuth({ bearer: bearerResolvers, cookies: true })
export const THUMBNAIL_CSP = "default-src 'none'; sandbox";
```

  Routes:
  - `GET /api/v1/artifacts/{id}/versions/{n}/preview?mode=` (`requireAuth`) → 200 `ContentGrant`. A review grant also calls `recordView`.
  - `GET /api/v1/artifacts/{id}/thumbnail` (`requireAuth`) → the current version's `thumbnail_path` bytes when raster, with `Content-Type`, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=300` and `ETag`. Otherwise 404 `t('artifact.noThumbnail')`. If M1's `appSecurityHeaders` overwrites a CSP the route set, make it keep that CSP (a one-line additive change).
  - `GET /a/:id/raw` and `GET /a/:id/v/:n/raw`:
    - Members (cookie or bearer) → 302 to `contentUrl(config, createGrant(raw).token)` with `Cache-Control: no-store`.
    - No auth: an HTML-accepting client → 302 `publicUrl('/signin?return_to=' + encodeURIComponent(path))`; others → 401 JSON.
    - Deleted → 410 and unknown → 404, both through M1's error handling (HTML for browsers).

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)` unless noted):

```ts
test('preview returns a content URL for the current mode', ...);
  // single: url starts 'http://localhost:8080/c/' and ends '/'; CONTENT_ENV: url matches /^https:\/\/[0-9a-hjkmnp-tv-z]{32}\.pw-content\.test\/$/;
  // expires_at === now + 43_200_000; mode raw accepted; fetching the url serves the entry; no auth → 401
test('a review preview records a view; a raw one does not', ...);   // listRecent contains the artifact after review only
test('raw links redirect members to a fresh raw grant', ...);
  // cookie → 302, location === contentUrl(config, token), the grant row has mode 'raw' and expires_at now + previewMs; cache-control 'no-store';
  // bearer API token → 302; two calls → different tokens
test('raw links send browsers without a session to sign in', ...);   // accept text/html → 302 'http://localhost:8080/signin?return_to=%2Fa%2F<id>%2Fraw'; accept json → 401
test('/a/:id/v/:n/raw serves that version', ...);   // v1 'one', v2 'two' → following /v/1/raw gives 'one'
test('raw links of deleted things are gone', ...);   // a deleted version number → 410 HTML; a tombstoned artifact → 410; 'art_unknown' → 404
test('thumbnails are raster only, with locked-down headers', ...);
  // og:image 'cover.png' → 200 image/png, content-security-policy "default-src 'none'; sandbox", nosniff, the exact bytes;
  // og:image 'logo.svg' only → 404; no auth → 401
// isolation-switch.test.ts (SQLite)
test('switching the isolation mode keeps links working with identical bytes', async () => {   // acceptance 8 and 10, server side
  // one temp dir, two contexts open on it together: A = { PINWALL_DATA_DIR: dir }, B = { PINWALL_DATA_DIR: dir, ...CONTENT_ENV }
  // (extend createTestContext additively if it does not honor a given PINWALL_DATA_DIR, and leave such a dir in place on close)
  // A: publish { 'index.html': html with '\r\n' and a BOM, 'a.png': random bytes with NUL, 'v.mp4': 1000 random bytes }
  // for each ctx: GET /a/:id/raw with a member cookie → 302; follow the location (B: ctx.app.request(location)) →
  //   index.html body Buffer.equals(original), same etag in A and B; 'v.mp4' with Range bytes=10-19 → the same 10 bytes in both
  // GET /a/:id/v/1/raw works in both; A's /c/<token>/ URL answers 404 under B (/c/* is off in content-domain mode)
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/preview test/content/raw-links test/content/isolation-switch`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes. en.json: `"artifact.noThumbnail": "This artifact has no thumbnail image."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add preview grants, raw artifact links and raster thumbnails`.

### Task 12: Diff APIs — changed files, text diff, rendered Markdown diff (model: sonnet)

**Files:**
- Create: `apps/server/src/domain/diff.ts`, `apps/server/src/api/diff.ts`, `packages/shared/src/api/diff.ts`
- Modify: `apps/server/src/api/router.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/domain/diff.test.ts`, `apps/server/test/api/diff.test.ts`

**Interfaces:**
- Consumes: Task 10 `renderMarkdownFragment`; Task 5 `getArtifact`, `getVersionByNumber`; Task 1 `isTextType`; `diff` (`createTwoFilesPatch`, `diffArrays`); markdown-it `parse`.
- Produces:

```ts
export const TEXT_DIFF_MAX_BYTES = 1_000_000;
export interface FileSide { sha256: string; size: number; content_type: string }
export interface FileChange { path: string; status: 'added' | 'removed' | 'modified'; old: FileSide | null; new: FileSide | null }
export function diffVersionFiles(deps: AppDeps, artifactId: string, from: number, to: number): Promise<FileChange[]>;   // by sha256, sorted by path, unchanged left out
export function diffTextFile(deps: AppDeps, artifactId: string, from: number, to: number, path: string):
  Promise<{ path: string; binary: boolean; too_large: boolean; patch: string | null }>;
export type BlockOp = 'unchanged' | 'added' | 'removed' | 'changed';
export interface MarkdownBlockChange { op: BlockOp; old_html: string | null; new_html: string | null }
export function diffMarkdownBlocks(oldSrc: string, newSrc: string): MarkdownBlockChange[];
export function diffMarkdownFile(deps: AppDeps, artifactId: string, from: number, to: number, path?: string):
  Promise<{ path: string; blocks: MarkdownBlockChange[] }>;   // path defaults to the `to` version's entry; not .md → badRequest(t('diff.notMarkdown'))
// shared api/diff.ts: VersionDiff { from, to, files: FileChange[] }; TextFileDiff; MarkdownDiff { path, blocks }; DiffQuery { from, to, path? }
```

  Routes (`requireAuth`):
  - `GET /artifacts/{id}/diff?from=&to=` → `VersionDiff`.
  - `GET /artifacts/{id}/diff/file?from=&to=&path=` → `TextFileDiff`.
  - `GET /artifacts/{id}/diff/markdown?from=&to=&path=` → `MarkdownDiff`.

  A path in neither version → 404 `t('diff.noFile')`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('lists changed files by sha256', ...);
  // v1 { a: '1', b: '2', c: '3' }, v2 { a: '1', b: '22', d: '4' } → [{ path: 'b', status: 'modified' }, { path: 'c', status: 'removed', new: null },
  //   { path: 'd', status: 'added', old: null }]
test('unified diff of a text file', ...);   // b: patch contains '--- b\tv1', '+++ b\tv2', '\n-2', '\n+22'; added file d → old side empty
test('binary and large files are not diffed', ...);   // png with a NUL in its first 8000 bytes → { binary: true, patch: null }; a 1_000_001-byte .txt → too_large true
test('rendered Markdown diff marks blocks', () => {
  const ops = diffMarkdownBlocks('# T\n\nA\n\nB\n\nC\n', '# T\n\nA\n\nB2\n\nD\n\nC\n');
  expect(ops.map(o => o.op)).toEqual(['unchanged', 'unchanged', 'changed', 'added', 'unchanged']);
  expect(ops[2]).toMatchObject({ old_html: '<p>B</p>\n', new_html: '<p>B2</p>\n' });
});
test('lists, fences and tables are single blocks', ...);   // a change inside a 3-item list → one 'changed' block
test('diff routes validate versions and paths', ...);   // from=9 → 404; path in neither → 404; markdown on 'index.html' → 400 t('diff.notMarkdown'); no auth → 401
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/domain/diff test/api/diff`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Blocks:** walk `md.parse(src, {})` at `level === 0`, from each `*_open` to its matching close, or a single token (`fence`, `code_block`, `hr`, `html_block`). Each block's source is `lines.slice(map[0], map[1]).join('\n').trimEnd()`.
  - **Pairing:** run `diffArrays` on the block sources. A removed run followed at once by an added run pairs index by index as `changed`; the leftovers stay `removed`/`added`. Render each side with `renderMarkdownFragment`.
  - **Text diff:** text means `isTextType` and no NUL in the first 8000 bytes; decode as UTF-8; patch = `createTwoFilesPatch(path, path, a, b, 'v' + from, 'v' + to, { context: 3 })`.
  - en.json:
    - `"diff.noFile": "Neither version has this file."`
    - `"diff.notMarkdown": "A rendered diff is available for Markdown files only."`
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add file, text and rendered Markdown diffs between versions`.

### Task 13: Deletion, sweep jobs, startup and the milestone flow (model: opus)

**Files:**
- Create: `apps/server/src/domain/deletion.ts`, `apps/server/src/publish/startup.ts`
- Modify: `apps/server/src/api/{artifacts.ts,versions.ts}` (DELETE routes), `apps/server/src/main.ts` (`serve` calls `startPublishing(deps)` next to M2's `startAuth`), `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/domain/deletion.test.ts`, `apps/server/test/api/publishing-flow.test.ts`

**Interfaces:**
- Consumes: Task 3 `addTombstones`, `collectBlobs`, `sweepBlobs`, `pruneTombstones`, `BACKUP_LEASE`; Task 5 `lockArtifact`, `getArtifact`, `getVersionByNumber`, `indexArtifact`, `reindexArtifact`, `ARTIFACT_TOPIC`, `ensureDefaultProject`; Task 9 `purgeExpiredGrants`, `createGrant`, `fetchContent`; M2 `effectiveRole`, `authOf`, `requireAuth`, `setupOwner`; M1 `searchDelete`, `Scheduler`.
- Produces:

```ts
// domain/deletion.ts
export function canDelete(auth: AuthContext, artifact: ArtifactRow): boolean;   // effectiveRole admin, or artifact.created_by === auth.user.id
export function deleteVersion(deps: AppDeps, auth: AuthContext, artifactId: string, n: number):
  Promise<{ artifactDeleted: boolean; currentVersionId: string | null }>;
export function deleteArtifact(deps: AppDeps, auth: AuthContext, artifactId: string): Promise<void>;
// publish/startup.ts
export function startPublishing(deps: AppDeps): Promise<void>;
  // ensureDefaultProject; scheduler.every('content-cleanup', 3_600_000, purgeExpiredGrants then pruneTombstones);
  // scheduler.every('blob-sweep', 600_000, () => sweepBlobs(deps))
```

  Routes (`requireAuth`; not allowed → 403 `t('artifact.deleteForbidden')`):
  - `DELETE /api/v1/artifacts/{id}` → 204.
  - `DELETE /api/v1/artifacts/{id}/versions/{n}` → 204.

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`):

```ts
test('deleting a version with a secret: links gone at once, files removed unless shared', async () => {   // acceptance 9
  // v1 { 'index.html': 'one', 'secret.txt': 'sk-live-123', 'shared.css': 'body{}' }, v2 { 'index.html': 'two', 'shared.css': 'body{}' }
  // grant1 = createGrant(v1, raw) before the delete; DELETE /api/v1/artifacts/:id/versions/1 → 204
  // GET /a/:id/v/1/raw → 410; fetchContent(grant1, 'secret.txt') → 410; GET /api/v1/artifacts/:id/versions/1 → 410
  // blobs.has(sha('sk-live-123')) false and no blobs row; sha('body{}') kept; /a/:id/raw serves v2
});
test('deleting the current version makes the previous one current', ...);
  // v1 'chụp ảnh', v2 'other'; delete v2 → current_version_id v1, search 'chup anh' finds it again; the next publish with expected v1 → number 3
test('deleting the last version deletes the artifact', ...);
  // → { artifactDeleted: true }; GET /api/v1/artifacts/:id → 410; /a/:id/raw → 410; search empty; tombstone 'artifact'
test('deleting an artifact cascades and tombstones its share links', ...);
  // insert share_links (one per artifact, one per v1) and a comment thread on v1 → DELETE /api/v1/artifacts/:id → 204;
  // share_links, comments, versions, version_files, artifact_tags, artifact_views rows gone; isTombstoned('share_link', hash) true for both
test('deleting a version removes its comment threads and per-version share links only', ...);
  // comments on v1 gone, on v2 kept; a comment resolved in v1 keeps its row, resolved_in_version_id null; the artifact-wide share link kept
test('only an admin or the publisher can delete', ...);   // another member → 403; the publisher (member) → 204; an admin → 204
test('a version deleted during a backup keeps its files until the sweep', ...);
  // leases.acquire(BACKUP_LEASE, 'b', 60_000); delete v1 → links 410 at once, secret blob still in the store;
  // release; sweepBlobs → secret blob gone
test('startPublishing creates the default project and schedules the jobs', ...);   // a fake Scheduler records ['content-cleanup', 'blob-sweep']
```

  `publishing-flow.test.ts` walks the milestone's "done when" on one context, in content-domain mode with `PINWALL_PUBLIC_ORIGIN=https://pinwall.test`:
  1. `setupOwner`, then `POST /api/v1/publish-sessions { target: {} }`.
  2. `POST` the tar.gz of a two-page site (with `docs/` and a video) to the upload URL → 201.
  3. `GET /api/v1/artifacts/{id}/versions/1/preview?mode=review` → the content host serves `index.html`, and `docs` answers 308.
  4. Publish v2 inline with `expected_version_id`. Then `GET /artifacts/{id}/diff?from=1&to=2` lists the change.
  5. `GET /api/v1/artifacts?q=…` finds it.
  6. `DELETE` v1 → its grant answers 410.
  7. `GET /api/v1/openapi.json` lists every M4 path: `/publish-sessions`, `/publish/inline`, `/publish/upload`, `/projects`, `/projects/{id}`, `/artifacts`, `/artifacts/recent`, `/artifacts/{id}`, `/artifacts/{id}/versions`, `/artifacts/{id}/versions/{n}`, `/artifacts/{id}/versions/{n}/files`, `/artifacts/{id}/versions/{n}/restore`, `/artifacts/{id}/versions/{n}/preview`, `/artifacts/{id}/thumbnail`, `/artifacts/{id}/diff`, `/artifacts/{id}/diff/file`, `/artifacts/{id}/diff/markdown`.

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/domain/deletion test/api/publishing-flow`. Expected: FAIL.
- [ ] **Step 3: Implement.** `deleteVersion` follows these steps (`deleteArtifact` is the same over every version):
  1. `getArtifact`, then `canDelete`.
  2. Read, before the transaction, the search text of the version that would become current (the highest remaining number).
  3. Open one transaction:
     1. `lockArtifact`; `getVersionByNumber` (an already-deleted number → 410).
     2. Collect the version's shas; its unexpired grant tokens → tombstones `content_grant` with `expiresAt` = grant expiry; the `token_hash` of its per-version share links → tombstones `share_link` (`expiresAt` null).
     3. Delete the version row. The schema cascades `version_files`, `content_grants`, the comments written on it and its per-version share links.
     4. If it was current, the highest remaining number becomes current and `indexArtifact` runs with the text from step 2.
     5. If none remains, tombstone `artifact`, tombstone the artifact's other share links, `searchDelete({ db: trx, dialect })`, and delete the artifact row.
  4. After commit: `collectBlobs(shas)` (which defers under `BACKUP_LEASE`), then publish `{ type: 'version.deleted', artifact_id, number }` or `{ type: 'artifact.deleted', artifact_id }` on `ARTIFACT_TOPIC(id)`.

  en.json: `"artifact.deleteForbidden": "Only an admin or the artifact's publisher can delete it."`
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm test:integration`. Expected: all pass, with the Postgres suites run, not skipped.
- [ ] **Step 5: Smoke run.**
  1. Start `PINWALL_DATA_DIR=$(mktemp -d) pnpm --filter @pinwall/server exec tsx src/main.ts serve` and set up the owner from the logged link.
  2. Create an API token, then `curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"target":{}}' localhost:8080/api/v1/publish-sessions`.
  3. Run its `commands.archive` against a local `./site`. Expected: JSON with `version_number: 1` and a `review_url`.
  4. Run the same command again. Expected: `409` with `upload_session_used`.
  5. `curl -sI -H "authorization: Bearer $T" localhost:8080/a/<id>/raw`. Expected: `302` to `/c/<token>/`, whose response carries `content-security-policy: sandbox allow-scripts …`.
- [ ] **Step 6: Commit** `feat(server): delete artifacts and versions with gone links, lease-aware blob removal and cleanup jobs`.

---

## M4 done when

- `pnpm lint && pnpm typecheck && pnpm test` pass, and `pnpm test:integration` passes with the M4 suites run on both SQLite and Postgres.
- Acceptance 7 (server side): Task 8 `search finds Vietnamese without diacritics`.
- Acceptance 8 (server side): Task 11 `switching the isolation mode keeps links working with identical bytes` shows that raw grants serve byte-identical bodies in both modes.
- Acceptance 9 (server side): Task 13 `deleting a version with a secret: …`.
- Acceptance 10 (server side): Task 11 `switching the isolation mode keeps links working with identical bytes` shows that `/a/:id/raw` and `/a/:id/v/:n/raw` keep working between two instances on the same data.
- Every Review Focus test passes, and `publishing-flow.test.ts` and the Task 13 smoke run succeed.
