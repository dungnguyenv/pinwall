# Pinwall M8a — Web App: Review Viewer, Comments, Live Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The screen people use most. It shows the artifact in a sandboxed frame with pinned comments and follows new versions live. M8a (Tasks 1–7) builds:
- the review viewer, layout A: a slim top bar, the page, a dockable comment panel, full screen, and the sidebar collapsed to its rail;
- comment threads pinned through the annotator, with a point overlay when a page blocks the annotator;
- live updates over SSE, switching versions or offering to;
- version actions: raw and review links, restore, and deletion with the backup warning.

M8b (Tasks 8–11) adds the share dialog, the `/s/:token` share viewer, compare, and the Playwright proof of spec acceptance 4 (browser part) and 5 in both isolation modes.

**Architecture:** All code lives in `apps/web/src/review/`, split by responsibility:
- `frame/`: the sandboxed content frame, the `postMessage` bridge to the annotator, device sizing and the point overlay.
- `comments/`: the thread cache, member and guest backends, the panel, cards and composer.
- `live/`: the SSE stream and the version-following rule.
- `viewer/`: the review page.
- `share/` and `compare/`.

Pages reuse M7a's primitives, API client, shell and test harness. M8 adds no server routes. Its one change outside `apps/web` and `e2e` is additive: three optional protocol fields for the annotator (Task 1). They give the composer a screen position and give compare its scroll sync.

**Tech Stack:** React 19, React Router 8, TanStack Query 5, Tailwind CSS v4 tokens, `radix-ui` 1.x, sonner, lucide-react, zod 4, `diff` (BSD-3-Clause, word-level highlights only); Vitest 5, Testing Library, user-event, MSW 3; Playwright 1.65 (Chromium).

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md`, §3.6–3.9, §4, and acceptance 4 and 5. The approved mockups are `docs/superpowers/specs/mockups/review-layout.html` (option **A**) and the right-hand panel of `app-shell.html`. Their Vietnamese labels are mockup text only; the product UI is English.

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`. Its Routes table, Security model (Review frame, Annotator, Share links) and Annotator ↔ viewer protocol apply. This plan's commit already edits three things there: the protocol block (Task 1's additions), the Review frame line (the `allow` and `referrerpolicy` attributes and the one `srcdoc` exception), and M8's row in the Milestones table (the m8a/m8b split). Implementers do not edit the roadmap.

**Depends on** M4b, M5, M7a and M7b. Read their Interfaces blocks. Where merged code differs in a name or signature, the code wins: change the import and keep the behavior.
- **M7a:**
  - UI: every `ui/` primitive and `cn`.
  - Client: `api` (Task 2 adds `headers` to `RequestOptions`), `ApiError`, `isApiError`, `errorMessage`, `qk`, `notifyUnauthorized`.
  - Session and navigation: `useMe`, `browser`, `useGoTo`, `signInPath`.
  - Helpers: `formatRelativeTime`, `formatDate`, `formatBytes`, `usePageTitle`, `PHONE_QUERY`, `useMediaQuery`, `readPref`/`writePref`/`usePref`.
  - Routing, shell and library: `buildRoutes`, `RequireAuth`, `AppShell` (rail forced on `/a/*`), `useArtifact`, `useProject`, `LibraryArtifact`.
  - Test harness: `server`, `API`, `apiError`, `renderRoute`, `setViewport`, `fx` (`fx.me`, `fx.project`, `fx.artifact`, `fx.version`, `fx.page`).
- **M7b:** `e2e/support/pinwall-server.ts` (`startPinwall`, `RunningPinwall`).
- **M4b:**
  - DTOs: `VersionSummary`, `VersionList`, `ContentGrant`, `RestoreRequest`, `VersionDiff`, `TextFileDiff`, `MarkdownDiff`, `FileChange`, `PublishResult`.
  - Routes: `GET /artifacts/{id}/versions`, `…/versions/{n}/preview?mode=`, `POST …/versions/{n}/restore`, `DELETE /artifacts/{id}`, `DELETE /artifacts/{id}/versions/{n}`, `GET /artifacts/{id}/diff`, `…/diff/file`, `…/diff/markdown`, and the raw links `/a/:id/raw`, `/a/:id/v/:n/raw`.
  - Field: `ArtifactSummary.created_by` (the publisher's user id or null).
- **M5:**
  - Protocol (`@pinwall/shared/protocol`): `Anchor`, `parsePageMessage`, `PageToViewerMessage`, `ViewerToPageMessage`, `MAX_ANCHORS`.
  - Comment DTOs: `CommentThread`, `Comment`, `CommentThreadList`, `CreateThreadRequest`, `GuestThreadRequest`, `GuestReplyRequest`, `GuestCreated`.
  - Share DTOs: `ShareLink`, `ShareLinkList`, `CreateShareLinkRequest`, `CreatedShareLink`, `ShareInfo`, `SHARE_PASSWORD_MIN_LENGTH`.
  - Events: `LiveEvent`, `LIVE_EVENT_TYPES`.
  - Routes: every member and share-viewer route in M5's "Interface handed to M6 and M8".
  - Annotator: `boot`, `BootOptions`, `postToViewer`, `onViewerMessage`, `guard`, the M5 runtime test helpers (`stubLayout`, `send`, `sent`).
  - Server copy: the keys `share.passwordTooShort`, `share.notFound.title`, `share.gone.title`, `share.expired.title`.

**Split:** M8 is two plans that share one task numbering:
- this one, Tasks 1–7: the protocol additions, the data layer, the live stream, the frame bridge, comments, the review page and version actions;
- `2026-11-10-pinwall-m8b-web-share-compare.md`, Tasks 8–11: the share dialog, the share viewer, compare, and the end-to-end acceptance tests.

M8b starts once Tasks 1–7 are committed, and it consumes the interface listed below. The Global Constraints and Review Focus here cover all of M8.

**Worktree:** M8 runs in parallel with M6. Touch only these:
- `apps/web/**` and `e2e/**`;
- `packages/shared/src/protocol.ts` and `packages/shared/test/protocol.test.ts`;
- `packages/annotator/src/**` and `packages/annotator/test/**`;
- the `web.*` block of `packages/shared/src/i18n/en.json`;
- the root `package.json` scripts and `pnpm-lock.yaml`.

## Global Constraints

The roadmap's Global Constraints apply, and M7a's Global Constraints and Design tokens apply verbatim: copy them into every implementer brief. Those rules cover polish, focus rings, accessible names, loading/empty/error states with Retry, WCAG 2.1 AA, 360 px without sideways scroll, tokens only, the app CSP, `t()` for every string, server messages shown verbatim, and storage only through `lib/storage.ts`. M8 adds:
- **Visual work.** The implementers of Tasks 5, 6, 8, 9 and 10 load the `frontend-design:frontend-design` skill first.
- **Original work.** Learn the *feel* of focused preview-and-comment tools (Figma's comment mode, Vercel's preview comments) and of Claude/ChatGPT: quiet chrome, the page first, one accent. Never copy their markup, CSS, icons or copy. Plannotator's viewer is explicitly not a reference.
- **Review frame, verbatim:**

  ```html
  <iframe sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation"
          allow="fullscreen; autoplay; picture-in-picture; clipboard-write" referrerpolicy="no-referrer" src="<ContentGrant.url>">
  ```

  - This frame is used by the review viewer, the share viewer and both compare visual views.
  - Never `srcdoc`, never `allow-same-origin`, never `allow-top-navigation*`. Camera, microphone and location are never delegated.
  - The rendered Markdown diff is the only `srcdoc` frame. Its attribute is exactly `sandbox=""` (no permissions).
- **Messages.**
  - A message is accepted only when `isWithinFrame(event.source, iframe.contentWindow)` and `parsePageMessage(event.data)` passes.
  - Messages are posted with target origin `'*'`, because content origins are opaque.
  - A message carries only ids, pin numbers, resolved flags, anchors, modes and scroll fractions. Never comment bodies, author or guest names, or guest tokens.
  - Frame messages change view state only. They never send a request, write the cache or navigate the app.
- **Live updates.** `new EventSource(path)` on the same origin. Listen to each `LIVE_EVENT_TYPES` name (named events, not `onmessage`), and parse every event with `LiveEvent`.
- **Untrusted text.** Artifact names, comment bodies, guest names, quotes, file paths and diff lines render as React text. `dangerouslySetInnerHTML` appears nowhere in M8; Task 11 greps for it.
- **Exact copy** (en.json, `web.*` block):
  - `"web.review.deleteVersion.body": "v{{number}} and the comment threads written on it will be deleted permanently. Its links and share links stop working at once, and files no other version uses are removed from storage. Backups made before now still contain it."`
  - `"web.review.deleteArtifact.body": "Every version, comment and share link of “{{name}}” will be deleted permanently, and its links stop working at once. Backups made before now still contain it."`
  - `"web.review.live.published": "v{{number}} was published"`, `"web.review.live.switch": "Switch"`, `"web.review.live.switched": "Now showing v{{number}}"`
  - `"web.comments.detached": "Couldn't find this on v{{number}}"`, `"web.comments.resolvedIn": "Resolved in v{{number}}"`, `"web.comments.resolved": "Resolved"`
  - `"web.comments.noAnnotator": "This page blocks Pinwall's comment helper, so comments can only be pinned to a spot on the screen, and they don't move when the page scrolls."`
  - `"web.share.urlOnce": "Copy this link now. Pinwall keeps only a fingerprint of it and can't show it again."`
- **Server keys reused**, because their text is exactly what the UI shows: `share.passwordTooShort`, `share.notFound.title`, `share.gone.title` and `share.expired.title`, on top of M7a's list.
- **One new dependency:** `diff` in `apps/web` (BSD-3-Clause, the server's major). No diff UI library.

## Review Focus

1. **Keyboard focus inside the artifact frame.** The frame swallows key events, so `C`, `Esc` and `?` never reach the viewer. Expected:
   - every shortcut action also has a visible control;
   - full screen uses the browser Fullscreen API, whose `Esc` works whatever has focus, and shows an "Exit full screen" pill.

   → Task 6 `every shortcut has a visible control`, `full screen hides chrome and exits from the pill or the browser`.
2. **Messages that are not from our annotator.** Look-alike messages can come from other windows, sibling frames or popups. The artifact's own scripts can also forge `pin-clicked`, `anchor-picked` or `anchors-placed`. Expected: the outside ones are ignored. Forged ones from inside change view state only: unknown pin ids are ignored, and a pick outside comment mode is dropped. → Task 4 `messages from outside the content frame are ignored`, `picks are accepted only in comment mode`, `pin clicks name known pins only`; Task 6 `frame messages never trigger requests or navigation`.
3. **A tab left open for hours.** That covers sleep, a dropped network, a server restart, and the 12 h review grant running out. Expected:
   - the stream reconnects with backoff and then refetches the artifact and threads, because events may have been missed;
   - the grant is renewed before it expires;
   - a session that ended leads to sign-in.

   → Task 3 `a dropped connection reconnects with growing delays and resyncs`; Task 2 `the review grant renews five minutes before it expires`; Task 6 `an ended stream resyncs the artifact and threads`.
4. **Composing while things change.** A new version is published, or the shown version is deleted, while a draft is open. Expected:
   - the draft is kept;
   - a publish shows the banner instead of switching;
   - the thread is saved on the version its anchor came from (explicit `version_id`);
   - if that version is gone, the server message appears and the text stays.

   → Task 6 `a publish during a draft offers to switch`; Task 5 `a failed post keeps the draft`.
5. **Untrusted strings:** names, bodies, guest names, quotes, paths, diff lines, and Markdown diff HTML. Expected: everything renders as text, and the diff HTML exists only inside the `sandbox=""` frame. → Task 9 `guest and comment text render as text`; Task 10 `file paths and diff text render as text`, `markdown diff HTML never enters the app document`.

## Interface handed to M8b

The exact signatures are in each task's Interfaces block.
- **Task 1:** `scrolled` and `scroll-to` messages and `anchor-picked.client`.
- **Task 2:**
  - `useVersions`, `getPreview`, `reviewPath` and `rawPath`;
  - share links: `listShareLinks`, `createShareLink`, `revokeShareLink`;
  - the share viewer: `getShareInfo`, `unlockShare`, `guestBackend`, `guestPermissions`, `useGuestName`, `GUEST_EDIT_WINDOW_MS`;
  - diffs: `useVersionDiff`, `useTextFileDiff`, `useMarkdownDiff`;
  - `readText`/`writeText`, and the fixtures `fx.thread`, `fx.comment`, `fx.grant`, `fx.shareLink`, `fx.shareInfo`.
- **Task 3:** `useLiveEvents`, `followVersion`, `StreamStatus`, `FakeEventSource`.
- **Task 4:** `CONTENT_SANDBOX`, `ContentFrame`, `useFrameBridge`, `frameBox`, `FrameBridge`, `simFrame`.
- **Task 5:** `Segmented`, `useReviewComments`, `CommentPanel`, `Composer`, `CommentSheet`.
- **Task 6:**
  - `ReviewPage`, `top-bar.tsx`: Task 8 mounts the Share dialog there;
  - `useFullScreen`, `Popover`;
  - the selectors that Task 11 drives: `[data-annotator]`, `article[data-thread-id]`, the button "Choose version, showing vN", "Comment mode", and the textbox "Comment".
- **Task 7:** `canDelete`, and `ReviewMenu` with its `extra` slot, where Task 8 puts Share on phones.

---

### Task 1: Protocol additions — pick point and scroll sync (model: opus)

**Files:**
- Modify: `packages/shared/src/protocol.ts`, `packages/annotator/src/boot.ts`
- Create: `packages/annotator/src/scroll.ts`
- Test: `packages/shared/test/protocol.test.ts` (adds), `packages/annotator/test/scroll.test.ts`

**Interfaces:**
- Consumes: M5 `PageToViewerMessage`, `ViewerToPageMessage`, `boot`, `BootOptions`, `postToViewer`, `onViewerMessage`, `guard`, and the test helpers `stubLayout`, `send` and `sent`.
- Produces (all additive; old viewers and annotators keep working because zod objects strip unknown keys):

```ts
// protocol.ts
export const ClientPoint;   // { x: number, y: number }: finite CSS px in the posting frame's viewport, each within ±100_000
export const ScrollFraction;   // { x: number 0..1, y: number 0..1 }
// PageToViewerMessage: anchor-picked gains client?: ClientPoint; new member scrolled { frameId, x, y }
// ViewerToPageMessage: new member scroll-to { x, y }
// packages/annotator/src/scroll.ts
export function scrollFraction(win: Window): { x: number; y: number };   // scrollX / max(1, scrollWidth - clientWidth), same for y, clamped 0..1, 4 decimals
export function scrollToFraction(win: Window, f: { x: number; y: number }): void;   // win.scrollTo({ left: f.x × maxX, top: f.y × maxY, behavior: 'instant' })
// BootOptions gains parent?: Window | null (default window.parent); the frame is the top content frame when parent === top
```

- [ ] **Step 1: Write the failing tests.** `pointA` is a point anchor on page `''`.

```ts
test('pick points and scroll messages validate', () => {
  expect(parsePageMessage({ pinwall: 1, type: 'anchor-picked', anchor: pointA, frameId: 'f1', client: { x: 120, y: 48.5 } })?.type).toBe('anchor-picked');
  expect(parsePageMessage({ pinwall: 1, type: 'anchor-picked', anchor: pointA, frameId: 'f1' })).not.toBeNull();
  expect(parsePageMessage({ pinwall: 1, type: 'scrolled', frameId: 'f1', x: 0, y: 0.5 })).not.toBeNull();
  for (const bad of [{ type: 'scrolled', frameId: 'f1', x: 1.2, y: 0 },
    { type: 'anchor-picked', anchor: pointA, frameId: 'f1', client: { x: Number.POSITIVE_INFINITY, y: 0 } }])
    expect(parsePageMessage({ pinwall: 1, ...bad })).toBeNull();
  expect(parseViewerMessage({ pinwall: 1, type: 'scroll-to', x: 0.25, y: 1 })?.type).toBe('scroll-to');
  expect(parsePageMessage({ pinwall: 1, type: 'scroll-to', x: 0, y: 0 })).toBeNull();
});
// scroll.test.ts: M5's runtime setup, with boot(window, { scriptSrc, top: window })
test('picks carry the pick point', ...);
  // comment mode: click on <a id="l"> with clientX 40, clientY 60 → anchor-picked.client { x: 40, y: 60 };
  // a text selection ending in a mouseup at (200, 90) → client { x: 200, y: 90 }
test('the top content frame reports scrolling once per animation frame', ...);
  // stubLayout({ scrollHeight: 4000, clientHeight: 1000, scrollY: 1500 }); three scroll events before one rAF →
  // exactly one { type: 'scrolled', x: 0, y: 0.5, frameId }
test('scroll-to scrolls the top content frame', ...);   // send scroll-to { x: 0, y: 0.25 } → scrollTo({ left: 0, top: 750, behavior: 'instant' })
test('nested frames neither report scrolling nor obey scroll-to', ...);   // boot with parent: an iframe's contentWindow (not top) → no scrolled; scrollTo not called
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/shared test && pnpm --filter @pinwall/annotator test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Pick point.** `client` is the triggering `mouseup`/`click` event's `clientX`/`clientY`.
  - **Scroll reporting.** A passive window `scroll` listener, throttled through `requestAnimationFrame`, runs only when `parent === top`.
  - **Scroll commands.** `scroll-to` is honored only by that same frame.
  - **Guards.** Every new listener goes through `guard`. No new globals.
  - **Roadmap.** Its protocol block already lists these additions (edited with this plan). Keep the two in step if a name changes.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @pinwall/annotator build`. Expected: PASS. M5's bundle test still passes: one global, under 100 kB.
- [ ] **Step 5: Commit** `feat(annotator): report the pick point and scroll position, and obey scroll-to, for the review viewer`.

### Task 2: Review API client, comment cache and guest storage (model: sonnet)

**Files:**
- Create: `apps/web/src/api/{versions.ts,comments.ts,shares.ts,diff.ts}`, `apps/web/src/review/comments/{threads.ts,guest.ts,backend.ts,use-threads.ts}`
- Modify: `apps/web/src/api/client.ts` (`RequestOptions.headers?: Record<string, string>`), `apps/web/src/api/keys.ts`, `apps/web/src/lib/storage.ts`, `apps/web/src/test/fixtures.ts`
- Test: `apps/web/src/api/review-api.test.ts`, `apps/web/src/review/comments/{threads.test.ts,use-threads.test.tsx}`, `apps/web/src/lib/storage.test.ts` (adds)

**Interfaces:**
- Consumes: M7a `api`, `qk`, `fx`, `server`, `API`, `apiError`, `readPref`; the M4b and M5 DTOs above.
- Produces:

```ts
// api/versions.ts
export function reviewPath(artifactId: string, n?: number | null): string;   // '/a/art_1' | '/a/art_1/v/2'
export function rawPath(artifactId: string, n?: number | null): string;      // '/a/art_1/raw' | '/a/art_1/v/2/raw'
export function useVersions(artifactId: string): UseInfiniteQueryResult<InfiniteData<VersionList>, ApiError>;   // limit 50
export function getPreview(artifactId: string, n: number, mode: 'review' | 'raw'): Promise<ContentGrant>;
export function useReviewGrant(artifactId: string, n: number | null): UseQueryResult<ContentGrant, ApiError>;
  // staleTime Infinity; refetchInterval = max(60_000, expires_at − Date.now() − 300_000)
export function restoreVersion(artifactId: string, n: number, expectedVersionId: string): Promise<VersionSummary>;
export function deleteVersion(artifactId: string, n: number): Promise<void>;
export function deleteArtifact(artifactId: string): Promise<void>;
// api/comments.ts (members)
export function listAllThreads(artifactId: string): Promise<CommentThread[]>;   // status=all&limit=200, follows next_cursor until null or MAX_ANCHORS (1000) threads
export function createThread(artifactId: string, body: CreateThreadRequest): Promise<CommentThread>;
export function replyTo(commentId: string, body: string): Promise<Comment>;
export function editComment(commentId: string, body: string): Promise<Comment>;
export function deleteComment(commentId: string): Promise<void>;
export function resolveThread(commentId: string, versionId: string): Promise<CommentThread>;   // body { version_id }
export function reopenThread(commentId: string): Promise<CommentThread>;
// api/shares.ts (every /share/… call uses redirectOn401: false)
export function listShareLinks(artifactId: string, cursor?: string | null): Promise<ShareLinkList>;   // limit 50
export function createShareLink(artifactId: string, body: CreateShareLinkRequest): Promise<CreatedShareLink>;
export function revokeShareLink(linkId: string): Promise<void>;
export function getShareInfo(token: string): Promise<ShareInfo>;
export function unlockShare(token: string, password: string): Promise<void>;
export function listGuestThreads(token: string): Promise<CommentThread[]>;   // same paging rule as listAllThreads
export function guestCreateThread(token: string, body: GuestThreadRequest): Promise<GuestCreated>;
export function guestReply(token: string, commentId: string, body: GuestReplyRequest): Promise<GuestCreated>;
export function guestEdit(token: string, commentId: string, body: string, guestToken: string): Promise<Comment>;
export function guestDelete(token: string, commentId: string, guestToken: string): Promise<void>;
// api/diff.ts (each disabled while an argument is null)
export function useVersionDiff(id: string, from: number | null, to: number | null): UseQueryResult<VersionDiff, ApiError>;
export function useTextFileDiff(id: string, from: number | null, to: number | null, path: string | null): UseQueryResult<TextFileDiff, ApiError>;
export function useMarkdownDiff(id: string, from: number | null, to: number | null, path: string | null): UseQueryResult<MarkdownDiff, ApiError>;
// qk adds: versions(id), preview(id, n, mode), threads(scope), shareLinks(id), shareInfo(token), diff(id, from, to), fileDiff(…, path), mdDiff(…, path)
// review/comments/threads.ts (pure; every function returns the same array when nothing changes)
export type ThreadScope = { kind: 'artifact'; artifactId: string } | { kind: 'share'; token: string };
export type ThreadFilter = 'open' | 'resolved' | 'all';
export function upsertThread(list: CommentThread[], t: CommentThread): CommentThread[];   // replace by id, else insert in (created_at, id) order
export function upsertComment(list: CommentThread[], c: Comment): CommentThread[];
  // root (c.id === thread id): replace root fields, keep replies/anchor/status; reply: replace by id or insert by created_at
export function removeComment(list: CommentThread[], threadId: string, commentId: string): CommentThread[];   // root → drop the thread
export function applyLiveEvent(list: CommentThread[], e: LiveEvent): CommentThread[];   // comment.* only
export function threadsForVersion(list: CommentThread[], shown: number): CommentThread[];   // version.number <= shown
export function filterThreads(list: CommentThread[], f: ThreadFilter, sticky: ReadonlySet<string>): CommentThread[];
export function countThreads(list: CommentThread[]): { open: number; resolved: number };
export function pinNumbers(list: CommentThread[]): Map<string, number>;   // 1-based, list order
// review/comments/guest.ts — the same values as M5's server constants
export const GUEST_TOKEN_HEADER = 'X-Pinwall-Guest-Token'; export const GUEST_EDIT_WINDOW_MS = 900_000;
export function rememberGuestToken(commentId: string, token: string): void;   // sessionStorage 'pinwall:guest-token:<id>'
export function guestTokenFor(commentId: string): string | null; export function forgetGuestToken(commentId: string): void;
export function guestMayChange(c: Comment, now: number): boolean;   // author guest, a token is held, now < created_at + 900_000
export function useGuestName(): [string, (name: string) => void];   // localStorage 'pinwall:guest-name', trimmed, ≤ 60 chars
// review/comments/backend.ts
export interface Permissions { canComment: boolean; canResolve: boolean; needsGuestName: boolean; canEdit(c: Comment): boolean; canDelete(c: Comment): boolean }
export interface CommentBackend {
  scope: ThreadScope; eventsPath: string; list(): Promise<CommentThread[]>;
  create(p: { body: string; anchor: Anchor; versionId: string | null }): Promise<CommentThread>;   // members send version_id; guests cannot
  reply(threadId: string, body: string): Promise<Comment>; edit(commentId: string, body: string): Promise<Comment>; remove(commentId: string): Promise<void>;
  resolve: ((threadId: string, versionId: string) => Promise<CommentThread>) | null; reopen: ((threadId: string) => Promise<CommentThread>) | null;
}
export function memberBackend(artifactId: string): CommentBackend;   // eventsPath `/api/v1/artifacts/${id}/events`
export function guestBackend(token: string, guestName: () => string): CommentBackend;
  // eventsPath `/api/v1/share/${token}/events`; versionId ignored (the server uses the shown version); stores each guest_token; resolve/reopen null
export function memberPermissions(me: Me, artifact: { created_by: string | null }): Permissions;
  // edit: own member comments; delete: own, or me.id === artifact.created_by, or me.role === 'admin'
export function guestPermissions(now: () => number): Permissions;   // canResolve false, needsGuestName true, edit/delete via guestMayChange
// review/comments/use-threads.ts
export function useThreads(b: CommentBackend): UseQueryResult<CommentThread[], ApiError>;   // qk.threads(b.scope)
export function useCommentActions(b: CommentBackend): { create; reply; edit; remove; resolve; reopen };   // UseMutationResults; success applies the matching helper to the cache
// lib/storage.ts (adds)
export function readText(key: string, o?: { session?: boolean; max?: number }): string | null;
export function writeText(key: string, value: string | null, o?: { session?: boolean }): void;   // null removes; never throws
// test/fixtures.ts adds fx.thread, fx.comment, fx.grant, fx.shareLink, fx.shareInfo (each parses with its shared schema)
```

- [ ] **Step 1: Write the failing tests.**

```ts
// threads.test.ts
const a = fx.thread({ id: 'cmt_a', created_at: 1 }), b = fx.thread({ id: 'cmt_b', created_at: 2 });
test('upsert keeps creation order and replaces by id', () => {
  expect(upsertThread([b], a).map((t) => t.id)).toEqual(['cmt_a', 'cmt_b']);
  expect(upsertThread([a, b], { ...a, body: 'x' })[0]?.body).toBe('x');
});
test('comments update roots and replies', ...);   // a root edit keeps replies; a new reply is appended; a reply edit replaces it; an unknown thread returns the same array
test('remove drops a reply or the whole thread', ...);
test('live events apply to the cache', ...);
  // comment.created → upserted; comment.deleted with thread null → removed; with a thread → replaced; version.published → the same reference
test('version filter, status filter, sticky ids and counts', ...);
  // threads on v1 (open), v2 (resolved), v3 → threadsForVersion(…, 2) = [v1, v2]; counts { open: 1, resolved: 1 };
  // filterThreads(…, 'open', new Set(['v2 id'])) keeps both
test('pin numbers follow creation order', ...);
// review-api.test.ts (MSW)
test('all threads are read page by page', ...);   // next_cursor 'c2' → a second request; 3 threads; every request has status=all&limit=200
test('thread reading stops at 1000', ...);         // endless pages of 200 → 5 requests, 1000 threads
test('guest edits send the guest token header', ...);   // PATCH /share/tok/comments/cmt_1 carries x-pinwall-guest-token 'gt'
test('share calls never redirect to sign in', ...);
  // 401 { details: { password_required: true } } → rejects with that ApiError; the unauthorized handler is not called
test('the review grant renews five minutes before it expires', ...);   // fake timers; expires_at now + 600_000 → a second preview GET at +300_000 ms
test('paths', ...);   // reviewPath('art_1') '/a/art_1'; reviewPath('art_1', 2) '/a/art_1/v/2'; rawPath('art_1', 2) '/a/art_1/v/2/raw'
// use-threads.test.tsx
test('mutations update the cache from their responses', ...);   // create → listed; reply → in thread.replies; resolve → status 'resolved'; remove root → gone
test('member permissions', ...);   // author edits and deletes; publisher and admin delete only; another member neither
test('guest tokens live in sessionStorage and expire after 15 minutes', ...);   // guestMayChange true at created_at + 899_999, false at + 900_000
test('the guest name is remembered, trimmed and capped', ...);   // ' Lan ' → 'Lan'; 61 chars → 60
test('text storage survives a throwing storage', ...);   // getItem/setItem throw → readText null, writeText no throw
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/api/review-api src/review/comments src/lib/storage`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above. The guest backend maps `GuestCreated` back to a thread or comment: `create` returns `thread`, and `reply` returns `thread.replies.find((r) => r.id === comment_id)`.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add review, comment, share and diff API clients with a pure thread cache and guest storage`.

### Task 3: Live event stream and version following (model: opus)

**Files:**
- Create: `apps/web/src/review/live/{event-stream.ts,use-live-events.ts,follow.ts}`, `apps/web/src/test/fake-event-source.ts`
- Modify: `apps/web/src/test-setup.ts` (installs `FakeEventSource` as `EventSource` before each test; jsdom has none)
- Test: `apps/web/src/review/live/{event-stream,follow}.test.ts`

**Interfaces:**
- Consumes: M5 `LiveEvent`, `LIVE_EVENT_TYPES`.
- Produces:

```ts
// event-stream.ts
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
export function reconnectDelay(attempt: number, random?: () => number): number;   // RECONNECT_DELAYS_MS[min(attempt, 4)] × (0.8 + 0.4 × random()), rounded
export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';
export interface LiveHandlers { onEvent(e: LiveEvent): void; onStatus?(s: StreamStatus): void; onResync?(): void }
export function openLiveStream(path: string, h: LiveHandlers, o?: { random?: () => number }): { close(): void };
// use-live-events.ts
export function useLiveEvents(path: string | null, h: LiveHandlers): StreamStatus;   // latest handlers via ref; reopens on path change; 'ended' when EventSource is undefined
// follow.ts
export interface FollowInput { follow: boolean; shown: number | null; current: number | null; composing: boolean }
export function followVersion(i: FollowInput): { shown: number | null; pending: number | null };
// test/fake-event-source.ts
export class FakeEventSource {
  static instances: FakeEventSource[]; url: string; readyState: 0 | 1 | 2;
  emit(type: string, data: string): void; open(): void; fail(state: 0 | 2): void; close: Mock;   // + addEventListener / removeEventListener
}
```

  **Stream rules:**
  - One listener per `LIVE_EVENT_TYPES` name. `data` goes through `JSON.parse` and `LiveEvent.safeParse`; on failure the event is dropped silently.
  - `open` sets status `open`. If an error happened since the previous open, it calls `onResync` once and resets `attempt`.
  - `error` with `readyState` CONNECTING (the browser retries by itself after `retry: 5000`) → status `reconnecting`.
  - `error` with `readyState` CLOSED → close that source, status `reconnecting`, then a new `EventSource` after `reconnectDelay(attempt++)`.
  - `artifact.deleted` → `onEvent`, close, status `ended`, and no reconnect.
  - `close()` also cancels a pending reconnect.

- [ ] **Step 1: Write the failing tests.**

```ts
test.each([
  [{ follow: true, shown: null, current: 3, composing: false }, { shown: 3, pending: null }],
  [{ follow: true, shown: 3, current: 4, composing: false }, { shown: 4, pending: null }],
  [{ follow: true, shown: 3, current: 4, composing: true }, { shown: 3, pending: 4 }],
  [{ follow: true, shown: 4, current: 3, composing: true }, { shown: 3, pending: null }],    // the shown version was deleted: move even mid-draft
  [{ follow: false, shown: 2, current: 4, composing: false }, { shown: 2, pending: null }],  // a chosen version stays; the page shows "view latest" instead
  [{ follow: true, shown: 4, current: 4, composing: true }, { shown: 4, pending: null }],
])('followVersion(%j)', (i, out) => expect(followVersion(i)).toEqual(out));
test('events arrive parsed; invalid ones are dropped', ...);
  // emit('comment.created', JSON of a LiveEvent) → onEvent(parsed); emit('comment.created', '{') and an unknown shape → nothing; no console output
test('a dropped connection reconnects with growing delays and resyncs', ...);   // Review Focus 3
  // fake timers, random () => 0.5: fail(2) → status 'reconnecting'; no new source at 999 ms, a second at 1000; it fails(2) → the third at +2000;
  // the third opens → status 'open', onResync called once; the next failure waits 1000 again
test("the browser's own retry also resyncs", ...);   // fail(0) then open() → onResync once; FakeEventSource.instances.length 1
test('artifact.deleted ends the stream', ...);   // onEvent then close called, status 'ended'; no new source after 60 s
test('close stops everything', ...);             // close() during a pending reconnect → no new source
test('reconnectDelay jitters within ±20 %', ...);   // (0, () => 0) 800; (0, () => 1) 1200; (9, () => 0.5) 30_000
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/review/live`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures and rules above.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add the live event stream with jittered reconnects and the version-following rule`.

### Task 4: Content frame and annotator bridge (model: opus)

**Files:**
- Create: `apps/web/src/review/frame/{sandbox.ts,windows.ts,device.ts,use-frame-bridge.ts,content-frame.tsx,point-overlay.tsx,pin.tsx}`, `apps/web/src/test/annotator-sim.ts`
- Test: `apps/web/src/review/frame/{windows,device}.test.ts`, `apps/web/src/review/frame/bridge.test.tsx`

**Interfaces:**
- Consumes: Task 1 messages; M5 `Anchor`, `parsePageMessage`, `ViewerToPageMessage`.
- Produces:

```ts
// sandbox.ts
export const CONTENT_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation';
export const CONTENT_ALLOW = 'fullscreen; autoplay; picture-in-picture; clipboard-write';
export const READY_TIMEOUT_MS = 3000;
// windows.ts (every cross-origin property access in try/catch)
export const MAX_FRAME_DEPTH = 8; export const MAX_FRAMES = 200;
export function isWithinFrame(source: MessageEventSource | null, root: Window | null): boolean;   // walks .parent up to MAX_FRAME_DEPTH hops
export function descendantWindows(root: Window): Window[];   // root first, then frames[i] depth-first, ≤ MAX_FRAMES
export function broadcast(root: Window | null, msg: ViewerToPageMessage): void;   // postMessage(msg, '*') to each descendant
export function postTo(win: Window | null, msg: ViewerToPageMessage): void;
// device.ts
export type Device = 'desktop' | 'tablet' | 'phone' | 'custom';
export const DEVICE_WIDTH = { tablet: 768, phone: 390 } as const;
export const CUSTOM_WIDTH = { min: 240, max: 3840, default: 1440 } as const;
export const STAGE_GUTTER = 24;
export interface FrameBox { width: number; height: number; scale: number; framed: boolean }
export function frameBox(device: Device, customWidth: number, stage: { width: number; height: number }): FrameBox;
  // desktop: the stage, scale 1, not framed; else width w, scale = min(1, (stage.width − 2·GUTTER) / w) to 4 decimals,
  // height = round((stage.height − 2·GUTTER) / scale), framed
export function clampCustomWidth(n: number): number;   // NaN → 1440; else clamped to 240..3840 and rounded
// use-frame-bridge.ts
export type AnnotatorState = 'waiting' | 'ready' | 'missing';
export type PinPlacement = 'placed' | 'detached' | 'elsewhere' | 'pending';
export interface ViewerPin { id: string; number: number; resolved: boolean; anchor: Anchor }
export interface PickedAnchor { anchor: Anchor; frameId: string; topFrame: boolean; client: { x: number; y: number } | null }
export interface FrameBridgeOptions { pins: ViewerPin[]; mode: 'browse' | 'comment'; startPage?: string;
  onPicked?(p: PickedAnchor): void; onPinClicked?(id: string): void; onScrolled?(f: { x: number; y: number }): void }
export interface FrameBridge {
  src: string; frameRef: RefCallback<HTMLIFrameElement>; onFrameLoad(): void; loading: boolean;
  annotator: AnnotatorState; topPage: string;
  placement(pin: { id: string; anchor: Anchor }): PinPlacement;
  focus(id: string): void; navigate(page: string): void; scrollTo(f: { x: number; y: number }): void;
}
export function useFrameBridge(baseUrl: string, o: FrameBridgeOptions): FrameBridge;
// content-frame.tsx
export function ContentFrame(p: { bridge: FrameBridge; title: string; box: FrameBox; pins: ViewerPin[]; mode: 'browse' | 'comment';
  onPicked(p: PickedAnchor): void; onPinClicked(id: string): void; className?: string }): JSX.Element;
  // wrapper with data-annotator={bridge.annotator}; the iframe as in the Global Constraints; a thin progress bar while loading;
  // the PointOverlay when annotator === 'missing'
export function PointOverlay(p: { box: FrameBox; page: string; pins: ViewerPin[]; mode: 'browse' | 'comment';
  onPicked(p: PickedAnchor): void; onPinClicked(id: string): void }): JSX.Element;
export function PinBadge(p: { number: number; resolved: boolean; selected?: boolean }): JSX.Element;   // the pin look shared by the overlay and the panel
// test/annotator-sim.ts
export function simFrame(win: Window, o?: { page?: string; frameId?: string }): {
  ready(): void; picked(a: Anchor, client?: { x: number; y: number }): void; placed(r: { id: string; found: boolean }[]): void;
  pinClicked(id: string): void; navigated(page: string): void; scrolled(x: number, y: number): void; received(): ViewerToPageMessage[] };
  // dispatches MessageEvents on window with source: win, and spies on win.postMessage
export function nestedWindow(iframe: HTMLIFrameElement): Window;   // appends an iframe inside iframe.contentDocument
```

  **Bridge rules:**
  - **Listener.** One `message` listener on `window` per bridge. It runs `isWithinFrame` against the iframe's `contentWindow`, then `parsePageMessage`; anything else is ignored.
  - **`ready`.** Record `frameId → { page, source }` and clear that frame's results. Broadcast `set-mode` and `show-anchors(pins)`. A `ready` from the iframe's own window also sets `annotator 'ready'` and `topPage`, and cancels the missing timer.
  - **Other messages from the frame.**
    - `navigated` updates the frame's page and clears its results.
    - `anchors-placed` records the results per frame.
    - `anchor-picked` reaches `onPicked` only in comment mode. `client` is kept only when the source is the top window.
    - `pin-clicked` reaches `onPinClicked` only for an id in `pins`.
    - `scrolled` reaches `onScrolled` only from the top window.
  - **Pins or mode change** → broadcast `show-anchors` or `set-mode` again.
  - **`onFrameLoad`.** With no top `ready` since that load, a `READY_TIMEOUT_MS` timer sets `missing`. A later `ready` wins.
  - **`placement`.** No frame shows the anchor's page → `elsewhere`. Any frame found it → `placed`. Any frame reported it not found → `detached`. Otherwise `pending`.
  - **`focus(id)`.** Broadcast `focus-anchor` when a frame shows the pin's page. Otherwise `navigate(page)` and send it after that page's `ready`.
  - **`navigate`.** Sets `src = baseUrl + page`, each segment `encodeURIComponent`'d.
  - **New grant.** A new `baseUrl` resets everything.

- [ ] **Step 1: Write the failing tests.** `bridge.test.tsx` renders a harness of `useFrameBridge('http://localhost:8080/c/tok/', …)` plus `ContentFrame`.

```ts
test('the frame is sandboxed exactly and points at the grant', () => {
  const f = screen.getByTitle('Pricing, v3') as HTMLIFrameElement;
  expect(f.getAttribute('sandbox')).toBe(CONTENT_SANDBOX);
  expect(f.getAttribute('allow')).toBe(CONTENT_ALLOW);
  expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(f.getAttribute('src')).toBe('http://localhost:8080/c/tok/');
  expect(f.hasAttribute('srcdoc')).toBe(false);
});
test('isWithinFrame accepts the frame and its descendants only', ...);
  // outer.contentWindow and nestedWindow(outer) true; window, a sibling iframe's window and null false; a stub whose parent is itself → false
test('ready gets the mode and anchors in every frame', ...);
  // nested ready → both windows received set-mode 'browse' and show-anchors with [{ id, number, resolved, anchor }];
  // JSON.stringify of every received message contains no 'body' and no author name
test('messages from outside the content frame are ignored', ...);   // Review Focus 2
  // a valid ready with source window, a sibling iframe or null → annotator stays 'waiting'; { type: 'ready' } from the frame → ignored
test('placement tracks every frame', ...);
  // p1 on 'docs/', p2 on 'a.html'; the nested frame (page 'docs/') places [{ id: 'p1', found: true }] → p1 'placed', p2 'elsewhere';
  // navigated 'docs/' then placed found false → 'detached'; a new ready from it → 'pending'
test('picks are accepted only in comment mode and carry the top-frame point', ...);   // Review Focus 2
  // browse: picked → onPicked not called; comment: top picked with client { x: 40, y: 60 } → { topFrame: true, client: { x: 40, y: 60 } };
  // nested picked with a client → { topFrame: false, client: null }
test('pin clicks name known pins only', ...);   // 'p1' → onPinClicked('p1'); 'nope' → not called
test('no ready within 3 s of load means no annotator; a late ready wins', ...);
  // fake timers; fireEvent.load(iframe); at 2999 ms 'waiting'; at 3000 'missing' and the overlay shows; top ready → 'ready', overlay gone
test('focusing a pin on another page loads that page first', ...);
  // p1 on 'docs/', top page '' → src 'http://localhost:8080/c/tok/docs/'; ready page 'docs/' → focus-anchor { id: 'p1' } posted
test('a new grant resets the bridge', ...);
test('the point overlay pins comments by position', ...);
  // missing, comment mode, box 800×600 scale 1: click at (200, 150) → onPicked { anchor: { kind: 'point', page: '', position: { x: 0.25, y: 0.25 },
  //   viewport: { width: 800 } }, topFrame: true, client: { x: 200, y: 150 } }; a point pin at (0.5, 0.5) sits at left 400px top 300px
test('scroll messages come only from the top content window', ...);
// device.test.ts
test.each([
  ['desktop', 1440, { width: 1000, height: 800 }, { width: 1000, height: 800, scale: 1, framed: false }],
  ['tablet', 1440, { width: 1000, height: 800 }, { width: 768, height: 752, scale: 1, framed: true }],
  ['phone', 1440, { width: 1000, height: 800 }, { width: 390, height: 752, scale: 1, framed: true }],
  ['custom', 1904, { width: 1000, height: 800 }, { width: 1904, height: 1504, scale: 0.5, framed: true }],
])('frameBox(%s)', (d, w, stage, out) => expect(frameBox(d as Device, w, stage)).toEqual(out));
test('custom widths are clamped', () => {
  expect([clampCustomWidth(100), clampCustomWidth(5000), clampCustomWidth(Number.NaN), clampCustomWidth(1023.6)]).toEqual([240, 3840, 1440, 1024]);
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/review/frame`. Expected: FAIL.
- [ ] **Step 3: Implement.** Overlay coordinates are offsets in the overlay divided by `box.scale`, as fractions of `box.width × box.height` to 4 decimals; the page scroll is unknown there, which the panel notice explains. `PinBadge` is an accent circle with the number, muted when resolved, and a ring when selected.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add the sandboxed content frame, the annotator bridge, device sizing and the point overlay`.

### Task 5: Comment panel, threads and composer (model: opus)

**Files:**
- Create: `apps/web/src/review/comments/{use-review-comments.ts,comment-panel.tsx,thread-card.tsx,composer.tsx,composer-position.ts,comment-sheet.tsx,reply-box.tsx}`, `apps/web/src/ui/segmented.tsx`
- Modify: `apps/web/src/ui/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/review/comments/{comment-panel.test.tsx,composer-position.test.ts}`

**Interfaces:**
- Consumes: Task 2 backends, cache helpers, `useThreads`, `useCommentActions`, `Permissions`; Task 4 `FrameBridge`, `ViewerPin`, `PickedAnchor`, `PinPlacement`, `PinBadge`; Task 3 `StreamStatus`; M7a `Avatar`, `Badge`, `Menu*`, `ConfirmDialog`, `Textarea`, `Button`, `IconButton`, `EmptyState`, `ErrorState`, `Skeleton`, `copyText`.
- Produces:

```ts
// ui/segmented.tsx — text segmented control on Radix ToggleGroup
export function Segmented<T extends string>(p: { label: string; value: T; onValueChange(v: T): void; items: { value: T; label: string; count?: number }[] }): JSX.Element;
// use-review-comments.ts
export interface Draft extends PickedAnchor {}
export interface ReviewComments {
  query: UseQueryResult<CommentThread[], ApiError>; actions: ReturnType<typeof useCommentActions>; permissions: Permissions;
  visible: CommentThread[]; shownAll: CommentThread[]; counts: { open: number; resolved: number }; numbers: Map<string, number>;
  pins: ViewerPin[];                        // visible threads, plus { id: 'draft', number: shownAll.length + 1 } while drafting
  filter: ThreadFilter; setFilter(f: ThreadFilter): void;   // pref; clears sticky ids
  selectedId: string | null; select(id: string | null): void;
  draft: Draft | null; startDraft(d: PickedAnchor): void; cancelDraft(): void;
  composing: boolean;                       // any non-empty new-comment, reply or edit text
  setText(key: 'new' | `reply:${string}` | `edit:${string}`, text: string): void;
  applyLive(e: LiveEvent): void;            // cache update; a resolve/reopen by anyone makes that thread sticky
}
export function useReviewComments(o: { backend: CommentBackend; permissions: Permissions; shown: number; versionId: string | null;
  filterPrefKey: string | null }): ReviewComments;   // filter default 'open'
// composer-position.ts
export function composerPosition(client: { x: number; y: number }, frame: { left: number; top: number }, scale: number,
  viewport: { width: number; height: number }, size?: { width: number; height: number }): { left: number; top: number };
  // point = frame + client × scale; placed 12 px right of and below it; flipped left/up when it would overflow; clamped 8 px inside the viewport; size default 320 × 196
// components
export function CommentPanel(p: { c: ReviewComments; bridge: FrameBridge; shown: number; variant: 'dock' | 'sheet';
  liveStatus: StreamStatus; onAddComment(): void; onClose(): void; guestName?: { value: string; onChange(v: string): void } }): JSX.Element;
export function ThreadCard(p: { thread: CommentThread; number: number; placement: PinPlacement; shown: number; topPage: string;
  selected: boolean; c: ReviewComments; onSelect(): void; onOpenPage(page: string): void }): JSX.Element;
  // <article data-thread-id aria-label={t('web.comments.cardLabel', { number, name })}>
export function Composer(p: { c: ReviewComments; number: number; floating: { left: number; top: number } | null;
  onPosted(t: CommentThread): void }): JSX.Element;   // textbox name t('web.comments.composerLabel') ("Comment")
export function CommentSheet(p: { open: boolean; onOpenChange(o: boolean): void; title: string; children: ReactNode }): JSX.Element;   // phone bottom sheet, max-height 85dvh
```

  **Panel content:**
  - **Header.** "Comments", then `Segmented` with Open (n), Resolved (n) and All, then "Add comment", then Close.
  - **Notice.** A quiet line with t('web.comments.noAnnotator') when `bridge.annotator === 'missing'`.
  - **List.** Skeleton while loading. ErrorState with Retry on failure. The empty state is t('web.comments.empty.title') with the body "Press C or choose Add comment, then select text or click anything on the page." A filter with no results gets its own empty line.
  - **Footer.** A polite "Reconnecting…" while `liveStatus === 'reconnecting'`.

  **A thread card shows:**
  - its `PinBadge`, avatar, name (plus a `Guest` badge for guests), a version chip `vN` and a relative time;
  - the quote of a text anchor, in two clamped lines with a left rule;
  - a status line:
    - resolved → t('web.comments.resolvedIn', { number }), or t('web.comments.resolved') when `resolved_in_version` is null;
    - `detached` → a warning badge t('web.comments.detached', { number: shown });
    - `elsewhere` → t('web.comments.onPage', { page }), a button that calls `onOpenPage`;
  - the body (`whitespace-pre-wrap`), with "edited" when `edited_at` is set;
  - replies, a Reply box, Resolve or Reopen when the backend allows it, and a menu with Edit, Delete and Copy link (`<origin>/a/<id>?comment=<thread id>`), each by permission.

  Clicking a card selects it and calls `bridge.focus`. The selected card gets `aria-current="true"` and is scrolled into view.

  **Composer:**
  - It shows the pending pin number and the quote. Comment (primary) submits, mod+Enter submits, and Cancel discards. Escape closes it only when it is empty.
  - It floats at `composerPosition` when the pick came from the top frame on the desktop layout. Otherwise it is the first item of the panel or sheet.
  - Submit calls `actions.create({ body, anchor, versionId })` with the shown version's id, selects the new thread, and keeps comment mode on.
  - A failure shows the message verbatim and keeps the text.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.** Study the mockups' panel: quiet cards, numbered pins, and the resolved state shown as a line, not a color flood. The composer's floating card and the panel cards must read as one family.
- [ ] **Step 2: Write the failing tests** (`comment-panel.test.tsx` renders the panel against MSW with a stub bridge whose `placement` comes from a map):

```ts
test('threads show number, author, version, quote and status', ...);
  // t1 open on v1 (text quote 'beta gamma'), t2 resolved in v2 by Ada, t3 guest 'Lan' → cards labelled 'Comment 1 by Ada' …;
  // t2 shows 'Resolved in v2'; t3 shows 'Guest'; placement 'detached' on shown 3 → "Couldn't find this on v3"; 'elsewhere' on 'docs/' → 'On docs/'
test('the filter counts and filters, and remembers the choice', ...);   // default Open (1); Resolved (1); All → 3 cards; pref key 'pinwall:comment-filter:usr_1' = 'all'
test('a thread resolved while open stays listed until the filter changes', ...);
  // Open filter; c.applyLive(comment.resolved for t1 with resolved_in_version v2) → card still listed, now 'Resolved in v2'; choose All then Open → gone
test('reply, resolve, reopen, edit and delete', ...);
  // Reply 'Đã sửa' → POST /comments/t1/replies { body: 'Đã sửa' } → reply listed; Resolve → POST /comments/t1/resolve { version_id: 'ver_3' };
  // Reopen → POST …/reopen; Edit own → PATCH /comments/t1 { body }; Delete → confirm → DELETE; buttons absent without permission
test('the composer posts on the shown version and selects the new thread', ...);
  // startDraft(picked text anchor) → textbox 'Comment'; type 'Bigger title', mod+Enter →
  // POST /artifacts/art_1/comments { body: 'Bigger title', anchor, version_id: 'ver_3' } → card selected; draft cleared; pins without 'draft'
test('a failed post keeps the draft', ...);   // Review Focus 4: 410 'This version was deleted and is no longer available.' → shown verbatim; text kept
test('Escape closes only an empty composer', ...);
test('composing covers new comments, replies and edits', ...);   // c.composing false; type in the reply box → true; clear → false
test('clicking a card focuses its pin; the empty and error states', ...);   // bridge.focus('t1'); [] → empty title; 500 → Retry refetches
test('the overlay notice appears when the annotator is missing', ...);
// composer-position.test.ts
test('the composer sits beside the point and stays on screen', () => {
  expect(composerPosition({ x: 100, y: 50 }, { left: 56, top: 52 }, 1, { width: 1280, height: 800 })).toEqual({ left: 168, top: 114 });
  expect(composerPosition({ x: 1100, y: 700 }, { left: 56, top: 52 }, 1, { width: 1280, height: 800 })).toEqual({ left: 824, top: 544 });
  expect(composerPosition({ x: 200, y: 100 }, { left: 0, top: 0 }, 0.5, { width: 1280, height: 800 })).toEqual({ left: 112, top: 62 });
});
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/review/comments`. Expected: FAIL.
- [ ] **Step 4: Implement** the hook and components. Add the `web.comments.*` keys, including the exact copy in the Global Constraints.
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): add the comment panel with threads, filters, replies, resolve, and a composer placed beside the pin`.

### Task 6: Review page — top bar, stage, versions, devices, full screen, shortcuts, live switching (model: opus)

**Files:**
- Create: `apps/web/src/review/viewer/{review-page.tsx,top-bar.tsx,version-switcher.tsx,device-picker.tsx,stage.tsx,live-banner.tsx,use-shown-version.ts,full-screen.ts,shortcuts.ts,shortcuts-dialog.tsx}`, `apps/web/src/lib/shortcuts.ts`, `apps/web/src/ui/popover.tsx`
- Modify: `apps/web/src/app/routes.tsx` (`a/:artifactId` and `a/:artifactId/v/:n` → `ReviewPage`), `apps/web/src/styles/tokens.css` (layout variable `--review-panel-width: 360px`), `apps/web/src/ui/index.ts`, `packages/shared/src/i18n/en.json`
- Delete: `apps/web/src/pages/artifact/{artifact-page.tsx,artifact-page.test.tsx}`, the M7a stub this page replaces
- Test: `apps/web/src/review/viewer/{review-page,live}.test.tsx`, `apps/web/src/lib/shortcuts.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5; M7a `useArtifact`, `useProject`, `useMe`, `usePref`, `useMediaQuery`, `PHONE_QUERY`, `usePageTitle`, `ToggleGroup`, `Menu*`, `Dialog`, `Kbd`, `Tooltip`, `ErrorState`, `EmptyState`.
- Produces:

```ts
// lib/shortcuts.ts
export interface Shortcut { keys: string[]; run(e: KeyboardEvent): void; enabled?: boolean }
export function isTypingTarget(t: EventTarget | null): boolean;   // input (not button/checkbox/radio), textarea, select, [contenteditable]
export function matchesKeys(e: KeyboardEvent, keys: string[]): boolean;   // 'c', 'shift+c', '?', 'escape', '[', ']', 'j', 'k', '1'–'3', 'f', 'mod+enter'
export function useShortcuts(list: Shortcut[]): void;   // window keydown; skips typing targets, repeats, and unnamed ctrl/meta/alt
// review/viewer/shortcuts.ts — one list drives both the handler and the dialog
export type ReviewAction = 'commentMode' | 'togglePanel' | 'nextThread' | 'prevThread' | 'prevVersion' | 'nextVersion'
  | 'desktop' | 'tablet' | 'phone' | 'fullScreen' | 'shortcuts' | 'escape';
export const REVIEW_SHORTCUTS: readonly { action: ReviewAction; keys: string[]; label: string }[];
  // c · shift+c · j · k · [ · ] · 1 · 2 · 3 · f · ? · escape (leave comment mode, close the composer, exit full screen)
// use-shown-version.ts
export function useShownVersion(artifact: LibraryArtifact | undefined, versionParam: number | null, composing: boolean):
  { follow: boolean; shown: number | null; pending: number | null; switchNow(): void; announce: string | null };   // followVersion over artifact.current_version.number
// full-screen.ts
export function useFullScreen(target: RefObject<HTMLElement | null>): { active: boolean; enter(): void; exit(): void };
  // requestFullscreen when available, synced by fullscreenchange; otherwise (or on rejection) a fixed layer over the window that Escape exits
export function ReviewPage(): JSX.Element;
```

  **Layout (desktop ≥ 768 px):**
  - **Shell.** The M7a shell shows its rail. The page fills `100dvh` as a column.
  - **Top bar** (`--topbar-height`), left to right:
    - the breadcrumb: the project as a link to `/projects/:id`, `/`, then the artifact name as the `h1` (truncated, with `title`);
    - the version switcher, a Menu whose trigger reads `vN` and is named t('web.review.versionTrigger', { number }) ("Choose version, showing v{{number}}"). Items run newest first with the number, Current, relative time, author and message. Load more is at the bottom. Choosing the current version goes to `/a/:id`, any other to `/a/:id/v/:n`.
    - a spacer;
    - the device `ToggleGroup` (Desktop, Tablet 768, Phone 390) plus a Custom width Popover with a number input (240–3840) and the scale label (`50%`) when scaled;
    - Compare (link to `/a/:id/compare?to=N`);
    - the Comment mode toggle (`aria-pressed`, Kbd C);
    - the Comments toggle (`aria-pressed`) with the open count;
    - Share (primary; Task 8 mounts its dialog);
    - the "More actions" menu (Task 7).
  - **Older version pill.** Viewing an older version shows a pill under the bar: t('web.review.olderVersion', { number, latest }) with "View latest".
  - **Stage.** The page sits on a `surface-muted` stage, full-bleed for desktop and centered with a shadow for the other devices, scaled per `frameBox`. Comment mode shows a hint pill at the top of the stage: "Select text, click an element, or Alt-click a spot. Press Esc to stop."
  - **Panel.** It docks right at `--review-panel-width`. Its open state is the pref `pinwall:review-panel:<userId>`, default open.

  **Phone (< 768 px):**
  - **Top bar.** The breadcrumb is just the name. Then the version chip, Comment mode, Comments and the menu, which also holds Compare, Share and Full screen.
  - **Devices.** Hidden: the screen is the phone.
  - **Panel.** A `CommentSheet`.

  **Full screen.** Hides every bit of chrome: rail, bar and panel. Pins stay. Comment mode is off. A pin click exits full screen and selects the thread. An "Exit full screen" pill shows on pointer movement and on keyboard focus.

  **Prefs:** the device is `pinwall:review-device`; the custom width is `readText('pinwall:review-width')`.

  **Live wiring** (`useLiveEvents(backend.eventsPath)`):
  - `version.published` → invalidate the artifact and its versions. `useShownVersion` then switches. When composing, it shows `LiveBanner` (role status) t('web.review.live.published') with "Switch" (`switchNow`) instead. A switch is announced politely with t('web.review.live.switched').
  - `version.deleted` → invalidate the artifact, versions and threads. A pinned viewer of that number sees t('web.review.versionGone', { number }) with "View latest".
  - `artifact.deleted` → the page shows t('web.review.artifactGone') with a link to the project.
  - `comment.*` → `c.applyLive`.
  - `onResync` → invalidate the artifact, versions and threads.

  **Deep link.** `?comment=<id>` selects that thread and focuses its pin once its frame is ready.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.** Match mockup A: a slim bar, the page first, the panel docked right, the rail at left. Settle how the device frame reads, the stage tone, the comment-mode hint, and the motion of the panel and banner (respect reduced motion).
- [ ] **Step 2: Write the failing tests.** `review-page.test.tsx` mounts the real routes with `renderRoute`, MSW handlers (artifact `art_1` "Pricing" in "Launch site", versions 3/2/1, previews, threads) and `simFrame` on the review iframe.

```ts
test('opens the current version in the sandboxed frame, with the rail', ...);
  // renderRoute('/a/art_1') → GET …/versions/3/preview?mode=review; iframe src = grant.url, sandbox = CONTENT_SANDBOX;
  // no 'Projects' heading (rail); link 'Launch site' → /projects/prj_2; heading 'Pricing'; button 'Choose version, showing v3'
test('a version URL shows that version and offers the latest', ...);   // /a/art_1/v/1 → preview n=1; pill text t('web.review.olderVersion', { number: 1, latest: 3 }); 'View latest' → /a/art_1
test('the version switcher lists versions and navigates', ...);   // 'v3' marked Current; choose v2 → /a/art_1/v/2; choose v3 → /a/art_1
test('device sizes resize the frame and are remembered', ...);
  // stage measured 1000×800 (ResizeObserver stub): Tablet → frame box width 768px; Custom 1904 → transform scale(0.5) and label '50%'; reload → still custom 1904
test('the comments toggle shows open threads on this version and remembers its state', ...);   // 2 open on ≤ v3 → '2'; toggle → panel gone; pref 'closed'
test('full screen hides chrome and exits from the pill or the browser', ...);   // Review Focus 1
  // requestFullscreen stub resolves → top bar and panel not in the document; 'Exit full screen' → document.exitFullscreen called;
  // a fullscreenchange with fullscreenElement null also exits; without the API → fixed layer, Escape exits
test('every shortcut has a visible control', ...);   // Review Focus 1
  // 'c' toggles 'Comment mode' aria-pressed; 'c' typed in the custom width input does not; '?' → dialog lists every REVIEW_SHORTCUTS label;
  // for each action except 'escape' and 'shortcuts', a button or menu item with that label exists on the page
test('comment mode picks open the composer beside the pin', ...);
  // 'c' → frames received set-mode 'comment'; top sim picked(text anchor, { x: 100, y: 50 }) → textbox 'Comment' inside a floating card; show-anchors includes 'draft'
test('loading, error and gone states', ...);   // delayed → status skeleton; 500 → ErrorState + Retry; 410 'This artifact was deleted.' verbatim; /a/art_1/v/9 404 message verbatim
test('on a phone the panel is a bottom sheet and devices are hidden', ...);   // setViewport(360): no 'Tablet' item; 'Comments' → dialog 'Comments'
test('?comment= opens that thread and focuses its pin', ...);   // /a/art_1?comment=cmt_b → card selected; after top ready: focus-anchor { id: 'cmt_b' }
test('frame messages never trigger requests or navigation', ...);   // Review Focus 2
  // a burst of ready, anchors-placed, pin-clicked and anchor-picked → MSW saw no non-GET request; router location unchanged
```

  `live.test.tsx` drives `FakeEventSource.instances[0]`:

```ts
test('a publish while following switches without a reload', async () => {   // acceptance 4, component level
  // /a/art_1 on v1 with thread t1 on v1; emit version.published { number: 2 } and GET /artifacts/art_1 now returns current v2 →
  // GET …/versions/2/preview; iframe src = the v2 grant url; browser.assign never called; card 'Comment 1 by Ada' still listed;
  // status text 'Now showing v2'; after the new frame's ready, show-anchors includes t1
});
test('a publish during a draft offers to switch', ...);   // Review Focus 4
  // draft text 'Fix' → emit → banner 'v2 was published' + 'Switch', frame still v1; mod+Enter → POST body version_id 'ver_1'; 'Switch' → v2 grant
test('deleting the shown version moves a follower and stops a pinned viewer', ...);
  // following v3, version.deleted 3 + artifact current v2 → frame v2; at /a/art_1/v/2 with version.deleted 2 → t('web.review.versionGone', { number: 2 }) + 'View latest'
test('an ended stream resyncs the artifact and threads', ...);   // Review Focus 3: fail(2), advance 1000, open → artifact and comments requested again;
  // when that artifact refetch answers 401 unauthorized → router at /signin?return_to=%2Fa%2Fart_1
test('artifact.deleted shows the deleted state', ...);   // t('web.review.artifactGone') and a link to /projects/prj_2
test('comment events from others update the panel', ...);   // comment.created by 'Lan' → a new card without refetch
```

  `shortcuts.test.ts`: `matchesKeys` for `shift+c`, `?` (Shift+/ on US layouts, matched on `e.key`), `mod+enter` (Meta on Apple, Ctrl elsewhere); `isTypingTarget` for each listed element type.
- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/review/viewer src/lib/shortcuts`. Expected: FAIL.
- [ ] **Step 4: Implement** the page and its parts. Add the `web.review.*` and `web.shortcuts.*` keys.
- [ ] **Step 5: Run** `pnpm --filter @pinwall/web test`. Expected: PASS. The M7a shell tests still pass: the rail on `/a/*`.
- [ ] **Step 6: Visual check.** Run the dev server against a local server with an artifact of 3 versions and comments. Screenshot `/a/<id>` at 360, 768 and 1280 px, in light and dark, with the panel open and closed, in comment mode, with the live banner, and in full screen. Fix clipping, low contrast, missing focus rings, or a bar that wraps at 768 px.
- [ ] **Step 7: Commit** `feat(web): add the review viewer with versions, device sizes, full screen, shortcuts and live switching`.

### Task 7: Version actions — links, restore, delete with the backup warning (model: sonnet)

**Files:**
- Create: `apps/web/src/review/viewer/{review-menu.tsx,delete-dialogs.tsx}`
- Modify: `apps/web/src/review/viewer/top-bar.tsx` (mounts the menu), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/review/viewer/review-menu.test.tsx`

**Interfaces:**
- Consumes: Task 2 `rawPath`, `reviewPath`, `restoreVersion`, `deleteVersion`, `deleteArtifact`, `useVersions`; Task 6 `useFullScreen`, the shortcuts dialog; M7a `Menu*`, `ConfirmDialog`, `copyText`, `toast`, `useGoTo`.
- Produces:

```ts
export function canDelete(me: Me, artifact: { created_by: string | null }): boolean;   // me.role === 'admin' || artifact.created_by === me.id
export function ReviewMenu(p: { artifact: LibraryArtifact; shown: VersionSummary; follow: boolean; versionCount: number;
  onFullScreen(): void; onShortcuts(): void; extra?: ReactNode }): JSX.Element;   // trigger IconButton 'More actions'
```

  **Items, in order:**
  1. "Open raw page": an `<a target="_blank" rel="noopener noreferrer">` to `rawPath(id, follow ? null : n)`.
  2. "Copy review link": `location.origin + reviewPath(…)`.
  3. "Copy raw link".
  4. On phones only: Compare and Share, through `extra`.
  5. "Full screen" (F) and "Keyboard shortcuts" (?).
  6. A separator.
  7. "Restore vN as the current version", only when viewing a non-current version.
  8. "Delete vN…", when `canDelete` and `versionCount > 1`.
  9. "Delete artifact…" (danger), when `canDelete`.

  **Copy:**
  - `"web.review.deleteVersion.title": "Delete v{{number}}?"`
  - `"web.review.deleteArtifact.title": "Delete “{{name}}”?"`
  - the two bodies in the Global Constraints;
  - `"web.review.deleteVersion.done": "v{{number}} was deleted."`
  - `"web.review.deleteArtifact.done": "“{{name}}” was deleted."`
  - `"web.review.restored": "v{{number}} was restored as v{{as}}."`

- [ ] **Step 1: Write the failing tests:**

```ts
test('raw and review links', ...);
  // following → 'Open raw page' href '/a/art_1/raw', target '_blank', rel contains 'noopener'; at /a/art_1/v/2 → '/a/art_1/v/2/raw';
  // 'Copy review link' → copyText('http://localhost:3000/a/art_1/v/2')
test('delete items appear for the publisher and admins only', ...);
  // a member who is not the publisher → neither item; the publisher → both; an admin → both; one version → only 'Delete artifact…'
test('deleting a version warns about backups and comments', async () => {
  // open 'Delete v2…' →
  expect(screen.getByRole('alertdialog')).toHaveTextContent(i18n.t('web.review.deleteVersion.body', { number: 2 }));
  expect(i18n.t('web.review.deleteVersion.body', { number: 2 })).toContain('Backups made before now still contain it.');
  // confirm → DELETE /artifacts/art_1/versions/2 → router at /a/art_1, toast 'v2 was deleted.'
});
test('deleting the artifact returns to its project', ...);   // DELETE /artifacts/art_1 → /projects/prj_2 + toast; 403 message verbatim and the dialog stays open
test('restore makes an old version current', ...);
  // viewing v1 of 3 → POST /artifacts/art_1/versions/1/restore { expected_version_id: 'ver_3' } → 201 number 4 → /a/art_1, toast 'v1 was restored as v4.';
  // 409 version_conflict message verbatim
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/review/viewer/review-menu`. Expected: FAIL.
- [ ] **Step 3: Implement** the menu and dialogs (`ConfirmDialog` with tone `danger`).
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add raw and review links, restore, and version and artifact deletion with the backup warning`.

---

## M8a done when

- `pnpm lint && pnpm typecheck && pnpm test` pass, with the protocol and annotator tests of Task 1 and every web test of Tasks 2–7 green.
- `pnpm --filter @pinwall/web build` succeeds.
- The Review Focus tests owned by Tasks 2–6 pass (items 1–4).
