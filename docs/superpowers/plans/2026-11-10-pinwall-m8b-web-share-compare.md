# Pinwall M8b — Web App: Sharing, Share Viewer, Compare, End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The second half of M8. M8b (Tasks 8–11) builds:
- the share dialog: per artifact or per version, public or password, expiry, comments allowed, the URL shown once, plus listing and revoking links;
- the `/s/:token` share viewer: password page, gone pages, the page full-screen under a minimal bar, and guest comments under a name;
- compare: side by side with scroll sync, an overlay slider, a source diff with its own renderer, and the rendered Markdown diff;
- Playwright proof of spec acceptance 4 (browser part) and 5, in both isolation modes.

**Architecture:** M8b builds on M8a's frame bridge, comment components, live stream and review page. Read M8a's "Interface handed to M8b"; task numbers continue from M8a. Share code lives in `apps/web/src/review/share/` and `apps/web/src/pages/share/`, compare in `apps/web/src/review/compare/`, and the end-to-end suite in `e2e/review/` under its own Playwright config.

**Tech Stack:** As M8a, plus `diff` (BSD-3-Clause) for word-level highlights.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md`, §3.6 (visual comparison, source diff, rendered diff), §3.8 (share-link viewers' comments), §3.9, and acceptance 4 and 5.

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`. Its Routes table (`/s/:token`, the share-viewer API, `/a/:id/compare`) and Security model (Review frame, Share links) apply.

**Depends on:** M8a (`2026-11-10-pinwall-m8a-web-review.md`, Tasks 1–7), committed. Plus everything M8a's "Depends on" lists: M4b, M5, M7a and M7b. Where merged code differs in a name or signature, the code wins: change the import and keep the behavior.

**Worktree:** the same worktree, branch and file allowance as M8a.

## Global Constraints

M8a's Global Constraints apply verbatim to every task here, together with the roadmap's and M7a's. Copy them into each implementer brief. The ones these tasks lean on most:
- **Frames.** The review frame attributes are exact, and the content is never `srcdoc`. The rendered Markdown diff is the one `srcdoc` frame, with `sandbox=""`.
- **Untrusted text.** It renders as React text, and `dangerouslySetInnerHTML` appears nowhere.
- **Share secrets.** The share URL is shown once and never cached. Guest tokens live only in `sessionStorage`.
- **Server keys reused:** `share.passwordTooShort`, `share.notFound.title`, `share.gone.title`, `share.expired.title`.

## Review Focus

M8a's Review Focus covers all of M8. M8b owns item 5 (untrusted strings and the Markdown diff HTML) → Task 9 `guest and comment text render as text`; Task 10 `file paths and diff text render as text`, `markdown diff HTML never enters the app document`. It also owns the end-to-end side of items 1–4 → Task 11.

## Interface handed to M9

- **`e2e/review.config.ts`:** two projects, `single-domain` and `content-domain`. The content-domain project serves the app at `http://app.localhost:18092` and content at `http://<token>.pwc.localhost:18092`.
- **`e2e/support/in-page-api.ts`:** `bootstrap`, `apiCall`, `publishInline`, `publishUpload`.
- **`e2e/support/fidelity-site.ts`:** the acceptance-5 fixture.

M9's acceptance suite reuses all three.

---

### Task 8: Share dialog (model: sonnet)

**Files:**
- Create: `apps/web/src/review/share/{share-dialog.tsx,share-form.tsx,share-link-list.tsx,share-status.ts}`, `apps/web/src/ui/switch.tsx`
- Modify: `apps/web/src/ui/index.ts`, `apps/web/src/review/viewer/top-bar.tsx` (Share opens it), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/review/share/share-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 2 `listShareLinks`, `createShareLink`, `revokeShareLink`; M5 `SHARE_PASSWORD_MIN_LENGTH`; M7a `Dialog`, `Field`, `Input`, `Select`, `CopyField`, `ConfirmDialog`, `Badge`, `formatRelativeTime`.
- Produces:

```ts
export function Switch(p: { label: string; description?: ReactNode; checked: boolean; onCheckedChange(v: boolean): void; disabled?: boolean }): JSX.Element;   // Radix Switch
export const EXPIRY_DAYS = [null, 1, 7, 30] as const;   // default null (never)
export function expiresAtFor(days: number | null, now: number): number | null;   // now + days × 86_400_000
export function shareStatus(l: ShareLink, now: number): { tone: 'neutral' | 'warning' | 'danger'; key: string; vars?: Record<string, unknown> };
export function canRevoke(me: Me, artifact: { created_by: string | null }, l: ShareLink): boolean;   // creator, publisher or admin
export function ShareDialog(p: { open: boolean; onOpenChange(o: boolean): void; artifact: LibraryArtifact; shown: VersionSummary }): JSX.Element;
```

  **Form:**
  - "Link shows": "The latest version (follows new versions)" or "v{shown} only".
  - "Who can open it": "Anyone with the link" or "Anyone with the link and the password". The second reveals a password field with a show/hide toggle; fewer than 8 code points gives t('share.passwordTooShort', { min: 8 }) before sending.
  - "Expires": Never, In 1 day, In 7 days, In 30 days.
  - An "Allow comments" Switch with the description "People with the link can read comments and add their own under a name they choose."

  **Result step.** It replaces the form: a `CopyField` with `url`, t('web.share.urlOnce'), and "Done". The token never enters the query cache.

  **Existing links** are listed below the form. Each row shows the scope ("Latest version" or `vN`), a Password badge, a Comments badge, the status ("No expiry", "Expires in 3 days", "Expired"), who made it and when, and when it was last used. Revoke is offered when `canRevoke`, behind a confirmation. Loading, empty and error states apply.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.**
- [ ] **Step 2: Write the failing tests:**

```ts
test('creates a public link to the latest version and shows it once', ...);
  // defaults → POST /artifacts/art_1/share-links { version_id: null, password: null, expires_at: null, allow_comments: false };
  // CopyField value === created.url; t('web.share.urlOnce') shown; 'Done' → url no longer in the document; reopen → only the list
test('a per-version password link with expiry and comments', ...);
  // 'v3 only', password 'Mật khẩu 1', 'In 7 days', comments on → { version_id: 'ver_3', password: 'Mật khẩu 1', expires_at: now + 604_800_000, allow_comments: true }
test('a short password is refused before sending', ...);   // 'seven77' → t('share.passwordTooShort', { min: 8 }); no request
test('existing links show scope, access, status and creator', ...);   // badges Password and Comments; 'Expired' with tone danger; 'by Ada'
test('revoke asks first and is offered only to those allowed', ...);
  // another member's link while viewing as a member who is not the publisher → no Revoke; own link → confirm → DELETE /share-links/shr_1 → refetch; 403 verbatim
test('list states', ...);   // skeleton; [] → t('web.share.none'); 500 → Retry
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/review/share`. Expected: FAIL.
- [ ] **Step 4: Implement** the dialog. Add the `web.share.*` keys.
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): add the share dialog with per-version, password, expiry and comment options and revocation`.

### Task 9: Share viewer at `/s/:token` (model: opus)

**Files:**
- Create: `apps/web/src/pages/share/{share-page.tsx,share-password.tsx,share-gone.tsx,share-viewer.tsx,guest-name-dialog.tsx}`
- Modify: `apps/web/src/app/routes.tsx` (`s/:token` outside the shell and outside `RequireAuth`), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/pages/share/share-page.test.tsx`

**Interfaces:**
- Consumes: Task 2 `getShareInfo`, `unlockShare`, `guestBackend`, `guestPermissions`, `useGuestName`; Task 3 `useLiveEvents`, `followVersion`; Task 4 `ContentFrame`, `useFrameBridge`, `frameBox`; Task 5 `useReviewComments`, `CommentPanel`, `Composer`, `CommentSheet`; M7a `browser`, `PinMark`, `Field`, `Input`, `Button`, `ErrorState`.
- Produces: `SharePage(): JSX.Element` (route element), `SharePassword(p: { token: string })`, `ShareGone(p: { error: ApiError })`, `ShareViewer(p: { token: string; info: ShareInfo })`.

  **Flow.** `useQuery(qk.shareInfo(token), getShareInfo)`, with no retry for 401/404/410:
  - 401 with `details.password_required` → `SharePassword`: a centered card, t('web.share.password.title') ("This link is protected"), one password field and Unlock. On 204, `browser.assign('/s/' + token)`, a full load, because a link without comments then redirects to the raw page. A 401 or 429 shows the server message verbatim.
  - 404 → `ShareGone` titled t('share.notFound.title'). 410 → titled t('share.expired.title') when `details.reason === 'expired'`, else t('share.gone.title'). Either way the message comes from the server, verbatim.
  - Any other error → ErrorState with Retry.
  - 200 → `ShareViewer`.

  **Viewer.**
  - **Bar** (44 px): `PinMark`, the artifact name (`h1`), `vN` plus a Latest badge when `follows_current`, a spacer, then Comment mode and Comments (with the count) when `allow_comments`. There is no app navigation, and `/me` is never requested.
  - **Page.** It fills the rest through `ContentFrame` at the desktop box.
  - **Comments.** They use the guest backend with `guestPermissions`. The first Add comment, or the first pick, without a guest name opens `GuestNameDialog`: "Your name" (1–60 characters), described as "Shown next to your comments to everyone with this link." The panel footer reads "Commenting as {{name}} · Change".
  - **Live.** `useLiveEvents('/api/v1/share/<token>/events')`. For a follow-current link, `version.published` refetches the share info. `followVersion` (follow = `follows_current`) then swaps the grant, with the same banner while composing.
  - **Head.** The page renders `<meta name="robots" content="noindex, nofollow">`; React 19 hoists it.
  - **Guest threads.** A guest's thread lands on the version the link shows when it is posted, because M5's guest API takes no version id.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.** Share viewers may never have seen Pinwall: the password card and the minimal bar must explain themselves in one glance.
- [ ] **Step 2: Write the failing tests:**

```ts
test('a locked link asks for the password, then reloads the link', ...);
  // GET /share/tok 401 password_required → heading 'This link is protected'; POST /share/tok/unlock { password: 'Mật khẩu 1' } → 204 → browser.assign('/s/tok')
test('a wrong password and rate limits show the server message', ...);   // 401 invalid_credentials 'Wrong password.' verbatim; 429 message verbatim
test('gone and unknown links say so', ...);
  // 410 { reason: 'expired' } → t('share.expired.title') + the message; 410 { reason: 'revoked' } → t('share.gone.title'); 404 → t('share.notFound.title')
test('the viewer frames the shared page with a minimal bar', ...);
  // iframe sandbox CONTENT_SANDBOX, src info.content.url; heading 'Pricing', 'v3', 'Latest'; no sidebar; no request to /me; meta robots present
test('guests comment under their name', ...);
  // 'Add comment' → name dialog 'Lan' → pick → composer → POST /share/tok/comments { guest_name: 'Lan', body: 'Đẹp', anchor } →
  // card 'Comment 1 by Lan' with 'Guest'; localStorage 'pinwall:guest-name' = 'Lan'; sessionStorage 'pinwall:guest-token:<id>' = the guest_token
test('guests change their own comments for 15 minutes only and cannot resolve', ...);
  // own comment: Edit → PATCH /share/tok/comments/<id> with x-pinwall-guest-token; at created_at + 900_000 no Edit or Delete; no Resolve anywhere
test('a link without comments shows only the page', ...);   // allow_comments false → no Comments button, no panel
test('a follow-current link switches when a version is published', ...);   // version.published → GET /share/tok again → iframe src = the new content.url
test('guest and comment text render as text', ...);   // Review Focus 5
  // guest name and body '<img src=x onerror=alert(1)>' → shown literally; document.querySelector('img[src="x"]') null
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/pages/share`. Expected: FAIL.
- [ ] **Step 4: Implement** the pages. Add the `web.share.password.*`, `web.share.viewer.*` and `web.guest.*` keys.
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Visual check** of the password card, the gone pages and the viewer, at 360 and 1280 px in light and dark.
- [ ] **Step 7: Commit** `feat(web): add the share viewer with password unlock, gone pages and guest comments`.

### Task 10: Compare — side by side, overlay slider, source diff, rendered Markdown diff (model: opus)

**Files:**
- Create: `apps/web/src/review/compare/{compare-page.tsx,compare-bar.tsx,side-by-side.tsx,overlay-view.tsx,scroll-sync.ts,source-diff.tsx,unified-diff.ts,diff-lines.tsx,rendered-diff.tsx,rendered-diff-doc.ts,defaults.ts}`
- Modify: `apps/web/src/app/routes.tsx` (`a/:artifactId/compare` → `ComparePage`), `apps/web/package.json` (`diff`), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/review/compare/{unified-diff,scroll-sync,rendered-diff-doc,defaults}.test.ts`, `apps/web/src/review/compare/compare-page.test.tsx`

**Interfaces:**
- Consumes: Task 2 `useVersions`, `getPreview`, `useVersionDiff`, `useTextFileDiff`, `useMarkdownDiff`; Task 4 `ContentFrame`, `useFrameBridge`, `frameBox`; Task 5 `Segmented`; Task 8 `Switch`; M4b `FileChange`, `MarkdownDiff`; `diff` `diffWordsWithSpace`.
- Produces:

```ts
// defaults.ts
export type CompareView = 'side' | 'overlay' | 'files' | 'rendered';
export function defaultPair(versions: VersionSummary[], from?: number, to?: number): { from: number; to: number } | null;
  // to = the given number if it exists, else the current; from = the given number if it exists and differs, else the highest number below to, else the lowest above it; null when < 2 versions
// unified-diff.ts
export interface DiffLine { kind: 'context' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null }
export interface DiffHunk { header: string; oldStart: number; newStart: number; lines: DiffLine[] }
export function parseUnifiedDiff(patch: string): DiffHunk[];   // skips Index/===/---/+++ lines and '\ No newline' markers; strips a trailing \r
export function pairChanges(lines: DiffLine[]): Map<number, number>;   // within each run of dels then adds, the i-th del ↔ the i-th add
export interface Segment { text: string; changed: boolean }
export function wordSegments(del: string, add: string): { del: Segment[]; add: Segment[] };   // diffWordsWithSpace; either side > 500 chars → one changed segment
// scroll-sync.ts
export type Side = 'from' | 'to';
export function createScrollSync(): { lead(side: Side): void; setEnabled(on: boolean): void;
  scrolled(side: Side, f: { x: number; y: number }): { side: Side; f: { x: number; y: number } } | null };   // mirrors only the leader, only when enabled
// rendered-diff-doc.ts
export function renderedDiffDocument(blocks: MarkdownDiff['blocks'], labels: { removed: string; added: string; changed: string }): string;
  // a whole document: charset, <meta name="color-scheme" content="light dark">, one inline <style> (Pinwall's own prose and diff styles, light and dark), then per block:
  // unchanged → <section class="pw-u">new_html</section>; added → pw-a; removed → pw-d (old_html); changed → pw-c with <div class="pw-old">…</div><div class="pw-new">…</div>
export function ComparePage(): JSX.Element;   // /a/:artifactId/compare?from=&to=&view=
```

  **Bar:**
  - a back link "← {{name}}" to `/a/:id`;
  - From and To version Selects with a Swap button;
  - a `Segmented` view switch: Side by side, Overlay, Files, plus Rendered when a changed path ends in `.md` or the artifact kind is `markdown`;
  - "Sync scrolling" (`Switch`, default on), in the side view only.

  Every change writes `from`, `to` and `view` to the URL with `replace`.

  **The four views:**
  - **Side by side.** Two `ContentFrame`s, each from a review grant (`getPreview(…, 'review')`). Each bridge gets `pins: []` and `mode: 'browse'`. Each frame takes half the width, labelled `vN` above it; on phones they stack. The leader is set on the frame wrapper's `pointerenter`/`focusin`. `onScrolled` goes through `createScrollSync`, and the result goes to the other bridge's `scrollTo`.
  - **Overlay.** Both frames are stacked in one box. The `to` frame is on top with `clip-path: inset(0 0 0 <p>%)`, and labels sit at the two edges.
    - The handle is `role="slider"` with `aria-valuemin 0`, `aria-valuemax 100` and `aria-valuenow`. Arrows move it ±1, Shift+arrows ±10, Home/End go to the ends, and pointer drag uses pointer capture. A transparent shield covers the frames while dragging.
    - Sync is always on.
    - When either frame's annotator is `missing`, t('web.compare.noSync') appears quietly.
  - **Files.**
    - The file list shows a status icon, the path, and Added, Removed or Changed; on phones it becomes a Select. The first file is selected.
    - `DiffLines` shows two line-number gutters, `+`/`−` marks, word highlights on paired lines, and sticky hunk headers.
    - Special cases: `binary` → t('web.compare.binary'); `too_large` → t('web.compare.tooLarge'); no changes → t('web.compare.noChanges').
  - **Rendered.**
    - A Select of the changed `.md` paths, defaulting to the `to` version's entry when it is one.
    - A legend.
    - `<iframe sandbox="" srcdoc={renderedDiffDocument(…)} title=…>` filling the pane, which scrolls inside.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.** The diff must read well in both themes. Added, removed and changed get token-based tints and text at ≥ 4.5:1, and they are never told apart by color alone: use the `+`/`−` marks and labels too.
- [ ] **Step 2: Write the failing tests:**

```ts
// unified-diff.test.ts
test('parses hunks with line numbers', () => {
  const patch = 'Index: b\n===================================================================\n--- b\tv1\n+++ b\tv2\n@@ -1,3 +1,3 @@\n a\n-2\n+22\n c\n';
  expect(parseUnifiedDiff(patch)).toEqual([{ header: '@@ -1,3 +1,3 @@', oldStart: 1, newStart: 1, lines: [
    { kind: 'context', text: 'a', oldNo: 1, newNo: 1 }, { kind: 'del', text: '2', oldNo: 2, newNo: null },
    { kind: 'add', text: '22', oldNo: null, newNo: 2 }, { kind: 'context', text: 'c', oldNo: 3, newNo: 3 }] }]);
});
test('added files, no-newline markers, CRLF and several hunks', ...);
  // '@@ -0,0 +1,2 @@' → adds numbered 1, 2; '\\ No newline at end of file' dropped; 'x\r' → 'x'; two hunks → two entries
test('changed lines pair up and changed words are marked', () => {
  expect(pairChanges([{ kind: 'del' }, { kind: 'del' }, { kind: 'add' }] as DiffLine[])).toEqual(new Map([[0, 2]]));
  expect(wordSegments('price 10 USD', 'price 12 USD').del).toEqual([{ text: 'price ', changed: false }, { text: '10', changed: true }, { text: ' USD', changed: false }]);
});
// scroll-sync.test.ts
test('only the leader is mirrored', () => {
  const s = createScrollSync(); s.lead('from');
  expect(s.scrolled('from', { x: 0, y: 0.4 })).toEqual({ side: 'to', f: { x: 0, y: 0.4 } });
  expect(s.scrolled('to', { x: 0, y: 0.4 })).toBeNull();
  s.lead('to'); expect(s.scrolled('to', { x: 0, y: 0.1 })?.side).toBe('from');
  s.setEnabled(false); expect(s.scrolled('to', { x: 0, y: 0.2 })).toBeNull();
});
// defaults.test.ts
test('defaultPair', ...);   // [3, 2, 1] current 3 → { from: 2, to: 3 }; (to 1) → { from: 2, to: 1 }; gaps [5, 2] → { from: 2, to: 5 }; one version → null; from === to → from re-derived
// rendered-diff-doc.test.ts
test('blocks are marked and the document is self-contained', ...);
  // the four classes appear; no '<script' outside block HTML from the input; no 'http' URL of Pinwall's own; contains 'prefers-color-scheme: dark'
// compare-page.test.tsx
test('defaults to the previous version against the current one', ...);
  // /a/art_1/compare → URL ?from=2&to=3&view=side; previews n 2 and n 3 with mode review; two iframes with sandbox CONTENT_SANDBOX
test('side by side mirrors scrolling from the frame under the pointer', ...);
  // pointerenter left wrapper; left sim scrolled(0, 0.5) → the right window received { pinwall: 1, type: 'scroll-to', x: 0, y: 0.5 };
  // right sim scrolled → nothing sent left; 'Sync scrolling' off → nothing sent
test('the overlay slider moves with keyboard and pointer', ...);
  // aria-valuenow 50; ArrowRight → 51; Shift+ArrowRight → 61; the top frame's clip-path 'inset(0 0 0 61%)'; End → 100
test('files: list, unified diff, binary and large files', ...);
  // GET /diff?from=2&to=3 → 3 files, first selected → GET /diff/file?from=2&to=3&path=b → a '+' line '22' with '2' marked changed;
  // a binary file → t('web.compare.binary'); too_large → t('web.compare.tooLarge'); files [] → t('web.compare.noChanges')
test('file paths and diff text render as text', ...);   // Review Focus 5: path '<b>x</b>.html' and the line '<script>alert(1)</script>' appear literally
test('markdown diff HTML never enters the app document', ...);   // Review Focus 5
  // kind markdown → 'Rendered'; blocks [{ op: 'changed', old_html: '<img src=x onerror="window.__pwned=1">', new_html: '<p>B2</p>' }] →
  // document.querySelector('img[src="x"]') null; the iframe's getAttribute('sandbox') === '' and its srcdoc contains 'onerror'
test('compare needs two versions', ...);   // one version → t('web.compare.single') with a link back to /a/art_1
test('from and to can be swapped and changed', ...);   // Swap → ?from=3&to=2; choose From v1 → ?from=1&to=2
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/review/compare`. Expected: FAIL.
- [ ] **Step 4: Implement** the page and views. Add `diff` with `pnpm --filter @pinwall/web add diff`, and confirm its license is BSD-3-Clause. Add the `web.compare.*` keys.
- [ ] **Step 5: Run** the Step 3 command, then `pnpm --filter @pinwall/web build`. Expected: PASS.
- [ ] **Step 6: Visual check** of all four views at 360 and 1280 px in light and dark, with a real two-version HTML artifact and a Markdown one.
- [ ] **Step 7: Commit** `feat(web): add version compare with synced side by side, overlay slider, source diff and sandboxed rendered Markdown diff`.

### Task 11: Playwright — acceptance 4 (browser) and 5, in both isolation modes (model: opus)

**Files:**
- Create: `e2e/review.config.ts`, `e2e/support/{review-setup.ts,review-teardown.ts,in-page-api.ts,fidelity-site.ts,make-video.ts}`, `e2e/review/{live-review.spec.ts,fidelity.spec.ts}`
- Modify: `e2e/support/pinwall-server.ts`, root `package.json`
- Test: the two specs

**Interfaces:**
- Consumes: M7b `startPinwall`, `RunningPinwall`; M5 `/api/v1/comments/{id}/resolve`; M4b `/api/v1/publish/inline`, `/api/v1/publish/upload`; M2 `POST /api/v1/auth/setup`, `POST /api/v1/auth/password/sign-in`; Task 4 `CONTENT_SANDBOX`.
- Produces:

```ts
// pinwall-server.ts (additive)
export function startPinwall(o: { port: number; publicOrigin?: string; env?: Record<string, string> }): Promise<RunningPinwall>;
// in-page-api.ts — every call runs fetch inside a page at the app origin, because Node cannot resolve *.localhost
export function bootstrap(page: Page, s: { origin: string; setupUrl: string }): Promise<void>;
  // goto origin + '/signin'; POST /api/v1/auth/setup { token, name: 'Ada', password: 'correct horse battery staple' }; on 409 setup_done → POST /auth/password/sign-in
export function apiCall<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }>;
export function publishInline(page: Page, files: Record<string, string>, target?: object): Promise<PublishResult>;
export function publishUpload(page: Page, files: Record<string, string | Buffer>, target?: object): Promise<PublishResult>;   // multipart built in the page from base64
// make-video.ts
export function makeWebm(browser: Browser): Promise<Buffer>;   // 1 s, 64×64 canvas animation recorded by MediaRecorder('video/webm;codecs=vp8') in Chromium
// fidelity-site.ts
export function fidelitySite(video: Buffer): Record<string, string | Buffer>;
  // index.html: <title>Fidelity</title>, <a id="to-about" href="about.html">, <a id="to-s3" href="#section-3">, three 1200 px sections #section-1..3,
  //   <iframe id="f1" src="frames/inner.html">, <video id="v" src="media/clip.webm" muted playsinline preload="auto">, a script setting window.__marker = 'entry';
  // frames/inner.html (<p id="inner">Inner frame</p><iframe id="f2" src="deeper.html">), frames/deeper.html (<p id="deeper">Deeper frame</p>),
  // about.html (<h1>About</h1>), media/clip.webm
```

  **Config** (`review.config.ts`): `workers: 1`, Chromium only, viewport 1280×800, `globalSetup` and `globalTeardown`. There are two projects, each with its own `use.baseURL` (its server's origin); a test reads its server from `testInfo.project.name`:
  - `single-domain`: port `18091`, `PINWALL_PUBLIC_ORIGIN=http://localhost:18091`.
  - `content-domain`: port `18092`, `PINWALL_PUBLIC_ORIGIN=http://app.localhost:18092`, `PINWALL_ISOLATION=content-domain`, `PINWALL_CONTENT_ORIGIN=http://pwc.localhost:18092`. Chromium resolves `*.localhost` to loopback.

  Global setup:
  1. Make sure the annotator dist exists, by running `pnpm --filter @pinwall/annotator build`.
  2. Start both servers, then export `PINWALL_E2E_<SINGLE|CONTENT>_{ORIGIN,SETUP_URL}`.
  3. Write the webm into a temp dir and export its path.

  Teardown stops both servers and removes their data dirs.

  **Scripts:**
  - `"test:e2e:review": "pnpm --filter @pinwall/web build && playwright test -c e2e/review.config.ts"`;
  - `test:e2e` appends `&& playwright test -c e2e/review.config.ts`.

- [ ] **Step 1: Write `live-review.spec.ts`.** `api` is a second page in the same context, so the review tab is never touched. `PAGE(color)` is an `index.html` containing `<p id="p">The plan costs <span id="price">10 USD per month</span> for everyone.</p>` under an `<h1 style="color:${color}">Pricing</h1>`.

```ts
test('a comment pinned on v1 follows the artifact to v2 and shows resolved in v2', async ({ page, context }) => {
  const api = await context.newPage(); await bootstrap(api, server);
  const v1 = await publishInline(api, { 'index.html': PAGE('#222222') });
  await page.goto(`/a/${v1.artifact_id}`);
  await page.evaluate(() => { (window as any).__noReload = true; });
  await expect(page.locator('[data-annotator="ready"]')).toBeVisible();
  await page.getByRole('button', { name: 'Comment mode' }).click();
  const frame = page.frameLocator('iframe[sandbox]');
  const box = (await frame.locator('#price').boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
  await page.getByRole('textbox', { name: 'Comment' }).fill('Make the price bold');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const card = page.locator('article[data-thread-id]', { hasText: 'Make the price bold' });
  const id = (await card.getAttribute('data-thread-id'))!;
  const pin = frame.locator(`pinwall-overlay [data-pin-id="${id}"]`);
  await expect(pin).toHaveText('1');
  const before = await page.locator('iframe[sandbox]').getAttribute('src');
  await publishInline(api, { 'index.html': PAGE('#c00000') }, { artifact_id: v1.artifact_id, expected_version_id: v1.version_id });
  await expect(page.getByRole('button', { name: 'Choose version, showing v2' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
  expect(await page.locator('iframe[sandbox]').getAttribute('src')).not.toBe(before);
  await expect(pin).toHaveText('1');
  await expect(card).not.toContainText("Couldn't find this");
  expect((await apiCall(api, 'POST', `/api/v1/comments/${id}/resolve`, {})).status).toBe(200);
  await expect(card).toContainText('Resolved in v2');
  await expect(pin).toHaveAttribute('data-resolved', /.*/);
});
test('the review page fits a 360 px phone', ...);   // setViewportSize 360×740 → scrollWidth <= innerWidth; 'Comments' opens the sheet; no CSP console errors
```

- [ ] **Step 2: Write `fidelity.spec.ts`.**

  `observe(page, root: Frame, base: string)` returns:
  - `{ title, marker, frames, video, anchor, link }`;
  - `frames`: a depth-first list of `{ path, text }` over `root.childFrames()`, where `path` is the frame URL minus `base` and `text` is the first `p`;
  - `video`: `{ readyState ≥ 2 reached, videoWidth }`;
  - `anchor`: after clicking `#to-s3`, `{ hash, top: |rect.top| ≤ 1, sameDocument: window.__marker === 'entry' }`;
  - `link`: after clicking `#to-about`, `{ path, h1 }`.

```ts
test('a multi-page artifact behaves the same in review as on its raw link', async ({ page, context }) => {   // acceptance 5
  const api = await context.newPage(); await bootstrap(api, server);
  const site = fidelitySite(readFileSync(process.env.PINWALL_E2E_VIDEO!));
  const pub = await publishUpload(api, site);
  const ranges: number[] = []; page.on('response', (r) => { if (r.url().endsWith('media/clip.webm')) ranges.push(r.status()); });
  const cspErrors: string[] = []; page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text()); });
  const rawResp = (await page.goto(`/a/${pub.artifact_id}/raw`))!;
  expect((await rawResp.body()).equals(Buffer.from(site['index.html'] as string))).toBe(true);   // byte-for-byte
  const rawBase = page.url().replace(/[^/]*$/, '');
  const raw = await observe(page, page.mainFrame(), rawBase);
  expect(await page.evaluate(() => '__pinwallAnnotator' in window)).toBe(false);
  await page.goto(`/a/${pub.artifact_id}`);
  await expect(page.locator('[data-annotator="ready"]')).toBeVisible();
  const el = page.locator('iframe[sandbox]');
  expect(await el.getAttribute('sandbox')).toBe(CONTENT_SANDBOX);
  expect(await el.getAttribute('srcdoc')).toBeNull();
  const reviewRoot = (await (await el.elementHandle())!.contentFrame())!;
  const reviewBase = (await el.getAttribute('src'))!;
  for (const f of [reviewRoot, ...reviewRoot.childFrames(), ...reviewRoot.childFrames().flatMap((c) => c.childFrames())])
    expect(await f.evaluate(() => '__pinwallAnnotator' in window)).toBe(true);   // injected into every review frame
  const review = await observe(page, reviewRoot, reviewBase);
  expect(review).toEqual(raw);
  expect(raw.frames.map((f) => f.path)).toEqual(['frames/inner.html', 'frames/deeper.html']);
  expect(raw.video.videoWidth).toBe(64);
  expect(raw.anchor).toEqual({ hash: '#section-3', top: true, sameDocument: true });
  expect(raw.link).toEqual({ path: 'about.html', h1: 'About' });
  expect(ranges.filter((s) => s === 206).length).toBeGreaterThanOrEqual(2);   // Range-served in both runs (different grant URLs, no cache hit)
  expect(cspErrors).toEqual([]);   // the app's frame-src admits the content in both modes
});
```

- [ ] **Step 3: Run** `pnpm exec playwright install chromium && pnpm test:e2e:review`. Expected: FAIL at the first missing support file. If a product screen is broken, fix it only through the task that owns it, then re-run.
- [ ] **Step 4: Implement** the support files and config. If `.webm` is not served as `video/webm`, fix M4a's `contentTypeFor` table additively; it is specified there.
- [ ] **Step 5: Run** `pnpm test:e2e:review`. Expected: `6 passed` (3 tests × 2 projects). Then run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`. Expected: all pass. Finally, `grep -rn dangerouslySetInnerHTML apps/web/src` must print nothing.
- [ ] **Step 6: Commit** `test(e2e): prove live review across versions and review/raw fidelity in both isolation modes`.

---

## M8 done when (M8a and M8b together)

- `pnpm lint && pnpm typecheck && pnpm test` pass, with the protocol and annotator tests of Task 1 and every web test of Tasks 2–10 green.
- `pnpm test:e2e:review` passes in both projects:
  - acceptance 4, browser part: a comment pinned on v1; v2 published through the API while the tab is open; the tab switches to v2 without a reload; the pin is still anchored; it then shows "Resolved in v2";
  - acceptance 5: entry, nested frames, video with Range, `#anchor` and relative links behave identically in review and on the raw link, in single-domain and content-domain mode.
- Every Review Focus test passes. `grep -rn dangerouslySetInnerHTML apps/web/src` is empty, and `diff` is the only new dependency.
