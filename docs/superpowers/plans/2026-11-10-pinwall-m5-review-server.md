# Pinwall M5 — Comments, Sharing, Live Updates, Annotator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comment threads anchored to a text quote, an element or a point of one version, for every member; share links (per artifact or per version, public or password, expiring, revocable, optionally open to guest comments) behind `/s/:token`; live updates over SSE for the review and share viewers; and the in-page annotator that picks anchors, re-attaches them on new versions and draws pins in every frame of a review grant.

**Architecture:**
- **Domain and routes.** `domain/comments.ts`, `domain/shares.ts` and `domain/share-access.ts` own the rows and the permission rules. Members use REST routes in `api/comments.ts` and `api/shares.ts`. Share viewers use `api/share-public.ts`, authorized by the share token and an unlock cookie. `content/share-route.ts` serves `GET /s/:token`.
- **Live updates.** Every change publishes a `LiveEvent` on M4's `ARTIFACT_TOPIC(id)` through M1's `EventBus`. `http/sse.ts` turns a subscription into a `text/event-stream` with heartbeats and an access re-check at every heartbeat.
- **Annotator.** `packages/annotator` is bundled by esbuild into one IIFE. M4's `ContentHooks` serve it at `<grant base>/__pinwall/annotator.js` and inject its tag into review-grant HTML only (`transformReviewHtml`). Viewer and annotator talk by `postMessage`, and both validate with the zod schemas in `@pinwall/shared/protocol`.

**Tech Stack:** Hono 4 (`@hono/zod-openapi`, `hono/cookie`), zod 4, Kysely, htmlparser2 12, esbuild 0.28, Vitest (node + jsdom), `jsdom`, `@playwright/test` with Chromium.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` covers this milestone in §3.7 (live update), §3.8 and §3.9, plus the server side of acceptance 4 and 8.

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md` holds the Routes, the Security model (Annotator, Share unlock) and the Annotator ↔ viewer protocol. M5 refines these three sections in the same commit as this plan. Its Global Constraints apply to every task.

**Depends on:** M1, M2, M4a and M4b. The names consumed below come from their Interfaces blocks. Where merged code differs in a name or signature, the code wins: change the import and keep the behavior.
- **M1:** `AppDeps`, `AppEnv`, `EventBus`, `OneTimeStore`, `Clock`/`FixedClock`, `newId`, `newSecret`, `hashSecret`, `hashPassword`, `verifyPassword`, `safeEqual`, `deriveKey`, `AppError` and its factories, `t`, `publicUrl`, `clientIp`, `renderErrorPage`, `createTestContext` (whose `request` takes absolute URLs too), `dialects`, `wantsHtml`, and the SPA fallback `mountSpa` (an `app.get('*')` that serves `index.html` to `Accept: text/html` GETs).
- **M2:** `createApiRouter`/`buildApiRouter`/`registerXRoutes`, `jsonBodyLimit`, `page`, `Timestamp`, `encodeCursor`/`decodeCursor`, `requireAuth`, `requireSession`, `authOf`, `effectiveRole`, `hasAccess`, `enforceRateLimit`, `RateRule`, `normalizePassword`, `createSignedInUser`, `apiInit`, `setupOwner`.
- **M4:** `ARTIFACT_TOPIC`, `getArtifact`, `getVersionByNumber`, `isTombstoned`, `addTombstones`, `createGrant`, `contentUrl`, `contentBaseUrl`, `ContentHooks`/`HtmlTransform`/`contentHooks`, `ContentGrant` (shared DTO), `publishFiles`, `fetchContent`, `CONTENT_ENV`, `deleteVersion`, `deleteArtifact`.

**Events from M4 need no new hook.** M4a `commitVersion` (step 7) and `restoreVersion` already publish `{ type: 'version.published', artifact_id, version_id, number }`. M4b deletion (step 4) already publishes `{ type: 'version.deleted', artifact_id, number }` and `{ type: 'artifact.deleted', artifact_id }` on `ARTIFACT_TOPIC(id)`. Task 6's tests prove these arrive. If the merged M4 code lacks one of these calls, Task 6 adds it as a one-line additive change.

**Worktree:** M5 runs on its own worktree in parallel with M7 (web shell). Keep code in the files this plan creates. Shared files get additive lines only: `apps/server/src/{app.ts,api/router.ts,api/artifacts.ts,content/hooks.ts}`, `apps/server/{package.json,vitest.config.ts,build.mjs}`, `packages/shared/{package.json,src/api/index.ts,src/api/artifacts.ts}`, and `en.json` (new keys in one block at the end of the file, grouped by prefix `comment.*`, `share.*`, `version.*`; M7 puts its `web.*` block right after `app.name`).

## Global Constraints

The roadmap's Global Constraints apply, plus these for M5:
- **Annotator injection, verbatim:** `<script src="<grant base>/__pinwall/annotator.js" data-pinwall-annotator></script>` (M4's `contentBaseUrl` already ends in `/`). It goes only into `text/html` responses of `review` grants, including nested frames and rendered Markdown, and it goes in right after `<head>`. When the head holds `<meta http-equiv="Content-Security-Policy">` elements, it goes right after the last of them instead, so the page's own policy governs the script (spec §3.8). Without a head it goes right after `<html>`, else after the doctype, else after a BOM, else at byte 0. Never put it before a doctype. No other byte changes. Pinwall never relaxes, rewrites or adds to a page's CSP.
- **Byte-for-byte:** raw grants, and `/s/:token` links without comments, serve the stored bytes unchanged (acceptance 8).
- **Secrets:** share tokens are `newSecret()`, stored only as `hashSecret(token)` in `share_links.token_hash` and shown once; guest edit tokens are kept only as hashes in `OneTimeStore`; share passwords are stored as `hashPassword(normalizePassword(pw))`.
- **Share unlock cookie, verbatim:** name `__Secure-pinwall_share` on an https public origin, else `pinwall_share`; two `Set-Cookie` headers with one value, `Path=/s/<token>` and `Path=/api/v1/share/<token>`; `HttpOnly; SameSite=Lax`, plus `Secure` on https; `Max-Age` = seconds until `min(now + 86_400_000, link.expires_at)`; value `v1.<expiresAt>.<mac>`, `mac` = base64url HMAC-SHA256 of `${link.id}.${expiresAt}.${link.password_hash}` under `deriveKey(config.secretKey, 'share-unlock')`.
- **SSE, verbatim:** headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`; first chunk `retry: 5000\n\n`; events `event: <type>\ndata: <json>\n\n`; heartbeat `: ping\n\n` every `25_000` ms.
- **Guest comments:** guest name required; rate limited; edit or delete only within `900_000` ms of writing, and only with that comment's guest token.
- **Visibility:** every member sees every comment. A share viewer sees comments only if the link allows them, and then only threads written on versions numbered ≤ the version the link shows, so a per-version link never leaks newer content.
- **Annotator behavior:** exactly one global, `window.__pinwallAnnotator`; no prototype patches, network requests, console output, storage or `innerHTML`; every listener wrapped so errors never escape; reacts only to messages with `event.source === window.top` that pass `ViewerToPageMessage`; draws only inside its Shadow DOM overlay and never moves, wraps or restyles page nodes.
- **Both databases:** DB tests run in `describe.each(dialects)`.
- **i18n:** every message a person can read goes through `t()`, with the exact copy this plan gives.

## Review Focus

1. **Pages whose own CSP blocks scripts** (`<meta http-equiv="Content-Security-Policy" content="script-src 'none'">` in the head). Expected: the annotator tag lands after that meta, so the policy applies, the script does not run, and the viewer never gets `ready`. → Task 9 `injects %s` (`the last CSP meta of the head`, `a CSP meta without a head tag`); Task 10 `pins a comment on text inside a nested frame` (its `locked.html` frame sends no `ready`).
2. **Text that repeats or reflows between versions** (the same phrase twice, or line breaks and indentation changed by a formatter). Expected: re-attaches to the occurrence whose context matches, or by whitespace-normalized quote; otherwise falls back to DOM path, then position, flagged `found: false`. → Task 7 `picks the occurrence whose context matches`, `falls back to whitespace-normalized matching`.
3. **A live stream that outlives access:** Revoke now, sign-out, a revoked or expired link, an unlock that lapsed, or a tab closed mid-stream. Expected: the stream ends at the next heartbeat; closed tabs unsubscribe and stop their timer. → Task 6 `member streams need a browser session and end with it`, `share streams end when the link is revoked or the unlock lapses`, `closing the request unsubscribes and stops the heartbeat`, `a consumer that stops reading is cut off`.
4. **Pages that are not plain UTF-8:** windows-1252 bytes, CRLF, a UTF-8 BOM, a UTF-16 file, `<HEAD>` in capitals, `<head>` inside a comment or a script string. Expected: the tag is spliced at the right byte with every other byte unchanged; UTF-16 is left alone. → Task 9 `injects %s`, `bytes outside the insertion are untouched`, `UTF-16 documents are left unchanged`.
5. **Hostile or busy page scripts:** click handlers that `stopPropagation`, links that navigate, scripts that rewrite `document.documentElement`, global CSS such as `* { display: none !important }`. Expected: comment-mode clicks never reach the page and never navigate; pins survive a DOM rewrite and stay styled. → Task 8 `comment mode swallows clicks before page handlers`, `pins come back after the page rewrites its DOM`, `page CSS cannot reach the overlay`.

## Interface handed to M6 and M8

- **M6 (MCP):** `listThreads(deps, artifactId, { status: 'open', … })` (threads carry `anchor.quote`, `anchor.page`, `anchor.dom`), `addReply`, `resolveThread(deps, user, id, versionId | null)`, `createShareLink`, `listShareLinks`, `revokeShareLink`, `shareUrl`.
- **M8 review viewer:** frames M4's review preview; threads through `/api/v1/artifacts/{id}/comments` and `/api/v1/comments/{id}…`; `new EventSource('/api/v1/artifacts/<id>/events')` (cookie session), each event parsed with `LiveEvent`; refetch threads on `version.deleted` and after a reconnect.
- **M8 share viewer** (SPA route `/s/:token`): `GET /api/v1/share/{token}` → 200 `ShareInfo` | 401 `details.password_required: true` (password page) | 404/410 ("gone"). `POST /api/v1/share/{token}/unlock` → 204, then reload `/s/<token>` (a link without comments then redirects to raw content). Guest comments at `/api/v1/share/{token}/comments…`, guest token in the `X-Pinwall-Guest-Token` header, kept in `sessionStorage` per comment id. Live updates at `/api/v1/share/{token}/events`.
- **M8 annotator contract** (also the header comment of `protocol.ts`): each frame of a review grant posts `ready` at DOMContentLoaded; on every `ready` the viewer sends `set-mode` and `show-anchors` to all descendant frames; each annotator keeps the anchors whose `page` is its own and always answers `anchors-placed`; a frame with no `ready` within 3 s of its `load` event has no annotator (e.g. CSP-blocked) and gets point comments on the viewer's overlay.

---

### Task 1: Protocol and DTO schemas in `@pinwall/shared` (model: sonnet)

**Files:**
- Create: `packages/shared/src/protocol.ts`, `packages/shared/src/api/{comments.ts,shares.ts,events.ts}`
- Modify: `packages/shared/package.json` (`exports["./protocol"] = "./src/protocol.ts"`), `packages/shared/src/api/index.ts` (re-export the three new modules)
- Test: `packages/shared/test/{protocol,review-dtos}.test.ts`

**Interfaces:**
- Consumes: M2 `page`, `Timestamp`; M4 `ContentGrant` (shared `api/content.ts`).
- Produces (each schema also exports its same-named `z.infer` type; protocol uses classic `zod` so DTOs can embed `Anchor`):

```ts
// protocol.ts — header comment documents the contract in "Interface handed to M6 and M8"
export const PROTOCOL_VERSION = 1;
export const ANNOTATOR_PATH = '__pinwall/annotator.js';
export const ANNOTATOR_GLOBAL = '__pinwallAnnotator';
export const QUOTE_CONTEXT_CHARS = 32; export const QUOTE_MAX_CHARS = 2000; export const DOM_PATH_MAX_CHARS = 2000; export const MAX_ANCHORS = 1000;
export const Quote;     // { exact: string 1..2000, prefix: string ≤32, suffix: string ≤32 }
export const Anchor;    // { page: string ≤1024, kind: 'text'|'element'|'point', quote?: Quote, dom?: { path: string 1..2000 },
                        //   position: { x: number 0..1, y: number 0..1 }, viewport: { width: int 0..100_000 } }
                        //   refine: kind 'text' needs quote, kind 'element' needs dom (issue path 'quote' / 'dom')
export const PageToViewerMessage;   // discriminatedUnion('type'), each { pinwall: z.literal(1), … }: ready { page, frameId }, anchor-picked { anchor, frameId },
                                    //   anchors-placed { results: { id, found }[] ≤ 1000, frameId }, pin-clicked { id }, navigated { page, frameId }
export const ViewerToPageMessage;   // set-mode { mode: 'browse'|'comment' }, show-anchors { anchors: { id, number: int ≥1, resolved, anchor }[] ≤ 1000 }, focus-anchor { id }
                                    //   ids and frameIds are strings 1..64
export function parsePageMessage(data: unknown): PageToViewerMessage | null;
export function parseViewerMessage(data: unknown): ViewerToPageMessage | null;
// api/comments.ts
export const CommentBody;   // z.string().trim().min(1).max(10_000)
export const GuestName;     // z.string().trim().min(1).max(60)
export const VersionRef;    // { id, number }
export const UserRef;       // { user_id: string | null, name: string | null }
export const CommentAuthor; // discriminatedUnion('type', [{ type: 'member', user_id: string|null, name: string|null }, { type: 'guest', name }])
export const Comment;       // { id, thread_id, artifact_id, version: VersionRef, author: CommentAuthor, body, created_at, updated_at, edited_at: Timestamp|null }
export const CommentThread; // Comment.extend({ anchor: Anchor, status: 'open'|'resolved', resolved_in_version: VersionRef|null,
                            //   resolved_by: UserRef|null, resolved_at: Timestamp|null, replies: z.array(Comment) })
export const CommentThreadList;   // page(CommentThread)
export const ThreadQuery;   // { status: enum(open,resolved,all).default('all'), version?: coerce int ≥1, limit: coerce int 1..200 default 100, cursor?: string }
export const CreateThreadRequest; // { body: CommentBody, anchor: Anchor, version_id?: string }
export const CommentBodyRequest;  // { body: CommentBody }   (reply and edit)
export const ResolveRequest;      // { version_id?: string }
export const GuestThreadRequest;  // { guest_name: GuestName, body, anchor }
export const GuestReplyRequest;   // { guest_name: GuestName, body }
export const GuestCreated;        // { thread: CommentThread, comment_id: string, guest_token: string }
// api/shares.ts
export const SHARE_PASSWORD_MIN_LENGTH = 8;
export const ShareLink;     // { id, artifact_id, version: VersionRef|null (null = follows current), has_password, allow_comments,
                            //   expires_at|null, created_by: UserRef|null, created_at, last_used_at|null, revoked_at|null, status: 'active'|'expired'|'revoked' }
export const ShareLinkList; // page(ShareLink)
export const ShareLinkQuery;        // { include_revoked: coerce boolean default false, limit 1..200 default 50, cursor? }
export const CreateShareLinkRequest;// { version_id?: string|null, password?: string(1..1024)|null, expires_at?: Timestamp|null, allow_comments?: boolean default false }
export const CreatedShareLink;      // { link: ShareLink, token: string, url: string }
export const ShareInfo;     // { artifact_name, kind: 'html'|'markdown', version_number, follows_current, allow_comments, expires_at|null, content: ContentGrant }
export const UnlockRequest; // { password: z.string().min(1).max(1024) }
// api/events.ts
export const LiveEvent;     // discriminatedUnion('type'):
  // { type: 'version.published', artifact_id, version_id, number } | { type: 'version.deleted', artifact_id, number } | { type: 'artifact.deleted', artifact_id }
  // | { type: 'comment.created'|'comment.updated'|'comment.resolved'|'comment.reopened', artifact_id, thread: CommentThread }
  // | { type: 'comment.deleted', artifact_id, thread_id, comment_id, version_number, thread: CommentThread | null }   (null = the thread itself was deleted)
export const LIVE_EVENT_TYPES: readonly LiveEvent['type'][];
```

- [ ] **Step 1: Write the failing tests.**

```ts
const text = { page: 'docs/', kind: 'text', quote: { exact: 'Bảng giá', prefix: 'Xem ', suffix: ' mới' },
  dom: { path: '#pricing > h2' }, position: { x: 0.1, y: 0.2 }, viewport: { width: 1280 } };
test('Anchor accepts each kind and enforces its selectors', () => {
  expect(Anchor.parse(text)).toEqual(text);
  expect(Anchor.safeParse({ ...text, quote: undefined }).success).toBe(false);
  expect(Anchor.safeParse({ ...text, kind: 'element', quote: undefined, dom: undefined }).success).toBe(false);
  expect(Anchor.parse({ page: '', kind: 'point', position: { x: 0, y: 1 }, viewport: { width: 0 } }).kind).toBe('point');
  for (const bad of [{ position: { x: 1.5, y: 0 } }, { quote: { ...text.quote, prefix: 'p'.repeat(33) } },
    { quote: { ...text.quote, exact: 'e'.repeat(2001) } }, { dom: { path: '' } }])
    expect(Anchor.safeParse({ ...text, ...bad }).success).toBe(false);
});
test('messages need pinwall: 1 and a known type for their direction', () => {
  expect(parsePageMessage({ pinwall: 1, type: 'ready', page: '', frameId: 'f1' })).toEqual({ pinwall: 1, type: 'ready', page: '', frameId: 'f1' });
  for (const bad of [{ pinwall: 2, type: 'ready', page: '', frameId: 'f1' }, { pinwall: 1, type: 'nope' }, 'ready', null,
    { pinwall: 1, type: 'set-mode', mode: 'comment' }]) expect(parsePageMessage(bad)).toBeNull();
  expect(parseViewerMessage({ pinwall: 1, type: 'set-mode', mode: 'comment' })?.type).toBe('set-mode');
  const many = Array.from({ length: 1001 }, (_, i) => ({ id: `c${i}`, number: i + 1, resolved: false, anchor: text }));
  expect(parseViewerMessage({ pinwall: 1, type: 'show-anchors', anchors: many })).toBeNull();
});
// review-dtos.test.ts
test('LiveEvent parses every event type', ...);   // one sample per LIVE_EVENT_TYPES entry parses; { type: 'comment.created' } without thread fails
test('request defaults', ...);   // CreateShareLinkRequest.parse({}) → { allow_comments: false }; ThreadQuery.parse({}) → { status: 'all', limit: 100 };
  // CommentBody.safeParse('   ').success false; GuestName of 61 chars fails
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/shared test`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the schemas with the limits above.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/shared test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): add annotator protocol, comment, share link and live event schemas`.

### Task 2: Comment threads — domain and member REST (model: opus)

**Files:**
- Create: `apps/server/src/domain/{comments.ts,live.ts}`, `apps/server/src/api/comments.ts`, `apps/server/test/helpers/review.ts`
- Modify: `apps/server/src/api/router.ts`, `apps/server/src/api/artifacts.ts` (`toArtifactSummary` batch counts), `packages/shared/src/api/artifacts.ts` (`ArtifactSummary` gains `open_thread_count: number`, `share_link_count: number`), `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/comments.test.ts`

**Interfaces:**
- Consumes: Task 1 DTOs and `LiveEvent`; M4 `getArtifact`, `ARTIFACT_TOPIC`, `publishFiles`, `deleteVersion`, `addTombstones`; M2 `requireAuth`, `authOf`, `effectiveRole`, `encodeCursor`, `decodeCursor`, `jsonBodyLimit`, `createSignedInUser`, `apiInit`.
- Produces:

```ts
// domain/live.ts
export function publishLive(deps: AppDeps, event: LiveEvent): void;   // deps.events.publish(ARTIFACT_TOPIC(event.artifact_id), event)
// domain/comments.ts
export type CommentActor = { kind: 'member'; user: UserRow };        // Task 5 adds the guest variant
export interface ThreadFilter { status: 'open' | 'resolved' | 'all'; versionNumber?: number; maxVersionNumber?: number; limit: number; cursor: string | null }
export function listThreads(deps: AppDeps, artifactId: string, f: ThreadFilter): Promise<{ items: CommentThread[]; nextCursor: string | null }>;
  // roots joined to versions, order created_at, id; cursor { c, i }; replies, authors and version refs batch-loaded (no N+1)
export function getThread(deps: AppDeps, threadId: string): Promise<CommentThread>;
export function getComment(db: Db, id: string): Promise<CommentRow>;   // notFound(t('comment.notFound'))
export function createThread(deps: AppDeps, actor: CommentActor, artifactId: string,
  p: { body: string; anchor: Anchor; versionId: string | null }): Promise<CommentThread>;   // versionId null → current version
export function addReply(deps: AppDeps, actor: CommentActor, commentId: string, body: string): Promise<{ thread: CommentThread; comment: Comment }>;
  // replying to a reply attaches to its root (threads are flat)
export function editComment(deps: AppDeps, actor: CommentActor, commentId: string, body: string): Promise<{ thread: CommentThread; comment: Comment }>;
export function deleteComment(deps: AppDeps, actor: CommentActor, commentId: string): Promise<void>;
export function resolveThread(deps: AppDeps, user: UserRow, commentId: string, versionId: string | null): Promise<CommentThread>;
export function reopenThread(deps: AppDeps, user: UserRow, commentId: string): Promise<CommentThread>;
export function countOpenThreads(db: Db, artifactIds: readonly string[]): Promise<Map<string, number>>;
// domain/shares.ts (created here with one function; Task 3 adds the rest)
export function countActiveShareLinks(db: Db, artifactIds: readonly string[], now: number): Promise<Map<string, number>>;   // not revoked, expires_at null or > now
// test/helpers/review.ts
export function sampleAnchor(over?: Partial<Anchor>): Anchor;   // the `text` sample of Task 1, merged with `over`
export function postThread(ctx: TestContext, cookie: string, artifactId: string, o?: { body?: string; anchor?: Anchor; versionId?: string }): Promise<CommentThread>;
```

  Routes (`requireAuth`; bodies behind `jsonBodyLimit`):

  | Route | Success |
  | --- | --- |
  | `GET /artifacts/{id}/comments?status=&version=&limit=&cursor=` | 200 `CommentThreadList` |
  | `POST /artifacts/{id}/comments` | 201 `CommentThread` |
  | `POST /comments/{id}/replies` | 201 `Comment` |
  | `PATCH /comments/{id}` | 200 `Comment` |
  | `DELETE /comments/{id}` | 204 |
  | `POST /comments/{id}/resolve` | 200 `CommentThread` |
  | `POST /comments/{id}/reopen` | 200 `CommentThread` |

- [ ] **Step 1: Write the failing tests.** They run in `describe.each(dialects)`. `pub` is the publisher (member), `m` and `o` are other members, and `admin` has `idpRole 'admin'`. `v1` and `v2` come from `publishFiles`, and `clock` is a `FixedClock`.

```ts
test('a member opens a thread on the current version', async () => {
  const r = await ctx.request(`/api/v1/artifacts/${id}/comments`, apiInit(ctx, { method: 'POST', cookie: m.cookie, body: { body: ' Sửa giá ', anchor: sampleAnchor() } }));
  expect(r.status).toBe(201);
  const th = await r.json();
  expect(th).toMatchObject({ body: 'Sửa giá', status: 'open', version: { id: v2.id, number: 2 }, anchor: sampleAnchor(), thread_id: th.id,
    author: { type: 'member', user_id: m.user.id, name: m.user.name }, replies: [], edited_at: null, resolved_in_version: null });
});
test('a thread can be written on an older version', ...);   // version_id v1.id → version.number 1; another artifact's version id → 400 t('version.notInArtifact')
test('replies form a flat thread, oldest first', ...);
  // reply to the root, then reply to that reply → root.replies has both in order, each thread_id === root.id, no 'anchor' or 'status' key
test('list returns thread trees filtered by status and version', ...);
  // A on v1 resolved, B and C on v2, B with a reply → list [A, B, C] with B.replies.length 1; ?status=open → [B, C]; ?status=resolved → [A];
  // ?version=1 → [A]; ?limit=2 → 2 + next_cursor, then [C] + null; garbage cursor → 400
test('only the author edits, and edits set edited_at', ...);   // m PATCH → 200, body changed, edited_at === clock.now(); o → 403 t('comment.editForbidden'); pub → 403
test('the author, the publisher or an admin deletes; deleting a root deletes its thread', ...);
  // m writes root R and reply X; o DELETE X → 403 t('comment.deleteForbidden'); m deletes X → 204; pub deletes a reply by o → 204;
  // admin DELETE R → 204 and the comments table is empty; unknown id → 404 t('comment.notFound')
test('resolve defaults to the current version, reopen clears it', ...);
  // POST resolve {} → { status: 'resolved', resolved_in_version: { id: v2.id, number: 2 }, resolved_by: { user_id: m.user.id }, resolved_at: clock.now() };
  // reopen → { status: 'open', resolved_in_version: null, resolved_by: null, resolved_at: null }
test('resolve names a version of the same artifact; replies cannot be resolved', ...);   // version_id v1 → number 1; other artifact → 400; a reply id → 400 t('comment.notThread')
test('a thread on v1 resolved in v2 survives deleting v2 with no resolving version', ...);   // deleteVersion(2) → status 'resolved', resolved_in_version null
test('comments need a member and a valid body and anchor', ...);   // no auth → 401; '   ' → 400; 10_001 chars → 400; text anchor without quote → 400, issues[0].path 'anchor.quote'
test('comments of a deleted artifact are gone', ...);   // tombstone + delete the artifact row → GET comments 410
test('changes are published on the artifact topic', async () => {
  const seen: LiveEvent[] = []; ctx.deps.events.subscribe(ARTIFACT_TOPIC(id), (e) => seen.push(LiveEvent.parse(e)));
  // create R, reply X, edit X, resolve R, reopen R, delete X, delete R
  expect(seen.map((e) => e.type)).toEqual(['comment.created', 'comment.created', 'comment.updated', 'comment.resolved',
    'comment.reopened', 'comment.deleted', 'comment.deleted']);
  expect(seen[5]).toMatchObject({ comment_id: X, thread_id: R, version_number: 2, thread: { id: R, replies: [] } });
  expect(seen[6]).toMatchObject({ comment_id: R, thread_id: R, thread: null });
});
test('artifact summaries count open threads and active share links', ...);
  // 2 open + 1 resolved; share_links rows inserted directly: active, revoked, expired → GET /artifacts/{id} → open_thread_count 2, share_link_count 1
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/comments`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Writes, each in one transaction.** `getArtifact` gives the 404 and 410 answers. A root stores `anchor` as `JSON.stringify(anchor)` and `status: 'open'`; a reply stores neither. Ids come from `newId('cmt')`.
  - **Events.** After commit, publish the event built from the re-read thread. Deleting a root removes its replies through the FK cascade.
  - **Permissions.** Edit: `author_user_id === user.id`. Delete: the author, `artifact.created_by`, or `effectiveRole(user) === 'admin'`. Resolve and reopen: any member.
  - **Summary counts.** `toArtifactSummary` adds the two counts with one grouped query each.
  - **en.json:**
    - `"comment.notFound": "This comment does not exist."`
    - `"comment.editForbidden": "Only the author can edit this comment."`
    - `"comment.deleteForbidden": "Only the author, the artifact's publisher or an admin can delete this comment."`
    - `"comment.notThread": "Only the first comment of a thread can be resolved or reopened."`
    - `"version.notInArtifact": "That version does not belong to this artifact."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add comment threads with replies, edit, delete, resolve and reopen`.

### Task 3: Share links — create, list, revoke (model: opus)

**Files:**
- Create: `apps/server/src/api/shares.ts`
- Modify: `apps/server/src/domain/shares.ts`, `apps/server/src/api/router.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/share-links.test.ts`

**Interfaces:**
- Consumes: Task 1 `ShareLink`, `CreateShareLinkRequest`, `CreatedShareLink`, `ShareLinkQuery`, `SHARE_PASSWORD_MIN_LENGTH`; M4 `getArtifact`, `addTombstones`, `createGrant`; M2 `normalizePassword`, `effectiveRole`; M1 `newId('shr')`, `newSecret`, `hashSecret`, `hashPassword`, `publicUrl`.
- Produces:

```ts
// domain/shares.ts (adds)
export function shareUrl(config: Config, token: string): string;   // publicUrl(config, '/s/' + token)
export function checkSharePassword(pw: string): string;           // normalizePassword; < 8 or > 256 code points → badRequest(t('share.passwordTooShort', { min: 8 }) | t('share.passwordTooLong', { max: 256 }), { field: 'password' })
export function createShareLink(deps: AppDeps, actor: UserRow, artifactId: string,
  p: { versionId: string | null; password: string | null; expiresAt: number | null; allowComments: boolean }): Promise<{ row: ShareLinkRow; token: string }>;
export function listShareLinks(deps: AppDeps, artifactId: string, p: { includeRevoked: boolean; limit: number; cursor: string | null }):
  Promise<{ items: ShareLink[]; nextCursor: string | null }>;      // created_at desc, id desc
export function toShareLinks(deps: AppDeps, rows: ShareLinkRow[]): Promise<ShareLink[]>;   // batch version refs and creators; status from revoked_at / expires_at vs now
export function revokeShareLink(deps: AppDeps, actor: UserRow, linkId: string): Promise<void>;
  // notFound(t('share.unknown')); allowed: link.created_by, artifact.created_by or admin, else forbidden(t('share.revokeForbidden')); idempotent
```

  Routes (`requireAuth`):
  - `GET /artifacts/{id}/share-links` → 200 `ShareLinkList`.
  - `POST /artifacts/{id}/share-links` → 201 `CreatedShareLink`.
  - `DELETE /share-links/{id}` → 204.

- [ ] **Step 1: Write the failing tests** (`describe.each(dialects)`; members as in Task 2; `create(body)` POSTs `/api/v1/artifacts/{id}/share-links` with `m.cookie`, `list(q = '')` GETs it and returns the JSON):

```ts
test('a member creates a link and sees its token once', async () => {
  const body = await (await create({})).json();
  expect(body).toMatchObject({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), link: { version: null, has_password: false,
    allow_comments: false, expires_at: null, status: 'active', created_by: { user_id: m.user.id }, revoked_at: null } });
  expect(body.url).toBe(`http://localhost:8080/s/${body.token}`);
  const row = await ctx.deps.db.db.selectFrom('share_links').selectAll().executeTakeFirstOrThrow();
  expect(row.token_hash).toBe(hashSecret(body.token));
  expect(Object.values(row)).not.toContain(body.token);
  expect((await list()).items[0]).not.toHaveProperty('token');
});
test('per-version links, passwords and expiry are validated', ...);
  // version_id v1 → link.version { number: 1 }; another artifact's version → 400 t('version.notInArtifact');
  // password 'seven77' → 400 t('share.passwordTooShort', { min: 8 }); 'Mật khẩu 1' → has_password true, password_hash starts 'scrypt$';
  // expires_at === clock.now() → 400 t('share.badExpiry'); now + 1 → 201
test('the creator, the publisher or an admin can revoke', ...);
  // m creates; o DELETE → 403 t('share.revokeForbidden'); pub → 204; again → 204; list hides it; ?include_revoked=true → status 'revoked';
  // another link: m → 204; admin on a third → 204; 'shr_unknown' → 404 t('share.unknown')
test('revoking ends the content grants made from the link at once', ...);
  // createGrant({ versionId, mode: 'raw', shareLinkId: link.id }) → fetchContent 200; revoke → fetchContent 410 t('content.gone.title'); grant row gone, tombstone content_grant present
test('status reports expiry', ...);   // expires_at now + 1000; advance 1001 → list status 'expired'
test('share links need a member', ...);   // no auth → 401
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/share-links`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Revoke:** one transaction sets `revoked_at = now` when it is null. It selects the link's `content_grants`, calls `addTombstones` with kind `content_grant` and `expiresAt` = each grant's expiry, then deletes those grants.
  - **en.json:**
    - `"share.unknown": "This share link does not exist."`
    - `"share.passwordTooShort": "Use a password of at least {{min}} characters."`
    - `"share.passwordTooLong": "Use a password of at most {{max}} characters."`
    - `"share.badExpiry": "Choose an expiry in the future."`
    - `"share.revokeForbidden": "Only the link's creator, the artifact's publisher or an admin can revoke it."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add share links with hashed tokens, passwords, expiry and revocation`.

### Task 4: `/s/:token`, password unlock and share info (model: opus)

**Files:**
- Create: `apps/server/src/domain/share-access.ts`, `apps/server/src/api/share-public.ts`, `apps/server/src/content/share-route.ts`
- Modify: `apps/server/src/app.ts` (`mountShareLinks(app)` before the SPA fallback), `apps/server/src/api/router.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/content/share-route.test.ts`, `apps/server/test/api/share-unlock.test.ts`

**Interfaces:**
- Consumes: Task 3 `createShareLink`, `shareUrl`; Task 1 `ShareInfo`, `UnlockRequest`; M4 `createGrant`, `contentUrl`, `isTombstoned`, `fetchContent`, `CONTENT_ENV`; M2 `enforceRateLimit`, `RateRule`, `normalizePassword`, `jsonBodyLimit`; M1 `verifyPassword`, `deriveKey`, `safeEqual`, `clientIp`, `renderErrorPage`, `hono/cookie`.
- Produces:

```ts
// domain/share-access.ts
export const UNLOCK_MAX_MS = 86_400_000;
export const SHARE_TOUCH_INTERVAL_MS = 60_000;
export const SHARE_RATES: { open: RateRule; unlock: RateRule; unlockLink: RateRule; guestComment: RateRule; guestCommentLink: RateRule };
  // open 'share-open' 120 / 600_000 per IP · unlock 'share-unlock' 10 / 900_000 per `${linkId}:${ip}` · unlockLink 'share-unlock-link' 100 / 3_600_000 per link id
  // guestComment 'share-comment' 10 / 600_000 per `${linkId}:${ip}` · guestCommentLink 'share-comment-link' 200 / 3_600_000 per link id   (Task 5 uses these two)
export interface ShareState { link: ShareLinkRow; artifact: ArtifactRow; version: VersionRow; locked: boolean }
export function resolveShare(deps: AppDeps, token: string, unlockCookie: string | undefined): Promise<ShareState>;
  // no row: isTombstoned('share_link', hash) → gone(t('share.gone.message'), { reason: 'deleted' }), else notFound(t('share.notFound.message'));
  // revoked → gone(…, { reason: 'revoked' }); expires_at <= now → gone(t('share.expired.message'), { reason: 'expired' });
  // version = link.version_id ?? artifact.current_version_id; locked = password_hash !== null && checkUnlock(...) === null
export function readUnlockCookie(c: Context<AppEnv>): string | undefined;
export function shareCookieName(config: Config): '__Secure-pinwall_share' | 'pinwall_share';
export function unlockValue(deps: AppDeps, link: ShareLinkRow, expiresAt: number): string;   // v1.<expiresAt>.<mac>
export function checkUnlock(deps: AppDeps, link: ShareLinkRow, value: string | undefined): number | null;   // its expiresAt when valid and in the future
export function unlockShare(c: Context<AppEnv>, token: string, password: string): Promise<void>;   // rate limits, verifies, sets both cookies
export function shareGrant(deps: AppDeps, s: ShareState, mode: GrantMode): Promise<ContentGrantRow>;
  // createGrant({ versionId, mode, shareLinkId: link.id, ttlMs: min(previewMs, link.expires_at - now) })
export function touchShareLink(deps: AppDeps, link: ShareLinkRow): Promise<void>;   // last_used_at when null or older than 60 s
export function shareInfo(deps: AppDeps, s: ShareState): Promise<ShareInfo>;   // content: review grant when allow_comments, raw otherwise
// content/share-route.ts
export function mountShareLinks(app: Hono<AppEnv>): void;   // GET /s/:token
```

  Routes (no member auth; `Cache-Control: no-store` on every response):
  - `GET /api/v1/share/{token}` → 200 `ShareInfo`. A locked link → 401 `unauthorized`, `t('share.passwordRequired')`, `details: { password_required: true }`.
  - `POST /api/v1/share/{token}/unlock` (`jsonBodyLimit`) → 204 plus the two cookies. A wrong password → 401 `invalid_credentials` `t('auth.wrongPassword')`. A link without a password → 204 without cookies.
  - `GET /s/:token` follows this decision order:
    1. Apply `SHARE_RATES.open`.
    2. `resolveShare`. A 404 or 410 → `renderErrorPage` with the `share.notFound.*`, `share.expired.*` (reason `expired`) or `share.gone.*` copy, whatever the `Accept` header.
    3. `touchShareLink`.
    4. A locked link, or `allow_comments` → `await next()`, so M1's `mountSpa` serves `index.html` (SPA route `/s/:token`; browsers send `Accept: text/html`), then set `Cache-Control: no-store` on `c.res`.
    5. Otherwise → 302 to `contentUrl(config, shareGrant(raw).token)`.

- [ ] **Step 1: Write the failing tests.** `share-route.test.ts` runs `describe.each([['single-domain', {}], ['content-domain', CONTENT_ENV]])` on SQLite. `PINWALL_WEB_DIR` points at a temp dir whose `index.html` is `<!doctype html><title>SPA</title>`.

```ts
test('/s/:token redirects to a fresh raw grant served byte-for-byte', async () => {   // acceptance 8
  const html = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!doctype html>\r\n<html><head><title>Giá</title></head><body>x</body></html>\r\n')]);
  // publishFiles({ 'index.html': html }); link {} (no password, no comments)
  const r = await ctx.request(`/s/${token}`);
  expect(r.status).toBe(302);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const grant = await ctx.deps.db.db.selectFrom('content_grants').selectAll().executeTakeFirstOrThrow();
  expect(grant).toMatchObject({ mode: 'raw', share_link_id: linkId });
  expect(r.headers.get('location')).toBe(contentUrl(ctx.deps.config, grant.token));
  const body = Buffer.from(await (await ctx.request(r.headers.get('location')!)).arrayBuffer());   // absolute URL: works in both modes
  expect(body.equals(html)).toBe(true);
  // a second GET /s/ → another grant token
});
test('a link that follows the current version moves with publishes; a per-version link stays', ...);   // v2 published → follow-current serves v2, the v1 link serves v1
test('grants made from an expiring link end with it', ...);   // link expires_at now + 3_600_000 → grant.expires_at === link.expires_at
test('deleted, revoked, expired and unknown links answer HTML pages', ...);
  // expired (advance past expires_at) → 410 text/html containing t('share.expired.title'); revoked → 410 t('share.gone.title');
  // artifact deleted with M4 deleteArtifact → 410; per-version link whose version was deleted → 410; random token → 404 t('share.notFound.title');
  // each with accept 'application/json' still text/html
test('a password link or a link with comments opens the SPA', ...);   // accept text/html: both → 200, body contains '<title>SPA</title>', cache-control no-store
test('opening links is rate limited per IP', ...);   // 120 × → 302; the 121st → 429 text/html
test('last use is recorded at most once a minute', ...);   // last_used_at === now; +30_000 open → unchanged; +60_000 → updated
```

  `share-unlock.test.ts` runs in `describe.each(dialects)`. `unlock(token, pw, o?)` POSTs `/api/v1/share/<token>/unlock` with `apiInit(ctx, { method: 'POST', body: { password: pw }, ...o })`.

```ts
test('share info is locked until the password is given', ...);
  // GET /api/v1/share/<t> → 401 { error: { code: 'unauthorized', details: { password_required: true } } }
test('unlock sets two path-scoped cookies that open the link', async () => {
  const r = await unlock(token, 'Mật khẩu 1');
  expect(r.status).toBe(204);
  const sc = r.headers.getSetCookie();
  expect(sc).toHaveLength(2);
  expect(sc[0]).toMatch(new RegExp(`^pinwall_share=v1\\.\\d+\\.[A-Za-z0-9_-]{43};`));
  expect(sc.map((s) => /Path=([^;]+)/.exec(s)?.[1]).sort()).toEqual([`/api/v1/share/${token}`, `/s/${token}`]);
  for (const s of sc) { for (const p of ['HttpOnly', 'SameSite=Lax', 'Max-Age=86400']) expect(s).toContain(p); expect(s).not.toContain('Secure'); }
  // with the cookie: GET /api/v1/share/<t> → 200; GET /s/<t> (no comments) → 302 to a raw grant
});
test('unlock cookies are Secure, __Secure- and capped by the link expiry on https', ...);
  // PINWALL_PUBLIC_ORIGIN=https://pinwall.test, link expires in 7_200_000 ms → '__Secure-pinwall_share=' with Secure and Max-Age=7200
test('an unlock lapses after 24 hours and opens only its own link', ...);   // +86_400_001 → 401 again; link B's cookie value sent to link A → 401
test('a password typed in another Unicode form unlocks', ...);   // created with NFC, unlock with NFD → 204
test('a wrong password is refused and unlock is rate limited', ...);   // wrong → 401 invalid_credentials; 10 wrong → the 11th 429; the right one after → 429
test('share info gives a review grant when comments are allowed, raw otherwise', ...);
  // allow_comments → { artifact_name, kind: 'html', version_number: 2, follows_current: true, allow_comments: true, expires_at: null, content: { mode: 'review' } };
  // content.url === contentUrl(config, <the new grant's token>); without comments → content.mode 'raw'
test('cross-origin unlock is refused', ...);   // origin https://evil.example → 403 (M2 originCheck)
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/content/share-route test/api/share-unlock`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`unlockShare`, in order:** `resolveShare` (errors propagate); no password → return; `SHARE_RATES.unlock` keyed `${link.id}:${clientIp}`, then `SHARE_RATES.unlockLink` keyed `link.id`; `verifyPassword(normalizePassword(pw), link.password_hash)`; on success `expiresAt = min(now + UNLOCK_MAX_MS, link.expires_at ?? ∞)` and `setCookie` twice as the Global Constraints say.
  - **Cookies.** `checkUnlock` compares with `safeEqual`. The key is `deriveKey(config.secretKey, 'share-unlock')`, read the way M3 reads its key (throw when it is null). Both public routes read the cookie through `readUnlockCookie`.
  - **en.json:**
    - `"share.notFound.title": "Link not found"`
    - `"share.notFound.message": "This share link does not exist. Check that it was copied completely."`
    - `"share.gone.title": "Link no longer available"`
    - `"share.gone.message": "This share link was revoked, or what it shared was deleted."`
    - `"share.expired.title": "Link expired"`
    - `"share.expired.message": "This share link has expired. Ask the person who shared it for a new one."`
    - `"share.passwordRequired": "Enter the password to open this link."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`. Expected: PASS, M1's SPA and security-header tests included.
- [ ] **Step 5: Commit** `feat(server): serve share links with password unlock, gone pages and byte-for-byte raw redirects`.

### Task 5: Guest comments through share links (model: opus)

**Files:**
- Modify: `apps/server/src/domain/comments.ts` (guest actor), `apps/server/src/api/share-public.ts` (comment routes), `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/share-comments.test.ts`

**Interfaces:**
- Consumes: Task 2 comment domain; Task 4 `resolveShare`, `readUnlockCookie`, `SHARE_RATES.guestComment|guestCommentLink`; Task 1 `GuestThreadRequest`, `GuestReplyRequest`, `GuestCreated`, `CommentBodyRequest`.
- Produces:

```ts
export const GUEST_EDIT_WINDOW_MS = 900_000;
export const GUEST_TOKEN_HEADER = 'x-pinwall-guest-token';
export type CommentActor = { kind: 'member'; user: UserRow }
  | { kind: 'guest'; shareLinkId: string; name: string | null; guestToken: string | null };   // name for writes, token for edits/deletes
export function issueGuestToken(deps: AppDeps, commentId: string, shareLinkId: string): Promise<string>;
  // newSecret(); oneTime.put(`guest-comment:${hashSecret(token)}`, { comment_id, share_link_id }, GUEST_EDIT_WINDOW_MS)
export function guestMayChange(deps: AppDeps, actor: Extract<CommentActor, { kind: 'guest' }>, c: CommentRow): Promise<boolean>;
  // the token maps to c.id and actor.shareLinkId, and now < c.created_at + GUEST_EDIT_WINDOW_MS
```

  Routes are on the public router. Each one first calls `resolveShare`: a locked link → 401 `password_required`; `allow_comments` false → 403 `t('share.commentsOff')`.

  | Route | Success |
  | --- | --- |
  | `GET /share/{token}/comments?status=&limit=&cursor=` | 200 `CommentThreadList`, `maxVersionNumber` = the shown version's number |
  | `POST /share/{token}/comments` | 201 `GuestCreated` (thread on the shown version) |
  | `POST /share/{token}/comments/{id}/replies` | 201 `GuestCreated` |
  | `PATCH /share/{token}/comments/{id}` (header `X-Pinwall-Guest-Token`) | 200 `Comment` |
  | `DELETE /share/{token}/comments/{id}` (header) | 204 |

  A comment id outside the link's artifact, or on a version the link does not show, → 404 `comment.notFound`.

- [ ] **Step 1: Write the failing tests** (`describe.each(dialects)`; link with `allow_comments: true` unless a test says otherwise; `guestPost(token, body)` POSTs `/api/v1/share/<token>/comments` with `apiInit(ctx, { method: 'POST', body })`, no cookie):

```ts
test('guests comment through a link that allows it', async () => {
  const r = await guestPost(token, { guest_name: ' Lan ', body: 'Đẹp quá', anchor: sampleAnchor() });
  expect(r.status).toBe(201);
  const b = await r.json();
  expect(b).toMatchObject({ thread: { author: { type: 'guest', name: 'Lan' }, version: { number: 1 }, status: 'open' },
    comment_id: b.thread.id, guest_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  // row: share_link_id link.id, author_user_id null, guest_name 'Lan'; a member's GET /api/v1/artifacts/:id/comments lists it
});
test('a link without comments refuses the comment routes', ...);   // GET and POST → 403 t('share.commentsOff')
test('a guest name is required', ...);   // missing, '   ' → 400
test('guests edit and delete their own comment for 15 minutes', ...);
  // PATCH with its token → 200, edited_at set; no token, another comment's token → 403 t('comment.guestWindow');
  // advance 900_001 → PATCH and DELETE with the right token → 403; a fresh comment's DELETE within the window → 204
test('guests cannot change member comments or resolve', ...);   // PATCH a member's thread with any token → 403; POST …/resolve under /share → 404
test('guest replies get their own token', ...);   // reply → 201, thread.replies[0].author guest, the reply's token edits the reply only
test('share viewers see threads up to the version the link shows', ...);
  // threads on v1 and v2; per-version link on v1 → list [v1 thread]; replying to the v2 thread through it → 404; follow-current link → both
test('a locked link needs the unlock cookie', ...);   // password + comments: no cookie → 401 password_required; after unlock → 200
test('guest writes are rate limited per IP and per link', ...);
  // 10 posts → the 11th 429; PINWALL_TRUST_PROXY=true with a new x-forwarded-for per request: 200 posts → the 201st 429
test('guest writes publish live events', ...);   // subscriber on ARTIFACT_TOPIC sees comment.created with thread.author.type 'guest'
test('cross-origin guest posts are refused', ...);   // origin https://evil.example → 403
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/share-comments`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Guest writes.** In the guest branch of `createThread` and `addReply`, store `guest_name`, `share_link_id` and `author_user_id null`. The route then calls `issueGuestToken`.
  - **Guest edits and deletes.** `editComment` and `deleteComment` decide with `guestMayChange`. A guest delete also deletes its store key.
  - **Rate limits.** `SHARE_RATES.guestComment` (key `${link.id}:${clientIp}`), then `SHARE_RATES.guestCommentLink` (key `link.id`), on both POST routes.
  - **en.json:**
    - `"share.commentsOff": "Comments are turned off for this share link."`
    - `"comment.guestWindow": "Guest comments can be changed only within 15 minutes, from the browser that wrote them."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): let share-link guests comment with a name, a 15-minute edit window and rate limits`.

### Task 6: Live updates over SSE (model: opus)

**Files:**
- Create: `apps/server/src/http/sse.ts`, `apps/server/src/api/events.ts`
- Modify: `apps/server/src/api/share-public.ts` (share stream), `apps/server/src/api/router.ts`. Touch `apps/server/src/domain/{versions.ts,deletion.ts}` only if the merged M4 code lacks a publish call named in the header.
- Test: `apps/server/test/api/events.test.ts`, plus `readSse` in `apps/server/test/helpers/review.ts`

**Interfaces:**
- Consumes: Task 1 `LiveEvent`; Task 4 `resolveShare`, `readUnlockCookie`; M4 `ARTIFACT_TOPIC`, `getArtifact`, `publishFiles`, `deleteVersion`, `deleteArtifact`; M2 `requireSession`, `authOf`, `hasAccess`, `deleteUserSessions`.
- Produces:

```ts
// http/sse.ts
export const SSE_HEARTBEAT_MS = 25_000;
export const SSE_MAX_BUFFERED_BYTES = 1_048_576;
export const SSE_HEADERS: Record<string, string>;   // the three headers of the Global Constraints
export type Forward = 'send' | 'skip' | 'send-and-close';
export interface LiveStreamOptions {
  topic: string;
  forward(e: LiveEvent): Forward;
  stillAllowed(): Promise<boolean>;   // at every heartbeat; false or a throw closes the stream
}
export function liveStream(c: Context<AppEnv>, o: LiveStreamOptions): Response;
// test/helpers/review.ts (adds)
export function readSse(res: Response): { next(): Promise<string>; done(): Promise<boolean>; cancel(): Promise<void> };   // decoded chunks
```

  Routes (both registered with `createRoute`, response `text/event-stream`, so they appear in OpenAPI):
  - `GET /api/v1/artifacts/{id}/events`, `requireSession` (EventSource sends cookies; tokens get 403). `forward`: `artifact.deleted` → `send-and-close`, else `send`. `stillAllowed`: the `sessions` row `auth.sessionId` exists with `expires_at > now` and the reloaded user passes `hasAccess`.
  - `GET /api/v1/share/{token}/events`: `resolveShare` first (locked → 401); the stream keeps `shown` = the shown version's number. `forward`: `version.published` → `send` and `shown = number` for a follow-current link, `skip` for a per-version link; `version.deleted` → `send` when the link follows current or `number === shown`; `artifact.deleted` → `send-and-close`; `comment.*` → `send` only when `allow_comments` and the thread's version number (`thread.version.number`, or `version_number` on deletes) is ≤ `shown`. `stillAllowed`: `resolveShare` with the cookie captured at connect succeeds and is not locked.

- [ ] **Step 1: Write the failing tests** (`describe.each(dialects)`; `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` in heartbeat tests only):

```ts
test('a stream starts with retry and carries the SSE headers', async () => {
  const r = await ctx.request(`/api/v1/artifacts/${id}/events`, apiInit(ctx, { cookie: m.cookie }));
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  expect(r.headers.get('cache-control')).toBe('no-cache, no-transform');
  expect(r.headers.get('x-accel-buffering')).toBe('no');
  expect(await readSse(r).next()).toBe('retry: 5000\n\n');
});
test('a heartbeat comment every 25 seconds', ...);   // advanceTimersByTimeAsync(25_000) → ': ping\n\n'
test('publishing a version reaches open streams', async () => {
  // publishFiles v2 with expected v1 →
  expect(await s.next()).toBe(`event: version.published\ndata: ${JSON.stringify({ type: 'version.published', artifact_id: id, version_id: v2.id, number: 2 })}\n\n`);
});
test('comment events reach open streams', ...);   // postThread → 'event: comment.created\n' + data whose thread.id is the new thread
test('version deletion is announced; artifact deletion ends the stream', ...);   // deleteVersion(1) → version.deleted { number: 1 }; deleteArtifact → artifact.deleted, then done() true
test('closing the request unsubscribes and stops the heartbeat', ...);
  // spy on deps.events.subscribe and wrap the returned unsubscribe; abort the request signal (and, separately, reader.cancel()) → unsubscribe called once; vi.getTimerCount() back to 0
test('member streams need a browser session and end with it', ...);
  // API token → 403 t('auth.sessionRequired'); no auth → 401; deleteUserSessions(m) then advance 25_000 → done() true; same after role_override 'blocked'
test('share streams follow the link', ...);
  // follow-current with comments: version.published and comment.created both arrive;
  // per-version link on v1: publishing v3 sends nothing, a thread on v2 sends nothing, a thread on v1 arrives; link without comments: no comment events
test('share streams end when the link is revoked or the unlock lapses', ...);   // revoke → after 25_000 done(); a password link opened with a cookie: advance past 24 h → done()
test('a locked share stream is refused', ...);   // 401 password_required
test('a consumer that stops reading is cut off', ...);   // never read; publish comment events totaling > 1 MiB → unsubscribe called, stream closed
test('events that fail LiveEvent are dropped', ...);   // deps.events.publish(topic, { type: 'version.published' }) → nothing sent, logger.warn called
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/events`. Expected: FAIL.
- [ ] **Step 3: Implement `liveStream`.**
  - **Stream.** A `ReadableStream<Uint8Array>` of UTF-8 chunks with `new ByteLengthQueuingStrategy({ highWaterMark: 65_536 })`, so `desiredSize` counts bytes; the first chunk is `retry: 5000\n\n`. Subscribe to `o.topic`; each bus event goes through `LiveEvent.safeParse` (failure → `logger.warn({ topic, type }, 'invalid live event dropped')`), then `o.forward`. Returned as `new Response(stream, { headers: SSE_HEADERS })`.
  - **Timer.** `setInterval(SSE_HEARTBEAT_MS)` writes `: ping\n\n`, then awaits `stillAllowed`.
  - **Close.** One idempotent `close()` (unsubscribe, clear the interval, close the controller), triggered by `send-and-close`, by `stillAllowed` saying no or throwing, by `c.req.raw.signal` aborting, by the stream being cancelled, and by `controller.desiredSize < -SSE_MAX_BUFFERED_BYTES` (the consumer stopped reading).
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): stream live version and comment events over SSE with heartbeats and access re-checks`.

### Task 7: Annotator anchoring and re-attachment (model: opus)

**Files:**
- Create: `packages/annotator/src/{css-path.ts,text-index.ts,geometry.ts,anchors.ts,reattach.ts,page.ts}`, `packages/annotator/test/helpers/{layout.ts,dom.ts}`
- Modify: `packages/annotator/package.json` (dependency `"@pinwall/shared": "workspace:*"`)
- Test: `packages/annotator/test/{css-path,anchors,reattach,page}.test.ts` (Vitest jsdom environment)

**Interfaces:**
- Consumes: Task 1 `Anchor`, `Quote`, `QUOTE_CONTEXT_CHARS`, `QUOTE_MAX_CHARS`, `DOM_PATH_MAX_CHARS`, `ANNOTATOR_PATH`.
- Produces:

```ts
// css-path.ts
export function cssEscape(ident: string): string;      // CSSOM "serialize an identifier" (jsdom has no CSS.escape)
export function cssPath(el: Element): string | null;  // null for html, body, or anything outside body
// text-index.ts
export interface TextIndex { text: string; toOffset(node: Node, offset: number): number; toRange(start: number, end: number): Range }
export function buildTextIndex(doc: Document): TextIndex;   // Text nodes under body in document order, skipping script, style, noscript, template
// geometry.ts
export interface DocPoint { x: number; y: number }    // document pixels
export function docSize(doc: Document): { width: number; height: number };   // documentElement scrollWidth/Height, each at least 1
export function toFraction(doc: Document, p: DocPoint): { x: number; y: number };   // clamped to 0..1, rounded to 4 decimals
export function fromFraction(doc: Document, f: { x: number; y: number }): DocPoint;
export function originOf(target: Range | Element): DocPoint | null;   // first client rect's top-left + window scroll; null without layout APIs
// anchors.ts
export interface AnchorContext { doc: Document; page: string }
export function textAnchor(ctx: AnchorContext, range: Range): Anchor | null;     // null when no text is left after trimming
export function elementAnchor(ctx: AnchorContext, el: Element): Anchor | null;   // null when cssPath is null
export function pointAnchor(ctx: AnchorContext, clientX: number, clientY: number): Anchor;
// reattach.ts
export type Placement = { found: true; via: 'quote'; range: Range } | { found: true; via: 'dom'; element: Element }
  | { found: boolean; via: 'position' };   // found true only for point anchors (their position is the anchor); text/element fallbacks are found: false
export function findQuote(text: string, q: Quote): { start: number; end: number } | null;
export function placeAnchor(doc: Document, index: TextIndex, a: Anchor): Placement;
// page.ts
export function grantBase(scriptSrc: string): string | null;   // the URL minus '__pinwall/annotator.js'; null if it does not end so
export function pageOf(href: string, base: string): string | null;
```

- [ ] **Step 1: Write the failing tests.** Helpers:
  - `stubLayout({ scrollWidth, scrollHeight, clientWidth, scrollY, rects })` (`helpers/layout.ts`) defines those properties on `documentElement` and `window`, and spies on `getBoundingClientRect`/`getClientRects` of the `Element` and `Range` prototypes.
  - `rangeOf(text)` (`helpers/dom.ts`) returns a `Range` over the first occurrence of `text` in `document.body`, and `anchorOf(over)` returns the Task 1 `text` sample anchor merged with `over`.

```ts
test('cssPath uses unique ids, and nth-of-type only where needed', () => {
  document.body.innerHTML = '<main><section><p>a</p><p>b</p></section><section id="price"><ul><li>x</li><li>y</li></ul></section></main>';
  expect(cssPath(document.querySelectorAll('p')[1]!)).toBe('body > main > section:nth-of-type(1) > p:nth-of-type(2)');
  expect(cssPath(document.querySelectorAll('li')[1]!)).toBe('#price > ul > li:nth-of-type(2)');
  expect(cssPath(document.body)).toBeNull();
});
test('duplicate and awkward ids', ...);   // two id="dup" → the id is not used; id '1a.b' → '#\\31 a\\.b' and querySelector finds it
test('every element round-trips through querySelector', ...);   // a 40-element fixture of mixed tags → querySelector(cssPath(el)) === el for each
test('elements inside svg anchor the svg', ...);   // elementAnchor(<path> in <svg id="logo">).dom.path === '#logo'
test('a text anchor keeps the exact quote with 32 characters of context', () => {
  document.body.innerHTML = `<p>${'x'.repeat(40)} Alpha beta gamma ${'y'.repeat(40)}</p>`;
  const a = textAnchor({ doc: document, page: 'docs/' }, rangeOf('beta gamma'));
  expect(a).toMatchObject({ kind: 'text', page: 'docs/', dom: { path: 'body > p' },
    quote: { exact: 'beta gamma', prefix: `${'x'.repeat(25)} Alpha `, suffix: ` ${'y'.repeat(31)}` } });
});
test('selections are trimmed, may span elements and are capped', ...);
  // ' beta ' → exact 'beta', prefix ending 'Alpha ', suffix starting ' gamma'; '<p>one <b>two</b> three</p>' from 'ne' to 'th' → 'ne two th';
  // whitespace only → null; a 3000-char selection → exact.length 2000
test('positions are fractions of the document and keep the viewport width', ...);
  // stubLayout({ scrollWidth: 1000, scrollHeight: 4000, clientWidth: 800, scrollY: 1000, rects: [[h2, { left: 100, top: 200 }]] }) →
  // elementAnchor(h2) { position: { x: 0.1, y: 0.3 }, viewport: { width: 800 } }; pointAnchor(500, 0) → { x: 0.5, y: 0.25 }, kind 'point', no quote/dom
// reattach.test.ts
test('re-attaches by exact quote', ...);   // { found: true, via: 'quote' }, range.toString() === exact
test('picks the occurrence whose context matches', () => {
  document.body.innerHTML = '<p>Price: 10 USD per month.</p><p>Total: 10 USD per year.</p>';
  const p = placeAnchor(document, buildTextIndex(document), anchorOf({ quote: { exact: '10 USD', prefix: 'Total: ', suffix: ' per year.' } }));
  expect(p.via === 'quote' && p.range.startContainer.parentElement === document.querySelectorAll('p')[1]).toBe(true);
});
test('falls back to whitespace-normalized matching', ...);   // stored 'beta gamma', page now 'beta\n      gamma' → via 'quote', range text 'beta\n      gamma'
test('falls back to the DOM path, then to the position', ...);   // quote gone, '#price > h2' present → via 'dom'; both gone → { found: false, via: 'position' }
test('an invalid stored selector never throws', ...);   // dom.path 'p:::' → via 'position'
test('element anchors try the DOM path; point anchors are placed by position', ...);
  // element anchor with its path present → via 'dom'; path gone → { found: false, via: 'position' }; point anchor → { found: true, via: 'position' }
// page.test.ts
test('pages are paths relative to the grant base', () => {
  const b = 'http://localhost:8080/c/tok/';
  expect([pageOf(b, b), pageOf(`${b}index.html?x=1#top`, b), pageOf(`${b}docs/`, b), pageOf(`${b}docs/index.html`, b)]).toEqual(['', '', 'docs/', 'docs/']);
  expect(pageOf(`${b}a%20b/T%C3%A0i.html`, b)).toBe('a b/Tài.html');
  expect(pageOf(`${b}${encodeURIComponent('Tài'.normalize('NFD'))}.html`, b)).toBe('Tài.html');
  expect(pageOf('http://localhost:8080/c/other/x.html', b)).toBeNull();
  expect(grantBase('https://tok.pw-content.test/__pinwall/annotator.js')).toBe('https://tok.pw-content.test/');
  expect(grantBase(`${b}__pinwall/annotator.js`)).toBe(b);
  expect(grantBase('http://localhost:8080/app.js')).toBeNull();
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/annotator test`. Expected: FAIL.
- [ ] **Step 3: Implement.** These rules are the algorithm.
  - **`cssPath`.** Walk up from the element (one inside an `<svg>` starts at that `svg`). An element whose id is unique in the document (`querySelectorAll('#' + cssEscape(id)).length === 1`) contributes `#<escaped id>` and ends the walk; any other contributes its `localName`, plus `:nth-of-type(k)` when its parent has more than one child of that name. Reaching `body` prepends `body`; join with ` > `; longer than `DOM_PATH_MAX_CHARS` → null.
  - **`textAnchor`.** Map the range ends through `toOffset` (an element boundary maps to the first text at or after it). Move `start` past leading and `end` back over trailing whitespace (nothing left → null), then `end = min(end, start + QUOTE_MAX_CHARS)`. `prefix` = the 32 characters before `start`, `suffix` = the 32 after `end`. `dom` = `cssPath` of the element holding the common ancestor, left out when null; the position from `originOf(range)`.
  - **`findQuote`.** Collect the indexes where `exact` occurs, at most 1000. Score each by the common suffix of the preceding text with `prefix`, plus the common prefix of the following text with `suffix`. The highest score wins and ties go to the first. With no hit, collapse every `\s+` run to one space in the text (keeping an offset map back to the original), in `exact` (also trimmed), and in `prefix`/`suffix`. Search again and map the result back.
  - **`placeAnchor`.** Try `quote` → `toRange`. Then `dom` → `querySelector` in a try/catch; the element must be inside body. Then the position, which counts as found only for point anchors. Element and point anchors skip the steps they have no selector for.
  - **`pageOf`.** Drop the query and fragment, and require the href to start with `base`. Percent-decode each remaining segment, keeping a segment that fails to decode as it is. NFC-normalize, then drop a final `index.html` segment (`docs/index.html` → `docs/`, `index.html` → `''`).
- [ ] **Step 4: Run** `pnpm --filter @pinwall/annotator test && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(annotator): create text, element and point anchors and re-attach them by quote, DOM path or position`.

### Task 8: Annotator runtime — messaging, comment mode, Shadow DOM pins, bundle (model: opus)

**Files:**
- Create: `packages/annotator/src/{boot.ts,messaging.ts,overlay.ts,guard.ts}`, `packages/annotator/{bundle.mjs,bundle.d.mts,build.mjs}` (`bundle.d.mts` declares `bundleAnnotator` for TypeScript callers)
- Modify: `packages/annotator/src/index.ts` (entry), `packages/annotator/package.json` (`scripts.build: "node build.mjs"`; `exports: { "./bundle": "./bundle.mjs", "./dist/annotator.js": "./dist/annotator.js" }`)
- Test: `packages/annotator/test/{runtime,overlay,bundle}.test.ts`

**Interfaces:**
- Consumes: Task 7 modules; Task 1 `parseViewerMessage`, `PageToViewerMessage`, `ANNOTATOR_GLOBAL`, `PROTOCOL_VERSION`.
- Produces:

```ts
// guard.ts
export function guard<A extends unknown[]>(fn: (...a: A) => unknown): (...a: A) => void;   // runs fn, swallows sync throws and rejections
// messaging.ts
export function postToViewer(top: Window, msg: PageToViewerMessage): void;   // drops messages that fail the schema; top.postMessage(msg, '*')
export function onViewerMessage(win: Window, top: Window, handler: (m: ViewerToPageMessage) => void): () => void;   // event.source === top and parseViewerMessage
// overlay.ts
export interface PinSpec { id: string; number: number; resolved: boolean; anchor: Anchor; placement: Placement }
export interface Overlay { readonly host: HTMLElement; setPins(pins: PinSpec[]): void; layout(): void; hover(el: Element | null): void;
  focus(id: string): boolean; destroy(): void }
export function createOverlay(doc: Document, onPinClick: (id: string) => void): Overlay;
// boot.ts
export interface BootOptions { scriptSrc: string | null; top?: Window | null }
export interface Annotator { readonly page: string; readonly frameId: string; destroy(): void }
export function boot(win: Window, opts: BootOptions): Annotator | null;   // null when already booted or outside a grant
// index.ts — the bundle entry
//   guard(() => boot(window, { scriptSrc: document.currentScript?.src || document.querySelector('script[data-pinwall-annotator]')?.src || null }))()
// bundle.mjs
export function bundleAnnotator(o?: { minify?: boolean }): Promise<string>;   // esbuild: src/index.ts, bundle, format 'iife', platform 'browser', target 'es2020', legalComments 'none', minify default true, write false
```

- [ ] **Step 1: Write the failing tests.**
  - **Setup.** `history.replaceState(null, '', '/c/tok/docs/')`, then `boot(window, { scriptSrc: 'http://localhost:3000/c/tok/__pinwall/annotator.js', top: window })`. Outgoing messages are captured by `vi.spyOn(window, 'postMessage').mockImplementation(…)`.
  - **Helpers.** `send(msg)` dispatches `new MessageEvent('message', { data: msg, source: window })`. `sent(type)` filters the captured messages.

```ts
test('boots once, adds one global and patches no prototype', () => {
  const before = new Set(Object.getOwnPropertyNames(window));
  const protos = [EventTarget, Node, Element, HTMLElement, Document, Range, Selection, History, Window].map((C) => Object.getOwnPropertyNames(C.prototype).join());
  const a = boot(window, opts);
  expect(Object.getOwnPropertyNames(window).filter((k) => !before.has(k))).toEqual(['__pinwallAnnotator']);
  expect([EventTarget, Node, Element, HTMLElement, Document, Range, Selection, History, Window].map((C) => Object.getOwnPropertyNames(C.prototype).join())).toEqual(protos);
  expect(boot(window, opts)).toBeNull();
  a?.destroy();
});
test('posts ready with its page and a frame id', ...);   // sent('ready') → [{ pinwall: 1, type: 'ready', page: 'docs/', frameId: /^[0-9a-f]{16}$/ }]
test('does nothing outside a grant', ...);   // scriptSrc 'http://localhost:3000/app.js' → null, nothing posted
test('ignores messages not from window.top and invalid messages', ...);   // source: an iframe's contentWindow, or data { type: 'set-mode' } → mode unchanged
test('comment mode: a selection posts a text anchor and swallows the click', ...);
  // set-mode comment; select 'beta gamma'; dispatch mouseup then click → one anchor-picked { anchor: { kind: 'text', page: 'docs/' }, frameId }, click.defaultPrevented true
test('comment mode swallows clicks before page handlers', ...);   // Review Focus 5
  // <a href="#x" id="l">; the page adds (after boot, before set-mode comment) a window capture listener and an element listener calling stopPropagation →
  // neither runs; defaultPrevented; anchor-picked kind 'element' with dom.path '#l'
test('comment mode: alt-click, clicks on body and clicks on page-sized boxes are point anchors', ...);
  // altKey on an element → 'point'; click target body → 'point'; a wrapper whose stubbed rect covers ≥ 80% of the viewport → 'point'
test('browse mode leaves clicks alone', ...);   // set-mode browse → page handler runs, no anchor-picked
test('show-anchors keeps this page only, draws numbered pins and reports found', ...);
  // anchors c1 (page 'docs/', found), c2 (page 'docs/', quote and dom gone), c3 (page 'other.html') →
  // sent('anchors-placed') → [{ results: [{ id: 'c1', found: true }, { id: 'c2', found: false }], frameId }];
  // overlay.host.shadowRoot.querySelectorAll('[data-pin-id]') → ids ['c1', 'c2'], text ['1', '2']; resolved anchors have data-resolved
test('pins never touch the page DOM', ...);   // body.innerHTML unchanged; host.parentNode === document.documentElement; host.style.getPropertyPriority('position') === 'important'
test('page CSS cannot reach the overlay', ...);   // Review Focus 5: page <style>* { display: none !important }</style>; pins live in host.shadowRoot; host inline display 'block' !important
test('pins come back after the page rewrites its DOM', ...);   // Review Focus 5: document.documentElement.innerHTML = '<body><p>Alpha beta gamma</p></body>'; dispatch resize → host.isConnected
test('clicking a pin posts pin-clicked', ...);   // click a shadow pin → { type: 'pin-clicked', id: 'c1' }, in browse and in comment mode
test('focus-anchor scrolls to the anchor', ...);   // stub Element.prototype.scrollIntoView → called for c1; unknown id → nothing
test('unfound anchors are retried after load', ...);   // quote absent; append the text; dispatch load → a second anchors-placed with c2 found: true
test('a same-document navigation posts navigated and re-applies anchors', ...);   // pushState to /c/tok/b.html + popstate → { type: 'navigated', page: 'b.html' }, anchors-placed for 'b.html'
test('errors inside handlers never escape', ...);   // stub buildTextIndex to throw during show-anchors → no exception, window 'error' listener not called
// bundle.test.ts
test('the bundle is one IIFE under 100 kB that boots in a fresh window', async () => {
  const code = await bundleAnnotator();
  expect(code).not.toMatch(/^\s*(import|export)\b/m);
  expect(Buffer.byteLength(code)).toBeLessThan(100_000);
  const dom = new JSDOM('<!doctype html><html><head><script data-pinwall-annotator src="http://localhost:8080/c/tok/__pinwall/annotator.js"></script></head><body><p>x</p></body></html>',
    { url: 'http://localhost:8080/c/tok/', runScripts: 'outside-only' });
  const before = new Set(Object.getOwnPropertyNames(dom.window));
  dom.window.eval(code);
  expect(Object.getOwnPropertyNames(dom.window).filter((k) => !before.has(k))).toEqual(['__pinwallAnnotator']);
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/annotator test`. Expected: FAIL.
- [ ] **Step 3: Implement.** These rules decide what the tests leave open.
  - **Boot**, synchronously while the script runs (the tag precedes every page script, so these listeners come first):
    - `grantBase(scriptSrc)` and `pageOf(location.href)` must both resolve.
    - Define `window.__pinwallAnnotator` = frozen `{ protocol: PROTOCOL_VERSION, frameId }` with `Object.defineProperty` (non-enumerable, configurable, so `destroy()` can remove it along with every listener and the overlay); `frameId` = 16 hex chars from `crypto.getRandomValues`.
    - Register the message listener and the capture-phase `mouseup`/`click`/`mousemove` listeners on `window` now; the latter do nothing in browse mode.
    - Queue messages until the DOM is ready (DOMContentLoaded, or at once when `readyState !== 'loading'`); then create the overlay and post `ready`.
  - **Comment mode:** `mouseup` with a non-collapsed selection holding text → `textAnchor` → post `anchor-picked`, set `swallowClick`, clear it with `setTimeout(0)`. `click` on the overlay host is left alone; every other click gets `preventDefault()` + `stopImmediatePropagation()`, then stops if `swallowClick` is set, else becomes a point anchor (`altKey`, target `html`/`body`, target rect ≥ 80% of the viewport, or `elementAnchor` null) or an element anchor. `mousemove` (passive) feeds `overlay.hover`.
  - **`show-anchors`:** remember the list; place the anchors whose `page` is the current page against one `TextIndex`; `setPins`; post `anchors-placed` (empty `results` when none match). Unfound anchors are re-placed on `load` (if it has not fired) and once more 2000 ms after the message; post again only when a result changed.
  - **`navigated`:** on `popstate` and a 1000 ms check, a changed `pageOf(location.href)` posts `navigated` and re-applies the remembered list.
  - **Overlay host:** `<pinwall-overlay>` appended to `document.documentElement`, open shadow root, inline styles all `!important`: `all: initial; display: block; position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; z-index: 2147483647; pointer-events: none`; re-appended when disconnected.
  - **Pins** (`createElement`/`textContent` only): `<button type="button" tabindex="-1" data-pin-id aria-label="Comment N">`, `pointer-events: auto`, `data-resolved` when resolved, centred 12 px above-left of the origin — the range's first rect (plus highlight boxes over its client rects), the element's rect (plus an outline), or `fromFraction(position)` — in document coordinates minus the host's own document origin.
  - **Layout** re-runs, throttled by `requestAnimationFrame` (else `setTimeout(50)`), on `resize`, `load`, capture-phase `scroll`, and a `ResizeObserver` on `documentElement` when available. **`focus`** calls `scrollIntoView({ block: 'center', behavior: 'smooth' })` on the placed element (a range's start element) or `scrollTo` the position, and sets `data-focus` on the pin for 1500 ms.
  - **Errors:** every listener, timer and message handler goes through `guard`. `build.mjs` writes `dist/annotator.js` from `bundleAnnotator()`.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/annotator test && pnpm --filter @pinwall/annotator build && pnpm lint`. Expected: PASS; `packages/annotator/dist/annotator.js` exists.
- [ ] **Step 5: Commit** `feat(annotator): add comment mode, Shadow DOM pins, viewer messaging and the IIFE bundle`.

### Task 9: Annotator injection into review HTML and asset serving (model: opus)

**Files:**
- Create: `apps/server/src/content/{annotator-inject.ts,annotator-asset.ts}`, `apps/server/test/helpers/annotator-build.ts`, `apps/server/test/global-setup.ts`
- Modify:
  - `apps/server/src/content/hooks.ts`: `contentHooks.transformReviewHtml = injectAnnotator` and `contentHooks.reservedAssets['annotator.js']`.
  - `apps/server/vitest.config.ts`: `globalSetup: ['test/global-setup.ts']`.
  - `apps/server/build.mjs`: `define: { __PINWALL_ANNOTATOR_JS__: JSON.stringify(await bundleAnnotator()) }`.
  - `apps/server/package.json`: devDependency `"@pinwall/annotator": "workspace:*"`.
- Test: `apps/server/test/content/{annotator-inject,review-serving}.test.ts`

**Interfaces:**
- Consumes: M4 `HtmlTransform`, `ContentHooks`, `ReservedAsset`, `createGrant`, `contentBaseUrl`, `fetchContent`, `publishFiles`, `CONTENT_ENV`; Task 8 `bundleAnnotator`; Task 4 `/s/:token`.
- Produces:

```ts
// content/annotator-inject.ts
export function annotatorTag(baseUrl: string): string;   // `<script src="${baseUrl}__pinwall/annotator.js" data-pinwall-annotator></script>`
export function injectionOffset(html: Buffer): number | null;   // null: leave the document unchanged
export const injectAnnotator: HtmlTransform;   // splices annotatorTag(ctx.baseUrl) at injectionOffset; null → the input buffer as it is
// content/annotator-asset.ts
declare const __PINWALL_ANNOTATOR_JS__: string | undefined;   // set by build.mjs in the server bundle
export function annotatorScript(): Buffer;   // memoized; the define, else packages/annotator/dist/annotator.js via createRequire(import.meta.url).resolve('@pinwall/annotator/dist/annotator.js');
                                              // missing → Error naming `pnpm --filter @pinwall/annotator build`
export const annotatorAsset: ReservedAsset;  // { contentType: 'text/javascript; charset=utf-8', body: annotatorScript }
// test/helpers/annotator-build.ts
export function ensureAnnotatorBuilt(): Promise<void>;   // bundleAnnotator() → packages/annotator/dist/annotator.js (global setup and the Task 10 fixture call it)
```

- [ ] **Step 1: Write the failing tests.** In the table, `T` = `annotatorTag('http://localhost:8080/c/tok/')`; `inject(s)` runs `injectAnnotator(Buffer.from(s, 'latin1'), ctx)` and returns latin1.

```ts
test.each([
  ['head', '<!doctype html><html><head><title>x</title>', `<!doctype html><html><head>${T}<title>x</title>`],
  ['capitals and attributes', '<!DOCTYPE html><HTML lang="vi"><HEAD data-x="1"><TITLE>x', `<!DOCTYPE html><HTML lang="vi"><HEAD data-x="1">${T}<TITLE>x`],
  ['the last CSP meta of the head', `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="img-src *"><meta http-equiv="content-security-policy" content="script-src 'none'"><title>`,
    `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="img-src *"><meta http-equiv="content-security-policy" content="script-src 'none'">${T}<title>`],
  ['a CSP meta without a head tag', `<!doctype html><meta http-equiv="Content-Security-Policy" content="x"><p>y`, `<!doctype html><meta http-equiv="Content-Security-Policy" content="x">${T}<p>y`],
  ['no head: after <html>', '<!doctype html><html><body>x', `<!doctype html><html>${T}<body>x`],
  ['no html: after the doctype', '<!doctype html><title>x</title><p>y', `<!doctype html>${T}<title>x</title><p>y`],
  ['a fragment', '<p>x</p>', `${T}<p>x</p>`],
  ['a UTF-8 BOM', '\xef\xbb\xbf<p>x', `\xef\xbb\xbf${T}<p>x`],
  ['head in a comment', '<!-- <head> --><!doctype html><html><head><title>', `<!-- <head> --><!doctype html><html><head>${T}<title>`],
  ['header is not head', '<html><header>x', `<html>${T}<header>x`],
  ['a meta inside a script', `<head><script>document.write('<meta http-equiv="content-security-policy" content="x">')</script></head>`,
    `<head>${T}<script>document.write('<meta http-equiv="content-security-policy" content="x">')</script></head>`],
  ['a CSP meta in the body is ignored', `<head></head><body><meta http-equiv="Content-Security-Policy" content="x">`, `<head>${T}</head><body><meta http-equiv="Content-Security-Policy" content="x">`],
])('injects %s', async (_n, input, expected) => expect(await inject(input)).toBe(expected));   // Review Focus 1 and 4
test('bytes outside the insertion are untouched', ...);   // windows-1252 bytes 0xE9 0x96 and CRLF around <head> → output = input[0..k] + T + input[k..], compared as Buffers
test('UTF-16 documents are left unchanged', ...);   // a buffer starting FF FE or FE FF → the same buffer
test('the tag uses the grant base in each mode', ...);   // ctx.baseUrl 'https://<tok>.pw-content.test/' → src 'https://<tok>.pw-content.test/__pinwall/annotator.js'
// review-serving.test.ts — describe.each([['single-domain', {}], ['content-domain', CONTENT_ENV]])
test('review HTML carries the tag in every page and frame; raw HTML never does', ...);
  // publishFiles({ 'index.html': '<!doctype html><html><head></head><body><iframe src="docs/inner.html"></iframe>', 'docs/inner.html': …, 'a.css', 'notes.md': '# Hi' });
  // review grant: index.html, docs/inner.html and notes.md (rendered) each contain annotatorTag(contentBaseUrl(config, token)) exactly once; a.css unchanged;
  // raw grant: index.html Buffer.equals(stored)
test('the annotator script is served from __pinwall with content headers', ...);
  // review and raw grants: '__pinwall/annotator.js' → 200, 'text/javascript; charset=utf-8', cache-control 'private, max-age=300, no-transform',
  // nosniff, sandbox CSP in single-domain mode only, body equals annotatorScript()
test('share links without comments stay byte-for-byte', ...);   // acceptance 8: /s/<token> → follow → body equals stored, no 'data-pinwall-annotator'
test('a share viewer review grant is injected', ...);   // ShareInfo.content.url (allow_comments) → index.html contains the tag
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/content/annotator-inject test/content/review-serving`. Expected: FAIL.
- [ ] **Step 3: Implement `injectionOffset`.**
  1. An `FF FE` or `FE FF` start → null.
  2. Decode as `latin1` (character offsets = byte offsets) and run an htmlparser2 `Parser` (`lowerCaseTags`, `lowerCaseAttributeNames`), recording `parser.endIndex + 1` for the doctype (`onprocessinginstruction` `!doctype`), the `html` and `head` open tags, and each `meta` whose `http-equiv` is `content-security-policy` (case-insensitive).
  3. Stop recording at `</head>`, a `body` open tag, or any open tag outside `html head meta title link style script base noscript template`.
  4. The offset is the largest recorded value, else 3 after a UTF-8 BOM (`EF BB BF`), else 0.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test && pnpm --filter @pinwall/server build && grep -c __pinwallAnnotator apps/server/dist/main.mjs`. Expected: PASS, and a count ≥ 1 (the annotator is embedded through the define, so the bundle never reads `packages/annotator/dist`).
- [ ] **Step 5: Commit** `feat(server): inject the annotator into review HTML after any page CSP and serve its script per grant`.

### Task 10: Nested-frame Playwright smoke and the review flow (model: sonnet)

**Files:**
- Create: `apps/server/e2e/annotator/{playwright.config.ts,fixture-server.ts,viewer.html,nested-frame.spec.ts}`, `apps/server/test/api/review-flow.test.ts`
- Modify: `apps/server/package.json` (script `"test:e2e:annotator": "playwright test -c e2e/annotator/playwright.config.ts"`). If `pnpm --filter @pinwall/server exec playwright --version` fails, also add `@playwright/test` with the root's range as a devDependency.

**Interfaces:**
- Consumes: M1 `loadConfig`, `createDeps`, `buildApp`, `@hono/node-server` `serve`; M4 `ingestFiles`, `createGrant`, `contentUrl`; Task 9 `ensureAnnotatorBuilt`; Task 1 protocol messages; everything above for the flow test.
- Produces:
  - **`fixture-server.ts`:** `ensureAnnotatorBuilt()`, then Pinwall on `http://127.0.0.1:18471` (`PINWALL_PUBLIC_ORIGIN=http://127.0.0.1:18471`, single-domain, temp data dir); inserts an owner row and publishes with `ingestFiles`: `index.html` = `<h1>Outer page</h1><iframe id="inner" src="inner.html" width="600" height="220"></iframe><iframe id="locked" src="locked.html" width="600" height="120"></iframe>`; `inner.html` = `<p style="font:20px/1.5 sans-serif;margin:40px">The nested frame says <span id="target">hello to Pinwall</span> today.</p>`; `locked.html` = a head with `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`. It makes a review grant and serves `viewer.html` on `http://127.0.0.1:18472/` (content URL substituted for `__CONTENT_URL__`) plus `GET /healthz` → 200.
  - **`viewer.html`:** `<iframe id="content" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation">`; `window.__pinwallTest = { received: [], broadcast(msg) }`, where `received` keeps messages whose `event.source` is the iframe's window or a descendant, and `broadcast` posts to that window and recursively to every `frames[i]`.
  - **Config:** `webServer: { command: 'pnpm exec tsx e2e/annotator/fixture-server.ts', cwd: resolve(import.meta.dirname, '../..'), url: 'http://127.0.0.1:18472/healthz', timeout: 60_000 }`, Chromium only, headless.

- [ ] **Step 1: Write the Playwright test** `nested-frame.spec.ts`:

```ts
test('pins a comment on text inside a nested frame', async ({ page }) => {
  await page.goto('http://127.0.0.1:18472/');
  const received = () => page.evaluate(() => (window as any).__pinwallTest.received);
  await expect.poll(async () => (await received()).filter((m: any) => m.type === 'ready').length).toBe(2);
  await page.waitForTimeout(1000);
  const readies = (await received()).filter((m: any) => m.type === 'ready');
  expect(readies.map((m: any) => m.page).sort()).toEqual(['', 'inner.html']);   // a frame whose CSP blocks the annotator sends no ready
  const innerId = readies.find((m: any) => m.page === 'inner.html').frameId;
  const broadcast = (msg: object) => page.evaluate((m) => (window as any).__pinwallTest.broadcast(m), msg);
  await broadcast({ pinwall: 1, type: 'set-mode', mode: 'comment' });
  const inner = page.frameLocator('#content').frameLocator('#inner');
  const box = (await inner.locator('#target').boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await received()).filter((m: any) => m.type === 'anchor-picked').length).toBe(1);
  const picked = (await received()).find((m: any) => m.type === 'anchor-picked');
  expect(picked).toMatchObject({ frameId: innerId, anchor: { kind: 'text', page: 'inner.html', dom: { path: '#target' },
    quote: { exact: 'hello to Pinwall' } } });
  expect(picked.anchor.quote.prefix.endsWith('The nested frame says ')).toBe(true);
  expect(picked.anchor.quote.suffix.startsWith(' today.')).toBe(true);
  await broadcast({ pinwall: 1, type: 'set-mode', mode: 'browse' });
  await broadcast({ pinwall: 1, type: 'show-anchors', anchors: [{ id: 'c1', number: 1, resolved: false, anchor: picked.anchor }] });
  await expect.poll(async () => (await received()).filter((m: any) => m.type === 'anchors-placed').map((m: any) => [m.frameId === innerId, m.results]))
    .toContainEqual([true, [{ id: 'c1', found: true }]]);
  const pin = inner.locator('pinwall-overlay [data-pin-id="c1"]');
  await expect(pin).toHaveText('1');
  expect(await inner.locator('#target').boundingBox()).toEqual(box);   // pins never shift layout
  await pin.click();
  await expect.poll(async () => (await received()).some((m: any) => m.type === 'pin-clicked' && m.id === 'c1')).toBe(true);
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test:e2e:annotator`. Expected: FAIL only until the fixture files exist. The annotator itself already works from Tasks 8–9.
- [ ] **Step 3: Write `fixture-server.ts` and `viewer.html`.** Then run again. Expected: `1 passed`.
- [ ] **Step 4: Write `review-flow.test.ts`.** It runs in `describe.each(dialects)` with `PINWALL_WEB_DIR` set, on one context, and walks the M5 "done when":
  1. `setupOwner`. A member publishes v1, an `index.html` that frames `docs/inner.html`.
  2. The member opens `/api/v1/artifacts/{id}/events`. A review preview of v1 serves the tag in both files.
  3. The member writes a text-anchored thread on v1. The stream gets `comment.created`.
  4. v2 is published with `expected_version_id`. The stream gets `version.published` with number 2.
  5. `POST /comments/{id}/resolve {}` → `resolved_in_version.number === 2`, and the stream gets `comment.resolved`. This is the server side of acceptance 4.
  6. A link with a password and comments: unlock, then a guest comment → its share stream gets `comment.created`.
  7. A link without comments: `/s/<token>` → raw bytes equal the stored bytes (acceptance 8). Revoke → `/s/<token>` 410.
  8. `GET /api/v1/openapi.json` lists every M5 path:
     - members: `/artifacts/{id}/comments`, `/comments/{id}`, `/comments/{id}/replies`, `/comments/{id}/resolve`, `/comments/{id}/reopen`, `/artifacts/{id}/share-links`, `/share-links/{id}`, `/artifacts/{id}/events`;
     - share viewers: `/share/{token}`, `/share/{token}/unlock`, `/share/{token}/comments`, `/share/{token}/comments/{id}`, `/share/{token}/comments/{id}/replies`, `/share/{token}/events`.
- [ ] **Step 5: Run** `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm test:integration`, then `pnpm --filter @pinwall/server test:e2e:annotator`. Expected: all pass, with the Postgres suites run, not skipped.
- [ ] **Step 6: Commit** `test: add the nested-frame annotator smoke test and the M5 review flow`.

---

## M5 done when

- `pnpm lint && pnpm typecheck && pnpm test` pass, and `pnpm test:integration` passes with the M5 suites run on both SQLite and Postgres.
- The jsdom annotator suites pass (`pnpm --filter @pinwall/annotator test`).
- `pnpm --filter @pinwall/server test:e2e:annotator` passes: a comment is pinned on text inside a nested frame, and the CSP-blocked frame sends no `ready`.
- `review-flow.test.ts` passes. It covers the server side of acceptance 4 (a thread on v1, then resolve gives "resolved in v2" and live events) and acceptance 8 (share links are byte-for-byte).
- Every Review Focus test passes.
