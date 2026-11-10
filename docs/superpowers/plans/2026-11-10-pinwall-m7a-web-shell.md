# Pinwall M7a — Web App Foundation: Design System, Shell, Sign-in, Library, Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first half of the M7 React SPA, which covers everything outside the review screen. M7a (Tasks 1–7) builds:
- a polished style-B design system with light and dark themes;
- a Claude/ChatGPT-like app shell;
- project and library pages with thumbnail grids and drag-and-drop upload;
- setup and sign-in (password, passkey, OIDC);
- an original pin icon set.

M7b (Tasks 8–12) adds settings, the connect and consent pages, admin, and the Playwright walk with an accessibility smoke check.

**Architecture:** `apps/web/src` is split by responsibility:
- `ui/`: primitives built on tokens and Radix.
- `api/`: a typed fetch wrapper over the `@pinwall/shared` zod DTOs, plus TanStack Query hooks, one file per resource.
- `lib/`: pure helpers for return-to, storage, formatting, WebAuthn and upload.
- `app/`: the router, guards and the shell.
- `library/`: artifact cards, collections and the upload UI.
- `pages/`.

One React Router data router mounts a guarded shell layout. A 401 `unauthorized` anywhere clears the cached `me`, and the guard then redirects to `/signin?return_to=…`. Tests mock the network at the boundary with MSW. M7 has one small server addition, `GET /api/v1/admin/config` (Task 10, in M7b), because no earlier milestone exposes the effective settings.

**Tech Stack:** React 19, Vite 8, Tailwind CSS v4 (`@theme`), `radix-ui` 1.x, TanStack Query 5, React Router 8 (data mode: `createBrowserRouter` from `react-router`, `RouterProvider` from `react-router/dom`), i18next + react-i18next, `@simplewebauthn/browser` 14 (`startRegistration({ optionsJSON })`, `startAuthentication({ optionsJSON })`), sonner 2, lucide-react, clsx + tailwind-merge, zod 4. Tests: Vitest 5, Testing Library, user-event and MSW 3 (`msw/http`, `msw/node`). E2E: Playwright 1.65 + `@axe-core/playwright`.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` §3.2, §3.3, §3.5 (web upload), §3.10, §3.11 and §4. Approved mockups are in `docs/superpowers/specs/mockups/`: `app-shell.html` (shell, project page, rail) and `visual-style.html`, where option **B** was chosen. Their Vietnamese labels are mockup text only; the product UI is English.

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`. Its Routes table and its Global Constraints apply.

**Depends on:**
- M2: setup, sign-in, `/me`, tokens, passkeys and admin users.
- M3: `GET /auth/oidc/start?return_to=…[&prompt=select_account]`.
- M4b: projects, artifacts, recent, thumbnail, upload.
- M6 implements the consent API later; M7 defines its DTOs.

Read the Interfaces blocks of those plans. Where merged code differs in a name or signature, the code wins: change the import and keep the behavior.

**Split:** M7 is split into two plans that share one task numbering:
- this one, Tasks 1–7: design system, icons, API client and router, shell, setup and sign-in, library, upload;
- `2026-11-10-pinwall-m7b-web-accounts-admin.md`, Tasks 8–12: settings, connect and consent pages, the admin configuration API, the admin pages, and the end-to-end walk with the accessibility smoke check.

M7b starts once Tasks 1–7 are committed on the M7 branch, and it consumes the interface listed below. The Global Constraints, Design tokens and Review Focus here cover all of M7.

**Worktree:** M7 runs in parallel with M5 on its own worktree. Touch only:
- `apps/web/**` and `e2e/**`;
- `packages/shared/src/i18n/en.json`, with one contiguous `web.*` block placed right after `"app.name"`;
- the new `packages/shared/src/api/{oauth-consent,admin-config}.ts`, plus one export line each in `packages/shared/src/api/index.ts`;
- the new `apps/server/src/api/admin-config.ts` and its test, plus one line in `apps/server/src/api/router.ts`;
- the root `package.json` (`test:e2e` script, `@axe-core/playwright`), `.gitignore` and `pnpm-lock.yaml`.

M5's annotator smoke test has its own Playwright config in `apps/server/e2e/annotator/`. M7's config lives under the root `e2e/`, so the two never collide.

## Global Constraints

The roadmap's Global Constraints apply, plus these for M7:
- **Polish is a requirement.** Every interactive element has a visible `:focus-visible` ring, keyboard operation and an accessible name. Icon-only buttons go through `IconButton` with a required `label`. Every list has a loading skeleton, an empty state and an error state with Retry. Target: WCAG 2.1 AA, with text contrast ≥ 4.5:1 in both themes.
- **Responsive from 360 px to wide screens.** There is no horizontal page scroll at 360 px. Below 768 px (`PHONE_QUERY = '(max-width: 767px)'`) the sidebar becomes a drawer. Below 640 px dialogs dock to the bottom edge at full width, with `max-height: 90dvh`.
- **Visual work:** implementers of Tasks 1, 2, 4–9 and 11 load the `frontend-design:frontend-design` skill first. Original work only: learn the *feel* of Claude and ChatGPT (quiet, neutral, generous spacing, black rounded primary buttons), and never copy their markup, class lists, CSS or icons.
- **Tokens only.** Tailwind's default palette is switched off (`@theme { --color-*: initial; }`). Colors, radii, shadows and type come from the tokens below. Dark mode follows `prefers-color-scheme` only, with no theme toggle in v1.
- **App CSP** (roadmap Security model): no inline `<script>`, no external fonts, scripts or images. `img-src 'self' data: blob:` blocks IdP-hosted avatars, so `Avatar` shows initials and never loads `avatar_url`. Inline `style` attributes are allowed.
- **Strings.** Every visible string goes through `t()`. Keys are `web.<area>.<name>`, with plurals as `_one`/`_other`, in the flat `en.json` (`keySeparator: false`). Reuse an existing server key only when its text is exactly what the UI shows: `app.name`, `auth.setup.required`, `auth.passkeysUnavailable`, `auth.passwordTooShort`, `auth.passwordTooLong`, `auth.setup.needCredential`, `auth.adminOnly`, `auth.ownRole`, `project.archived`. Tests fail on a missing key (Task 3).
- **Server messages are shown verbatim.** `errorMessage()` returns the server's `error.message`. Only when there is none does it fall back to `web.error.<code>`, then to the status-based keys.
- **Requests:** JSON bodies with `content-type: application/json` and `credentials: 'same-origin'`. Browsers add `Origin` themselves, and M2's CSRF check needs it, so never strip it. List endpoints are read as `{ items, next_cursor }` with "Load more".
- **Browser storage** goes only through `lib/storage.ts`, where every read and write is inside try/catch.
- **New dependencies** must have a checked license:
  - `apps/web`: `zod` `^4.6.7` (the same range as shared, so `pnpm why -r zod` shows one version) and `tailwind-merge` (MIT);
  - `apps/web` dev: `msw` (MIT);
  - root dev: `@axe-core/playwright` and `axe-core`. Both are MPL-2.0 and test-only, so they never ship in the image or a bundle and the roadmap's build-time MPL clause allows them.
- **No new server routes** besides `GET /api/v1/admin/config` (Task 10).

### Design tokens (Task 1 defines them; every task uses them)

Raw variables `--pw-<name>` live in `apps/web/src/styles/tokens.css`. `:root` holds the light values and `@media (prefers-color-scheme: dark) { :root { … } }` the dark ones, plus `color-scheme: light dark`. `@theme inline` maps them to `--color-<name>`.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `canvas` | `#ffffff` | `#1a1a1c` | main area background |
| `sidebar` | `#f9f9f9` | `#141416` | sidebar, rail, drawer |
| `surface` | `#ffffff` | `#222225` | cards, dialogs, menus |
| `surface-muted` | `#f4f4f4` | `#2a2a2e` | instructions box, code, hover fills |
| `selected` | `#ececec` | `#313135` | active nav item |
| `border` / `border-strong` | `#e6e6e6` / `#d4d4d4` | `#2f2f33` / `#46464c` | hairlines / inputs |
| `fg` / `fg-muted` / `fg-subtle` | `#0d0d0d` / `#5e5e5e` / `#8f8f8f` | `#ececec` / `#a6a6ad` / `#7a7a80` | text / secondary text / placeholders and decorative icons only (never body text) |
| `primary` / `primary-fg` | `#0d0d0d` / `#ffffff` | `#f2f2f2` / `#0d0d0d` | primary button |
| `accent` / `accent-text` / `accent-soft` | `#4b56e3` / `#3a44c4` / `#eceefe` | `#8c95ff` / `#a5abff` / `#262a4d` | identity: pin mark, focus ring, selection / accent-colored text / tinted badge |
| `danger`, `success`, `warning` (+ `-soft`) | `#c62828`, `#1f7a3a`, `#8a5a00` | `#f26d6d`, `#4cc27a`, `#e0b050` | status text / tinted backgrounds of your choice at ≥ 4.5:1 |
| `overlay` | `rgb(0 0 0 / 0.4)` | `rgb(0 0 0 / 0.6)` | dialog backdrop |

The scales:
- **Radius:** `sm 6px` (badges, kbd), `md 8px` (inputs, menu items), `lg 12px` (cards), `xl 16px` (dialogs). Buttons use `rounded-full`.
- **Spacing:** Tailwind's default 4 px base.
- **Type:** `xs 12/16`, `sm 13/18`, `base 14/20`, `md 15/22`, `lg 17/24`, `xl 20/28`, `2xl 24/32`, `3xl 30/38`; weights 400, 500 and 600.
- **Fonts:** `--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif` and `--font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`.
- **Shadows:** `card`, `popover`, `dialog`. Dark mode pairs each with a 1 px `border`.
- **Motion:** `--duration-fast 120ms`, `--duration-base 200ms`, `--ease-out cubic-bezier(0.2, 0.8, 0.2, 1)`. Under `prefers-reduced-motion: reduce`, durations become `0.01ms`.
- **Layout:** `--sidebar-width 264px`, `--rail-width 56px`, `--topbar-height 52px`. Content is at most `1200px` wide on library pages and `720px` on form pages, with a 16 px side gutter on phones.
- **Focus ring:** `outline: 2px solid var(--pw-accent); outline-offset: 2px` on `:focus-visible`.

## Review Focus

1. **Folder drops.** Chrome and Safari return at most 100 entries per `readEntries()` call, and `DataTransferItem`s are emptied once the drop handler returns. Expected: every file of a large or nested folder is uploaded, or the person is told why not; never a silent partial upload. → Task 7 `reads every entry of a large folder`, `takes every entry before the drop event ends`.
2. **Error responses that are not Pinwall JSON.** Examples: Cloudflare's 413 page for bodies over 100 MB, a proxy's 502/504 HTML, a dropped connection. Expected: a clear English message chosen by status; no raw HTML and no crash. → Task 3 `a non-JSON error falls back to an i18n message`; Task 7 `a proxy 413 page gets a clear message`.
3. **Signed-out deep links and sessions that end mid-use.** Examples: a bookmarked `/projects/p1`, Revoke now, the IdP re-check, and M4b raw links that send `/signin?next=`. Expected: sign in, then land on the same page; a hostile `return_to` falls back to `/`. → Task 3 `a 401 during use sends the user to sign in and back`, `safeReturnTo` table; Task 5 `next is accepted as an alias for return_to`, `hostile return_to falls back to /`.
4. **A 360 px phone.** Expected: the sidebar is a drawer, nothing scrolls sideways, dialogs fit, and the grid is one column. → Task 4 `on a phone the sidebar is a drawer`; Task 12 `main pages have no accessibility violations` (also asserts `scrollWidth <= innerWidth` at 360 px).
5. **Browser storage unavailable** (Safari private mode, blocked site data). Expected: preferences fall back to defaults kept in memory, and nothing breaks. → Task 3 `storage helpers survive a throwing localStorage`; Task 6 `view toggle survives a throwing localStorage`.

## Interface handed to M7b

The exact signatures are in each task's Interfaces block.
- **Task 1:** every `ui/` primitive (`Button`, `IconButton`, `Field`, `Input`, `Textarea`, `Select`, `Dialog`, `ConfirmDialog`, `Menu*`, `Tooltip`, `Tabs*`, `ToggleGroup`, `toast`, `Skeleton`, `LoadingRegion`, `EmptyState`, `ErrorState`, `Avatar`, `Badge`, `Kbd`, `CopyField`, `copyText`) and the tokens.
- **Task 2:** `Logo`, `PinMark`, `/favicon.svg`, `/manifest.webmanifest`. Task 12 checks they are served.
- **Task 3:**
  - client: `api`, `ApiError`, `errorMessage`, `isApiError`, `qk`;
  - session: `useMe`, `usePublicConfig`, `useSignOut`;
  - navigation: `browser`, `signInPath`, `useGoTo`;
  - formatting: `formatBytes`, `formatDate`, `formatRelativeTime`, `usePageTitle`;
  - routing: `buildRoutes`, `RequireAuth`, `RequireAdmin`, `RequireOwner`;
  - test harness: `server`, `API`, `apiError`, `renderRoute`, `setViewport`, `fx`.
- **Task 4:** `AppShell`, `PageHeader`, `AccountMenu` (Sign out).
- **Task 5:** `createPasskey`, `isPasskeyCancelled`, `passkeysUsable`, `passwordProblem`, `IsolationExplainer`; the setup and sign-in pages, which Task 12 drives.
- **Task 6:** the project page, `ArtifactCollection`, `ViewToggle` and the artifact route, which Task 12 drives.
- **Task 7:** `useUpload` and `UploadDialog`, whose "Choose a folder" input Task 12 fills with `setInputFiles`.

---

### Task 1: Design tokens and UI primitives (model: opus)

**Files:**
- Create: `apps/web/src/styles/tokens.css`
- Create `apps/web/src/ui/`: `cn.ts`, `button.tsx`, `icon-button.tsx`, `input.tsx`, `textarea.tsx`, `field.tsx`, `select.tsx`, `dialog.tsx`, `confirm-dialog.tsx`, `dropdown-menu.tsx`, `tooltip.tsx`, `tabs.tsx`, `toggle-group.tsx`, `toast.tsx`, `skeleton.tsx`, `empty-state.tsx`, `error-state.tsx`, `avatar.tsx`, `badge.tsx`, `kbd.tsx`, `spinner.tsx`, `copy-field.tsx`, `index.ts`
- Modify: `apps/web/src/index.css` (`@import "tailwindcss"`, `@import "./styles/tokens.css"`, the `@theme` mapping, and base styles for body, focus ring, selection and reduced motion), `apps/web/src/test-setup.ts` (stubs for `matchMedia`, `ResizeObserver`, `scrollIntoView`, `hasPointerCapture` and `releasePointerCapture`), `apps/web/package.json` (`tailwind-merge`), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/ui/ui.test.tsx`, `apps/web/src/styles/tokens.test.ts`

**Interfaces:**
- Produces (all re-exported from `ui/index.ts`):

```ts
export function cn(...v: ClassValue[]): string;                       // twMerge(clsx(v))
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'; export type ButtonSize = 'sm' | 'md' | 'lg';
export function Button(p: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize;
  loading?: boolean; asChild?: boolean; leadingIcon?: ReactNode; ref?: Ref<HTMLButtonElement> }): JSX.Element;
  // primary = bg-primary text-primary-fg rounded-full; loading → disabled + aria-busy + <Spinner label={t('web.common.loading')} />
export function IconButton(p: Omit<Parameters<typeof Button>[0], 'children' | 'leadingIcon'> & { label: string; icon: ReactNode;
  shortcut?: string[]; tooltip?: boolean }): JSX.Element;            // aria-label = label; Tooltip shows label (+ Kbd) unless tooltip === false
export function Input(p: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }): JSX.Element;
export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement> & { autosize?: boolean; ref?: Ref<HTMLTextAreaElement> }): JSX.Element;
export interface FieldControlProps { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }
export function Field(p: { label: string; description?: ReactNode; error?: string | null; optional?: boolean;
  children: (control: FieldControlProps) => ReactNode }): JSX.Element;     // error rendered with role="alert"
export function Select(p: { label: string; value: string; onValueChange(v: string): void;
  options: { value: string; label: string }[]; disabled?: boolean; hideLabel?: boolean }): JSX.Element;   // Radix Select
export function Dialog(p: { open: boolean; onOpenChange(o: boolean): void; title: string; description?: ReactNode;
  size?: 'sm' | 'md' | 'lg'; footer?: ReactNode; children?: ReactNode }): JSX.Element;
export function ConfirmDialog(p: { open: boolean; onOpenChange(o: boolean): void; title: string; body: ReactNode;
  confirmLabel: string; tone?: 'default' | 'danger'; onConfirm(): Promise<unknown> | void; errorMessage?(e: unknown): string }): JSX.Element;
  // Radix AlertDialog; awaits onConfirm with the button loading; a rejection keeps it open and shows errorMessage(e) (default: e.message)
export const Menu, MenuTrigger, MenuContent, MenuItem /* { icon?, shortcut?, tone?: 'danger' } */, MenuSeparator, MenuLabel;
export function Tooltip(p: { content: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left'; children: ReactElement }): JSX.Element;  // delayDuration 300
export function TooltipProvider(p: { children: ReactNode }): JSX.Element;
export const Tabs, TabsList, TabsTrigger, TabsContent;
export function ToggleGroup<T extends string>(p: { label: string; value: T; onValueChange(v: T): void;
  items: { value: T; label: string; icon: ReactNode }[] }): JSX.Element;    // single-select, icon-only items with aria-label
export function Toaster(): JSX.Element; export { toast } from 'sonner';   // theme 'system', bottom-right, styled with tokens
export function Skeleton(p: { className?: string }): JSX.Element;          // aria-hidden, shimmer off under reduced motion
export function LoadingRegion(p: { label: string; children: ReactNode }): JSX.Element;  // role="status" aria-live="polite" + visually hidden label
export function EmptyState(p: { icon: ReactNode; title: string; description?: ReactNode; action?: ReactNode }): JSX.Element;
export function ErrorState(p: { title?: string; message: string; onRetry?: () => void }): JSX.Element;   // role="alert"
export function initials(name: string): string;                            // graphemes via Intl.Segmenter
export function Avatar(p: { name: string; size?: 'sm' | 'md' | 'lg' }): JSX.Element;   // initials on one of 8 token-safe hues from a hash of name
export function Badge(p: { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; icon?: ReactNode; children: ReactNode }): JSX.Element;
export function isApplePlatform(): boolean;                                // navigator.userAgentData?.platform ?? navigator.platform
export function Kbd(p: { keys: string[] }): JSX.Element;                   // 'mod' → ⌘ on Apple, Ctrl elsewhere; 'enter' → ↵
export function Spinner(p: { label?: string; size?: number }): JSX.Element;
export function copyText(text: string): Promise<boolean>;                  // Clipboard API, else hidden-textarea execCommand('copy'), else false
export function CopyField(p: { label: string; value: string; multiline?: boolean; mono?: boolean }): JSX.Element;
  // read-only text + IconButton 'Copy'; success announces t('web.common.copied') in an aria-live region;
  // false → selects the text and shows t('web.common.copyManually', { keys }) (⌘C / Ctrl+C)
```

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill**, then read both mockups. Settle the details the token table leaves open: hover and pressed states, the skeleton shimmer, dialog motion, and the toast look.
- [ ] **Step 2: Write the failing tests** (`ui.test.tsx`, with user-event):

```tsx
test('buttons: loading disables and announces; asChild renders a link', async () => {
  render(<Button loading>Save</Button>);
  expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  render(<Button asChild><a href="/x">Go</a></Button>);
  expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('href', '/x');
});
test('icon buttons are named by their label, shown as a tooltip on focus', ...);
  // <IconButton label="Close sidebar" icon={<X/>} /> → getByRole('button', { name: 'Close sidebar' }); user.tab() → tooltip text 'Close sidebar'
test('field wires label, description and error', ...);
  // label 'Name', error 'Required' → input labelled 'Name', aria-invalid 'true', aria-describedby includes the alert's id
test('dialog traps focus, closes on Escape and returns focus to the trigger', ...);
test('confirm dialog runs onConfirm once and keeps open with the error', ...);
  // onConfirm rejects Error('Nope') → double click confirm → called once; text 'Nope' shown; dialog still open
test('menu opens from the keyboard and moves with arrows', ...);   // focus trigger, Enter → menu; ArrowDown → 2nd item focused; Escape → closed
test('tabs move with arrow keys', ...);
test('toggle group is single-select with named items', ...);       // items Grid/List → radio-like; click List → onValueChange('list')
test('loading region announces', ...);                              // getByRole('status', { name: 'Loading projects' })
test('empty and error states render their actions', ...);           // ErrorState onRetry → button t('web.common.retry') calls it
test('initials', () => {
  expect(initials('Ada Lovelace')).toBe('AL'); expect(initials('đức')).toBe('Đ');
  expect(initials('  ')).toBe('?'); expect(initials('😀 smile')).toBe('😀S');
});
test('kbd shows ⌘ on Apple platforms and Ctrl elsewhere', ...);     // stub navigator.platform 'MacIntel' / 'Win32'
test('copy field copies with the Clipboard API and without it', ...);
  // writeText stub → called with value, 'Copied' announced; navigator.clipboard undefined + execCommand stub true → 'Copied';
  // both unavailable → text selected and t('web.common.copyManually', …) shown
```

  `tokens.test.ts` imports `tokens.css?raw` and `index.css?raw`. It checks that every `--pw-*` name defined in the light `:root` is redefined inside the dark media block, and that `index.css` maps each one to `--color-<name>` and contains `--color-*: initial`.
- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/ui src/styles`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement** the tokens, `index.css` and the primitives with the signatures above, on Radix (`import { Dialog, AlertDialog, DropdownMenu, Tooltip, Tabs, ToggleGroup, Select, Slot, VisuallyHidden } from 'radix-ui'`). Add the en.json keys `web.common.loading`, `web.common.retry`, `web.common.copy`, `web.common.copied`, `web.common.copyManually` ("Press {{keys}} to copy."), `web.common.cancel`, `web.common.close`, `web.common.save`, `web.common.error` ("Something went wrong").
- [ ] **Step 5: Run** the Step 3 command, then `pnpm lint && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): add design tokens with light and dark themes and accessible UI primitives`.

### Task 2: Pin mark, favicon, app icons and manifest (model: sonnet)

**Files:**
- Create: `apps/web/src/ui/logo.tsx`, `apps/web/public/favicon.svg`, `apps/web/public/manifest.webmanifest`, `apps/web/public/icons/{icon-192.png,icon-512.png,icon-maskable-512.png,apple-touch-icon.png}`, `apps/web/scripts/render-icons.ts`
- Modify: `apps/web/index.html`, `apps/web/src/ui/index.ts`
- Test: `apps/web/src/ui/logo.test.tsx`

**Interfaces:**
- Consumes: Task 1 tokens (`--pw-accent`).
- Produces:

```ts
export const PIN_MARK_VIEWBOX = '0 0 24 24';
export const PIN_MARK_PATHS: readonly string[];      // ≤ 3 path `d` strings; the same strings appear in favicon.svg
export function PinMark(p: { size?: number; title?: string; className?: string }): JSX.Element;  // aria-hidden unless title
export function Logo(p: { size?: 'sm' | 'md' | 'lg' }): JSX.Element;   // mark + t('app.name')
```

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.** Then design an original, simple pin mark: a push-pin idea, ≤ 3 shapes, legible at 16 px, accent-colored. Do not use lucide's `pin`/`map-pin` or any other product's mark.
- [ ] **Step 2: Write the failing test** (`logo.test.tsx`, reading the files with `node:fs` from `apps/web/public`):

```ts
test('favicon draws the same mark and adapts to dark tabs', () => {
  const svg = readFileSync(publicPath('favicon.svg'), 'utf8');
  for (const d of PIN_MARK_PATHS) expect(svg).toContain(`d="${d}"`);
  expect(svg).toContain('prefers-color-scheme: dark');
  expect(svg).toContain(`viewBox="${PIN_MARK_VIEWBOX}"`);
});
test('manifest names Pinwall and lists the icons', () => {
  const m = JSON.parse(readFileSync(publicPath('manifest.webmanifest'), 'utf8'));
  expect(m).toMatchObject({ name: 'Pinwall', short_name: 'Pinwall', start_url: '/', display: 'standalone' });
  expect(m.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }),
    expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512' }),
    expect.objectContaining({ src: '/icons/icon-maskable-512.png', sizes: '512x512', purpose: 'maskable' })]));
});
test.each([['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]])(
  '%s is a %ipx PNG', (f, n) => {   // PNG signature, then IHDR width/height (big-endian u32 at bytes 16 and 20)
    const b = readFileSync(publicPath('icons/' + f));
    expect(b.subarray(1, 4).toString()).toBe('PNG'); expect(b.readUInt32BE(16)).toBe(n); expect(b.readUInt32BE(20)).toBe(n);
  });
test('index.html links the icons and the manifest', ...);
  // contains rel="icon" href="/favicon.svg" type="image/svg+xml", rel="apple-touch-icon", rel="manifest",
  // <meta name="color-scheme" content="light dark">, and two theme-color metas with media queries
test('PinMark is hidden from assistive tech unless titled', ...);
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/ui/logo`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **Icon renderer.** `scripts/render-icons.ts` takes no new dependency. It uses Playwright's chromium (already a root dev dependency) to render the mark as SVG at 192, 512 and 180 px, and saves the PNGs. Run it with `pnpm exec tsx apps/web/scripts/render-icons.ts` and commit the output.
  - **Background.** App icons sit on a rounded `accent` tile with a white mark.
  - **Maskable icon.** The maskable variant keeps the mark inside the central 80 % safe zone, with a full-bleed background.
  - **Manifest colors.** `theme_color` and `background_color` are `#ffffff`.
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): add the Pinwall pin mark, favicon, app icons and web manifest`.

### Task 3: API client, session, routing, helpers and test harness (model: opus)

**Files:**
- Create: `apps/web/src/api/{client.ts,query-client.ts,keys.ts,session.ts}`, `apps/web/src/lib/{return-to.ts,navigation.ts,storage.ts,format.ts,page-title.ts,media.ts}`, `apps/web/src/app/{routes.tsx,router.tsx,require-auth.tsx}`, `apps/web/src/test/{server.ts,render.tsx,fixtures.ts}`
- Modify: `apps/web/src/App.tsx` (the providers), `apps/web/src/main.tsx`, `apps/web/src/App.test.tsx`, `apps/web/src/test-setup.ts` (MSW lifecycle, missing-key guard), `apps/web/src/i18n.ts` (only if needed for the guard), `apps/web/vite.config.ts` (dev proxy), `apps/web/package.json` (`zod`, `msw`), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/api/client.test.ts`, `apps/web/src/lib/{return-to,storage,format}.test.ts`, `apps/web/src/app/require-auth.test.tsx`, `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes (shared): `ErrorBody`, `Me`, `PublicConfig`, `page`.
- Produces:

```ts
// api/client.ts
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: Record<string, unknown>);
}   // status 0 = network; code is the server code, else 'network' | 'invalid_response' | `http_${status}`
export type Query = Record<string, string | number | boolean | null | undefined>;
export interface RequestOptions<T> { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; query?: Query;
  schema?: z.ZodType<T>; signal?: AbortSignal; redirectOn401?: boolean /* default true */ }
export function apiUrl(path: string, query?: Query): string;       // new URL('/api/v1' + path, location.origin); null/undefined dropped
export function api<T = void>(path: string, o?: RequestOptions<T>): Promise<T>;
export function errorFromBody(status: number, text: string): ApiError;   // shared by fetch and the upload XHR (Task 7)
export function setUnauthorizedHandler(h: (() => void) | null): void;
export function notifyUnauthorized(e: ApiError, redirectOn401?: boolean): void;   // calls the handler when status 401 and code 'unauthorized'
export function isApiError(e: unknown, code?: string): e is ApiError;
export function errorMessage(e: unknown, t: TFunction): string;
// api/query-client.ts
export function createQueryClient(): QueryClient;
  // queries: staleTime 30_000, retry ≤ 2 except 4xx ApiErrors; mutations: retry false
// api/keys.ts — every query key in one place; later tasks add theirs here
export const qk: { me: readonly ['me']; publicConfig: readonly ['config', 'public']; /* + Task 4–11 keys */ };
// api/session.ts
export function getMe(): Promise<Me | null>;                        // 401 unauthorized → null, redirectOn401 false
export function getPublicConfig(): Promise<PublicConfig>;
export function signOut(): Promise<void>;                           // POST /auth/sign-out
export function useMe(): UseQueryResult<Me | null, ApiError>;
export function usePublicConfig(): UseQueryResult<PublicConfig, ApiError>;   // staleTime Infinity
export function useSignOut(): UseMutationResult<void, ApiError, void>;      // success → queryClient.clear(), navigate('/signin')
// lib/return-to.ts
export function safeReturnTo(raw: string | null | undefined): string;   // M3's return_to rules, plus not /signin or /setup; else '/'
export function returnToFrom(search: URLSearchParams): string;          // return_to ?? next, sanitized
export function signInPath(returnTo: string): string;                   // '/signin?return_to=' + encodeURIComponent
export function oidcStartPath(returnTo: string, selectAccount?: boolean): string;  // '/auth/oidc/start?return_to=…[&prompt=select_account]'
export function isServerRoute(path: string): boolean;
  // /api/, /auth/, /upload/, /c/, /mcp, /.well-known/, /oauth/ except /oauth/consent, /a/<id>/raw, /a/<id>/v/<n>/raw
// lib/navigation.ts
export const browser: { assign(url: string): void };               // window.location.assign; tests spy on it
export function useGoTo(): (path: string, o?: { replace?: boolean }) => void;   // server route → browser.assign, else navigate
// lib/storage.ts
export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T;
export function writePref(key: string, value: string): void;
export function usePref<T extends string>(key: string | null, allowed: readonly T[], fallback: T): [T, (v: T) => void];  // key null → memory only
// lib/format.ts
export function formatBytes(n: number): string;                     // decimal units, en: 999 → '999 bytes', 95_000_000 → '95 MB', 1_500_000 → '1.5 MB'
export function formatRelativeTime(ms: number, now?: number): string;   // Intl.RelativeTimeFormat('en', { numeric: 'auto' })
export function formatDate(ms: number): string;                     // Intl.DateTimeFormat('en', { dateStyle: 'medium' })
// lib/page-title.ts
export function usePageTitle(title: string | null): void;          // `${title} · Pinwall`, or 'Pinwall'
// lib/media.ts
export const PHONE_QUERY = '(max-width: 767px)'; export function useMediaQuery(q: string): boolean;
// app/routes.tsx, app/router.tsx, app/require-auth.tsx
export function buildRoutes(): RouteObject[];                      // later tasks add their routes here
export function createAppRouter(): ReturnType<typeof createBrowserRouter>;
export function RequireAuth(p: { children: ReactNode }): JSX.Element;
  // loading → full-screen skeleton; me null → <Navigate to={signInPath(path + search)} replace />
export function RequireAdmin(p: { children: ReactNode }): JSX.Element;   // non-admin → EmptyState t('auth.adminOnly')
export function RequireOwner(p: { children: ReactNode; fallback: string }): JSX.Element;   // kind !== 'owner' → <Navigate to={fallback} />
// App.tsx
export function App(p: { router: DataRouter; queryClient: QueryClient }): JSX.Element;
  // QueryClientProvider > TooltipProvider > RouterProvider + Toaster; installs setUnauthorizedHandler(() => queryClient.setQueryData(qk.me, null))
// test/server.ts, test/render.tsx, test/fixtures.ts
export const server: ReturnType<typeof setupServer>; export const API = '*/api/v1';
export function apiError(status: number, code: string, message: string, details?: Record<string, unknown>): Response;
export function renderRoute(path: string, o?: { me?: Me | null; config?: Partial<PublicConfig> }):
  { user: UserEvent; router: ReturnType<typeof createMemoryRouter>; queryClient: QueryClient };
  // buildRoutes() in a memory router inside <App>; registers GET /me and /config/public handlers from the options
export function setViewport(width: number): void;                 // drives the matchMedia stub
export const fx: { me(o?: Partial<Me>): Me; config(o?: Partial<PublicConfig>): PublicConfig;
  page<T>(items: T[], next?: string | null): { items: T[]; next_cursor: string | null } };   // each fixture parses with its shared schema
```

- [ ] **Step 1: Write the failing tests.** `client.test.ts` uses MSW handlers on `${API}/…`:

```ts
test('parses responses with the shared schema and sends JSON', async () => {
  server.use(http.post(`${API}/echo`, async ({ request }) => {
    expect(request.headers.get('content-type')).toBe('application/json');
    return HttpResponse.json({ ...fx.me(), extra: 1 });
  }));
  const me = await api('/echo', { method: 'POST', body: { a: 1 }, schema: Me });
  expect(me).not.toHaveProperty('extra');
});
test('server error messages pass through verbatim', async () => {
  server.use(http.post(`${API}/me/tokens`, () => apiError(409, 'conflict', 'You have reached the limit of 100 API tokens. Revoke one first.')));
  const e = await api('/me/tokens', { method: 'POST', body: {} }).catch((x) => x);
  expect(e).toMatchObject({ status: 409, code: 'conflict' });
  expect(errorMessage(e, i18n.t)).toBe('You have reached the limit of 100 API tokens. Revoke one first.');
});
test('a non-JSON error falls back to an i18n message', async () => {   // Review Focus 2
  for (const [status, key] of [[502, 'web.error.unavailable'], [504, 'web.error.unavailable'], [413, 'web.error.tooLarge'], [500, 'web.error.generic']] as const) {
    server.use(http.get(`${API}/x`, () => new HttpResponse('<html>Bad gateway</html>', { status, headers: { 'content-type': 'text/html' } })));
    const e = await api('/x').catch((x) => x);
    expect(e).toMatchObject({ status, code: `http_${status}` });
    expect(errorMessage(e, i18n.t)).toBe(i18n.t(key));
  }
});
test('a dropped connection is a network error', ...);        // HttpResponse.error() → status 0, code 'network', t('web.error.network')
test('a malformed success body is invalid_response', ...);   // 200 { nope: 1 } with schema Me → code 'invalid_response'
test('a 204 resolves undefined', ...);
test('401 unauthorized calls the handler; invalid_credentials and redirectOn401 false do not', ...);
test('rate limits say when to retry', ...);                  // 429 rate_limited with the server message → message verbatim
```

  `require-auth.test.tsx`:

```ts
test('a signed-out deep link goes to sign in with return_to', ...);
  // renderRoute('/projects/p1?view=list', { me: null }) → router.state.location: pathname '/signin', search '?return_to=%2Fprojects%2Fp1%3Fview%3Dlist'
test('a 401 during use sends the user to sign in and back', ...);   // Review Focus 3
  // me ok; a test route whose query gets 401 unauthorized → location '/signin?return_to=<that path>'
```

  `return-to.test.ts`:

```ts
test.each([['/projects/p1?x=1#h', '/projects/p1?x=1#h'], ['//evil.example', '/'], ['/\\evil.example', '/'], ['https://evil.example', '/'],
  ['/\t/evil', '/'], ['javascript:alert(1)', '/'], ['/auth/oidc/start?return_to=/', '/'], ['/signin?return_to=/x', '/'],
  ['/setup?token=x', '/'], ['/' + 'x'.repeat(2048), '/'], [null, '/'], ['', '/']])('safeReturnTo(%j) = %j', (raw, out) =>
  expect(safeReturnTo(raw)).toBe(out));
test('next is read when return_to is absent', ...);   // returnToFrom(new URLSearchParams('next=%2Fa%2Fart_1%2Fraw')) → '/a/art_1/raw'
test('server routes need a full navigation', ...);    // '/a/art_1/raw', '/a/art_1/v/2/raw', '/oauth/authorize?x' → true; '/a/art_1', '/oauth/consent?request=r' → false
```

  The remaining tests:
  - `storage.test.ts` — `storage helpers survive a throwing localStorage` (Review Focus 5): `getItem`/`setItem` spies throw `DOMException('QuotaExceededError')`, `readPref` returns the fallback, and `writePref` does not throw. Also `readPref ignores values outside allowed`.
  - `format.test.ts` — the values in the signature comments, plus `formatRelativeTime(now - 7_200_000, now)` → `'2 hours ago'`.
  - `App.test.tsx` — replace the scaffold test with `renders the sign-in page for a signed-out visitor`: `/` with `me: null` shows a heading containing `Pinwall`. That heading is Task 5's page, so until Task 5 the routes file mounts a minimal `/signin` element that renders `<Logo />`.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/web test src/api src/lib src/app src/App.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Test setup.** `test-setup.ts` starts `server.listen({ onUnhandledRequest: 'error' })`, resets handlers after each test and closes after all. It registers an i18next `missingKeyHandler` with `saveMissing: true` that records the key, and an `afterEach` that fails when any key was recorded.
  - **Dynamic keys.** Code with dynamic keys checks `i18n.exists(key)` first.
  - **Dev proxy.** `vite.config.ts` gets `server.proxy` for `/api`, `/auth/oidc`, `/upload`, `/c/`, `/mcp`, `/.well-known`, `^/oauth/(authorize|token|register|revoke)` and `^/a/[^/]+/(v/\d+/)?raw` to `http://localhost:8080`, with `changeOrigin: false`.
  - **Dev server.** Run the backend with `PINWALL_PUBLIC_ORIGIN=http://localhost:5173` so the CSRF origin check accepts the dev origin.
  - **en.json:**
    - `"web.error.generic": "Something went wrong. Try again."`
    - `"web.error.network": "Pinwall could not be reached. Check your connection and try again."`
    - `"web.error.unavailable": "Pinwall is not responding right now. Try again in a moment."`
    - `"web.error.tooLarge": "The request is larger than Pinwall, or a proxy in front of it, accepts."`
    - `"web.error.invalid_response": "Pinwall sent a response this page does not understand. Reload the page."`
- [ ] **Step 4: Run** the Step 2 command, then `pnpm --filter @pinwall/web build`. Expected: PASS; `dist/index.html` exists.
- [ ] **Step 5: Commit** `feat(web): add typed API client, session queries, router guards, helpers and MSW test harness`.

### Task 4: App shell — sidebar, rail, drawer, search, new project, account menu (model: opus)

**Files:**
- Create: `apps/web/src/app/shell/{app-shell.tsx,sidebar.tsx,sidebar-mode.ts,search-dialog.tsx,new-project-dialog.tsx,account-menu.tsx,page-header.tsx,mobile-top-bar.tsx}`, `apps/web/src/api/library.ts`
- Modify: `apps/web/src/app/routes.tsx` (shell layout route), `apps/web/src/api/keys.ts`, `apps/web/src/test/fixtures.ts` (`fx.project`, `fx.artifact`, `fx.version`), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/app/shell/shell.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3; shared `Project`, `ProjectList`, `CreateProjectRequest`, `ArtifactSummary`, `VersionSummary`, `page`.
- Produces:

```ts
// api/library.ts — Task 6 adds getProject, updateProject, getArtifact, useProject, useUpdateProject, useArtifacts, useArtifact
export const LibraryArtifact = ArtifactSummary.extend({ open_thread_count: z.number().int().min(0).optional(),
  share_link_count: z.number().int().min(0).optional() });   // M5 adds both to ArtifactSummary as required fields; until it merges they are absent
export type LibraryArtifact = z.infer<typeof LibraryArtifact>;
export const LibraryArtifactList = page(LibraryArtifact);
export function listProjects(p: { archived: boolean; cursor?: string | null; limit?: number }): Promise<ProjectList>;
export function createProject(body: CreateProjectRequest): Promise<Project>;
export function listArtifacts(p: { projectId?: string; q?: string; cursor?: string | null; limit?: number }): Promise<z.infer<typeof LibraryArtifactList>>;
export function listRecent(limit: number): Promise<z.infer<typeof LibraryArtifactList>>;
export function useProjects(archived: boolean): UseQueryResult<ProjectList, ApiError>;      // limit 200
export function useRecent(): UseQueryResult<z.infer<typeof LibraryArtifactList>, ApiError>; // limit 8
export function useArtifactSearch(q: string): UseQueryResult<z.infer<typeof LibraryArtifactList>, ApiError>;  // limit 8, enabled when q.trim()
export function useCreateProject(): UseMutationResult<Project, ApiError, CreateProjectRequest>;  // invalidates projects
// qk adds: projects(archived), project(id), artifacts(filter), recent, artifact(id), search(q)
// app/shell
export type SidebarMode = 'open' | 'rail';
export function useSidebarMode(): { mode: SidebarMode; forcedRail: boolean; toggle(): void };
  // pref key `pinwall:sidebar:<userId>`; under /a/* the mode is 'rail' (forcedRail) and the saved pref is untouched
export function AppShell(): JSX.Element;   // skip link → #main; sidebar | rail ≥ 768 px; MobileTopBar + drawer below; <main id="main" tabIndex={-1}><Outlet/></main>
export function Sidebar(p: { variant: 'full' | 'rail' | 'drawer'; onNavigate?: () => void }): JSX.Element;
export function SearchDialog(p: { open: boolean; onOpenChange(o: boolean): void }): JSX.Element;
export function useSearchShortcut(open: () => void): void;   // mod+K
export function NewProjectDialog(p: { open: boolean; onOpenChange(o: boolean): void }): JSX.Element;
export function AccountMenu(p: { compact: boolean }): JSX.Element;
export function PageHeader(p: { title: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode }): JSX.Element;
  // h1 with tabIndex -1; AppShell focuses it after each pathname change
```

  Sidebar contents, top to bottom:
  1. Logo and the collapse IconButton.
  2. "+ New project" (secondary button, full width).
  3. Search, with `Kbd mod K`.
  4. "All artifacts" → `/`.
  5. **Projects**: the default project first, then the rest. `NavLink`s carry `aria-current`. An "Archived" disclosure loads `archived=true` lazily.
  6. **Recent** (8).
  7. `AccountMenu` at the bottom: Avatar and name. Items: Settings → `/settings`; Connect an agent → `/connect`; Admin → `/admin` (admins only); separator; Sign out.

  The rail shows icons only, each with a tooltip: expand, new project, search, all artifacts, and the avatar menu.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill**, and study the app-shell mockup's proportions, section labels and quiet active state.
- [ ] **Step 2: Write the failing tests** (`shell.test.tsx`, `renderRoute('/', { me: fx.me({ id: 'usr_1' }) })` with handlers for `/projects` and `/artifacts/recent`):

```ts
test('shows projects, recent artifacts and the account', ...);
  // the default project 'Default' first, then 'Launch site'; the 'Recent' list names; at /projects/prj_2 its link has aria-current 'page'
test('sidebar lists have loading, empty and error states', ...);
  // a delayed /projects → status 'Loading projects'; [] → t('web.sidebar.noProjects'); 500 → ErrorState, Retry refetches (2 requests)
test('collapses to a rail and remembers it per user', ...);
  // click 'Close sidebar' → no 'Projects' heading, 'Open sidebar' button; localStorage 'pinwall:sidebar:usr_1' === 'rail'; re-render → rail
test('opening an artifact shows the rail without changing the saved state', ...);   // saved 'open'; route /a/art_1 → rail; key unchanged
test('on a phone the sidebar is a drawer', ...);   // Review Focus 4
  // setViewport(360) → no navigation landmark visible; 'Open menu' → dialog containing 'All artifacts'; clicking a project closes it
test('new project dialog creates a project and opens it', ...);
  // POST /projects body { name: 'Site', instructions: '' } → router at /projects/prj_new; empty name → field error, no request;
  // 400 with message 'Some fields are missing or invalid.' → shown verbatim
test('search opens with mod+K, shows live results and goes to all results on Enter', ...);
  // keyboard '{Control>}k{/Control}' → combobox focused; type 'chup' → one request GET /artifacts?q=chup&limit=8 after the 200 ms debounce;
  // ArrowDown + Enter → /a/art_1; reopen, type 'chup', Enter with no active option → /search?q=chup; no results → t('web.search.noResults', { q })
test('account menu shows Admin only to admins and signs out', ...);
  // member → no 'Admin' item; admin → 'Admin' → /admin; 'Sign out' → POST /auth/sign-out → /signin, queryClient cache empty
test('a skip link jumps to the content, and navigation focuses the page heading', ...);
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/app/shell`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **Search dialog** (ARIA combobox pattern). The input has `role="combobox"`, `aria-expanded`, `aria-controls` → `role="listbox"`, and `aria-activedescendant`. Input `maxLength` is 256. The footer hint reads t('web.search.enterHint').
  - **Drawer.** The phone drawer is a Radix Dialog sliding from the left, with the `drawer` variant of `Sidebar`.
  - **Section labels.** Projects and Recent are small uppercase `fg-muted` labels.
  - **en.json:** `web.sidebar.*`, `web.search.*`, `web.newProject.*` and `web.account.*`, with `"web.sidebar.allArtifacts": "All artifacts"` and `"web.sidebar.newProject": "New project"`.
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Visual check.** Run the dev server (Task 3 proxy) against a local server with a few projects. Screenshot `/` at 360, 768 and 1280 px in light and dark. Fix clipping, misalignment, low contrast or a missing focus ring.
- [ ] **Step 7: Commit** `feat(web): add the app shell with collapsible sidebar, rail, phone drawer, search and new-project dialog`.

### Task 5: Setup and sign-in pages (model: opus)

**Files:**
- Create: `apps/web/src/api/auth.ts`, `apps/web/src/lib/{webauthn.ts,password.ts}`, `apps/web/src/pages/auth/{auth-layout.tsx,setup-page.tsx,sign-in-page.tsx}`, `apps/web/src/app/isolation-explainer.tsx`
- Modify: `apps/web/src/app/routes.tsx` (`/setup`, `/signin` outside the guard), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/pages/auth/{setup-page,sign-in-page}.test.tsx`, `apps/web/src/lib/password.test.ts`

**Interfaces:**
- Consumes: shared `SetupRequest`, `SetupPasskeyOptionsRequest`, `CeremonyOptions`, `PasskeySignInRequest`, `Me`, `PublicConfig`, `PASSWORD_MIN_LENGTH`, `PASSWORD_MAX_LENGTH`; Task 3 `returnToFrom`, `oidcStartPath`, `useGoTo`, `usePublicConfig`, `useMe`, `qk`.
- Produces:

```ts
// api/auth.ts
export function checkSetupToken(token: string): Promise<void>;                          // POST /auth/setup/check
export function setupPasskeyOptions(body: SetupPasskeyOptionsRequest): Promise<CeremonyOptions>;
export function completeSetup(body: SetupRequest): Promise<Me>;                          // POST /auth/setup
export function signInWithPassword(password: string): Promise<Me>;                       // POST /auth/password/sign-in
export function passkeySignInOptions(): Promise<CeremonyOptions>;                        // POST /auth/passkey/options
export function signInWithPasskey(body: PasskeySignInRequest): Promise<Me>;              // POST /auth/passkey/sign-in
// all with redirectOn401: false
// lib/webauthn.ts
export function passkeysUsable(c: PublicConfig): boolean;            // c.passkeys_available && browserSupportsWebAuthn()
export function createPasskey(options: CeremonyOptions['options']): Promise<RegistrationResponseJSON>;   // startRegistration({ optionsJSON })
export function getPasskeyAssertion(options: CeremonyOptions['options']): Promise<AuthenticationResponseJSON>;
export function isPasskeyCancelled(e: unknown): boolean;             // DOMException NotAllowedError | AbortError
// lib/password.ts
export function passwordLength(pw: string): number;                  // [...pw.normalize('NFKC')].length
export function passwordProblem(pw: string, t: TFunction): string | null;
  // t('auth.passwordTooShort', { min: PASSWORD_MIN_LENGTH }) | t('auth.passwordTooLong', { max: PASSWORD_MAX_LENGTH }) | null
// app/isolation-explainer.tsx — Task 11 reuses it
export function IsolationExplainer(p: { current: PublicConfig['isolation']; compact?: boolean }): JSX.Element;
```

  **Setup page** (`/setup?token=`):
  1. On load it calls `checkSetupToken`. 204 shows the form. 403 and 409 show the server message verbatim; 409 `setup_done` adds a "Sign in" link. A missing token shows t('web.setup.noToken').
  2. Fields: "Your name" (1–100); "Email" (optional).
  3. Sign-in method: Passkey (on by default when `passkeysUsable`) and Password, with a confirmation field. At least one must be chosen, else t('auth.setup.needCredential').
  4. A compact `IsolationExplainer` (spec §3.3: setup explains the trade-off).
  5. Submit with a passkey: `setupPasskeyOptions({ token, name })` → `createPasskey` → `completeSetup({ token, name, email, password?, passkey: { ceremony_id, response } })`.
  6. On success: `setQueryData(qk.me)`, toast t('web.setup.welcome'), go to `/`.

  **Sign-in page** (`/signin?return_to=` or `?next=`), with the elements in this order:
  1. `setup_required` → only t('auth.setup.required').
  2. If OIDC is enabled: a primary full-width `<a href={oidcStartPath(returnTo)}>` labelled t('web.signin.oidc', { name: display_name }) ("Continue with {{name}}"). The owner section then follows behind a disclosure button, t('web.signin.ownerToggle'), so SSO stays first.
  3. Owner section: "Sign in with a passkey" (when usable), and a password form with one field (`autocomplete="current-password"`).
  4. When `!passkeys_available`, t('auth.passkeysUnavailable') appears as help text.

  An already signed-in visitor, or a successful sign-in, goes to `useGoTo()(returnTo, { replace: true })`.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.** The auth pages are a centered card on `canvas` with `Logo`: calm, with one primary action.
- [ ] **Step 2: Write the failing tests.** `vi.mock('@simplewebauthn/browser')` stubs `startRegistration`, `startAuthentication` and `browserSupportsWebAuthn`. `password.test.ts`: `passwordLength('ｐａｓｓ１２３')` → 7; the NFD and NFC forms of `'Mật khẩu'` give the same length; `passwordProblem('a'.repeat(11), t)` → `t('auth.passwordTooShort', { min: 12 })`; 257 chars → too long; `'😀'.repeat(12)` → null. `setup-page.test.tsx`:

```ts
test('a valid link shows the form; a bad one shows the server message', ...);
  // check 204 → 'Your name' field; 403 'This setup link is invalid or has expired. Restart Pinwall to print a new one in the log.' → shown verbatim;
  // 409 setup_done → message + link 'Sign in' to /signin
test('without a token the page says where the link is', ...);
test('setup with a password creates the owner and opens the app', async () => {
  // passkey switched off; fill name 'Ada', email 'ada@example.com', password + confirm 'correct horse battery'
  expect(await setupBody()).toEqual({ token: 'tok', name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' });
  // router at '/', queryClient.getQueryData(qk.me) is the returned Me
});
test('password rules are checked before submit and the confirmation must match', ...);
  // 11 chars → t('auth.passwordTooShort', { min: 12 }) and no request; mismatch → t('web.setup.passwordMismatch')
test('setup with a passkey runs the ceremony first', ...);
  // POST /auth/setup/passkey/options body { token: 'tok', name: 'Ada' }; startRegistration called with { optionsJSON: options };
  // setup body.passkey === { ceremony_id: 'c1', response: <stub response> }, no password key
test('a cancelled passkey prompt keeps the form and says so', ...);   // rejects DOMException('', 'NotAllowedError') → t('web.passkey.cancelled'); no POST /auth/setup
test('passkeys unavailable leaves password only', ...);              // passkeys_available false → no passkey switch, help t('auth.passkeysUnavailable')
test('the isolation trade-off is explained', ...);                   // isolation 'single-domain' → t('web.isolation.single.title') marked current
test('submitting twice sends one request', ...);
```

  `sign-in-page.test.tsx`:

```ts
test('password sign-in returns to return_to', ...);   // /signin?return_to=%2Fprojects%2Fp1, POST { password } → /projects/p1
test('next is accepted as an alias for return_to', ...);   // ?next=%2Fprojects%2Fp1 → /projects/p1
test('hostile return_to falls back to /', ...);           // ?return_to=%2F%2Fevil.example → '/'
test('a server-route return_to does a full navigation', ...);   // ?return_to=%2Fa%2Fart_1%2Fraw → browser.assign('/a/art_1/raw')
test('a wrong password shows the server message and keeps the page', ...);   // 401 invalid_credentials 'Wrong password.' → alert; still /signin
test('passkey sign-in', ...);   // options → startAuthentication({ optionsJSON }) → POST /auth/passkey/sign-in { ceremony_id, response } → '/'
test('the OIDC button uses the configured label and carries return_to', ...);
  // oidc { enabled: true, display_name: 'Zitadel' } → link 'Continue with Zitadel', href '/auth/oidc/start?return_to=%2Fprojects%2Fp1';
  // the password field is hidden until t('web.signin.ownerToggle') is pressed
test('before setup the page says how to finish it', ...);   // setup_required → t('auth.setup.required'), no password field
test('a signed-in visitor is sent on', ...);
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/pages/auth src/lib/password`. Expected: FAIL.
- [ ] **Step 4: Implement.** `IsolationExplainer` renders both modes. The current mode carries a `Badge` t('web.isolation.current'). Use this exact copy (spec §3.3):
  - `"web.isolation.single.title": "Single domain"`
  - `"web.isolation.single.body": "Artifacts are served from this same address, under /c/. Every response tells the browser to run the page in a sealed sandbox, so it cannot read or set Pinwall's cookies or act as you. It still shares this domain with anything else hosted on it, which makes it weaker than a separate domain. Needs nothing extra."`
  - `"web.isolation.content.title": "Separate content domain"`
  - `"web.isolation.content.body": "Each version is served from its own address on a domain used for nothing else, such as <token>.pinwall-content.example. Browsers keep it fully apart from Pinwall and from other versions. Needs a second domain with a wildcard DNS record and certificate. Recommended for production."`
  - `"web.isolation.tradeoff": "Both modes keep artifacts away from your Pinwall session. Single domain is the easiest to run; a separate content domain isolates best. Links people hold keep working when you switch; switching means setting PINWALL_ISOLATION (and PINWALL_CONTENT_ORIGIN) and restarting Pinwall."`
  - `"web.isolation.current": "Current"`
  - `"web.passkey.cancelled": "The passkey prompt was closed. Try again, or use a password."`
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Visual check** at 360 and 1280 px in light and dark: the setup page in every state, and the sign-in page with and without OIDC.
- [ ] **Step 7: Commit** `feat(web): add setup and sign-in pages with password, passkey and single sign-on`.

### Task 6: Library — artifact cards, project page, All artifacts, search, artifact route (model: opus)

**Files:**
- Create: `apps/web/src/library/{colors.ts,artifact-thumb.tsx,artifact-card.tsx,artifact-row.tsx,artifact-collection.tsx,view-toggle.tsx,instructions-editor.tsx}`, `apps/web/src/pages/{project-page.tsx,all-artifacts-page.tsx,search-page.tsx,not-found-page.tsx}`, `apps/web/src/pages/artifact/artifact-page.tsx`
- Modify: `apps/web/src/api/library.ts`, `apps/web/src/api/keys.ts`, `apps/web/src/app/routes.tsx` (`/` index, `projects/:projectId`, `search`, `a/:artifactId`, `a/:artifactId/v/:n`, `a/:artifactId/compare`, `*`), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/library/{colors.test.ts,library.test.tsx}`, `apps/web/src/pages/{project-page,search-page,artifact-page}.test.tsx`

**Interfaces:**
- Consumes: Task 4 `LibraryArtifact`, `listArtifacts`, `useProjects`, `PageHeader`; shared `Project`, `UpdateProjectRequest`, `ArtifactSummary`.
- Produces:

```ts
// api/library.ts (adds)
export const ARTIFACT_PAGE_SIZE = 48; export const INSTRUCTIONS_MAX = 20_000;
export function getProject(id: string): Promise<Project>;
export function updateProject(id: string, body: UpdateProjectRequest): Promise<Project>;
export function getArtifact(id: string): Promise<LibraryArtifact>;
export function useProject(id: string): UseQueryResult<Project, ApiError>;
export function useUpdateProject(id: string): UseMutationResult<Project, ApiError, UpdateProjectRequest>;   // updates project + projects caches
export function useArtifacts(f: { projectId?: string; q?: string }): UseInfiniteQueryResult<InfiniteData<z.infer<typeof LibraryArtifactList>>, ApiError>;
export function useArtifact(id: string): UseQueryResult<LibraryArtifact, ApiError>;
// library/colors.ts
export interface Rgb { r: number; g: number; b: number }
export function parseColor(input: string | null): Rgb | null;      // #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(); anything else → null
export function generatedCardColors(seed: string, themeColor: string | null): { background: string; foreground: string; accent: string };
  // parsed theme color, else one of 10 fixed tasteful hues picked by an FNV-1a hash of seed; outputs are 'rgb(r g b)' strings only;
  // foreground '#0d0d0d' or '#ffffff', whichever contrasts more (WCAG relative luminance); accent = background shifted 18 % toward the foreground
// library
export type LibraryView = 'grid' | 'list';
export function useLibraryView(): [LibraryView, (v: LibraryView) => void];   // usePref(`pinwall:library-view:<userId>`, …, 'grid')
export function ViewToggle(p: { value: LibraryView; onChange(v: LibraryView): void }): JSX.Element;
export function thumbnailUrl(a: LibraryArtifact): string | null;   // has_thumbnail → `/api/v1/artifacts/${id}/thumbnail?v=${current_version.id}`
export function ArtifactThumb(p: { artifact: LibraryArtifact; size: 'card' | 'row' | 'hero' }): JSX.Element;
  // <img loading="lazy" decoding="async" alt=""> on a fixed 16:10 box; onError or no thumbnail → generated card (title, kind glyph)
export function ArtifactCard(p: { artifact: LibraryArtifact }): JSX.Element;    // whole card is one link to /a/:id
export function ArtifactRow(p: { artifact: LibraryArtifact; projectName?: string }): JSX.Element;
export function ArtifactCollection(p: { query: ReturnType<typeof useArtifacts>; view: LibraryView; label: string;
  empty: ReactNode; projectNames?: Map<string, string> }): JSX.Element;      // skeleton (6) | ErrorState + retry | empty | grid/list | 'Load more'
export function InstructionsEditor(p: { project: Project }): JSX.Element;
// pages
export function ProjectPage(): JSX.Element; export function AllArtifactsPage(): JSX.Element; export function SearchPage(): JSX.Element;
export function ArtifactPage(): JSX.Element;      // M8 replaces it with the review viewer; the shell shows the rail on /a/*
export function NotFoundPage(): JSX.Element;
```

  **Cards (grid).** The grid is `repeat(auto-fill, minmax(220px, 1fr))` with gap 16. Each card shows:
  - the thumbnail;
  - the name, in one line truncated, with a `title` attribute;
  - a meta line: `v{current_version.number}` · relative `updated_at`;
  - t('web.artifact.comments', { count }) with a MessageSquare icon when `open_thread_count > 0`;
  - `Badge` t('web.artifact.shared') with a Link icon when `share_link_count > 0`.

  Members-only is the default, so it gets no badge. Hover lifts the border and the card shadow. The list view shows the same data in rows. All artifacts and search rows add the project name.

  **Project page.**
  - **Header.** `PageHeader` with the name, the description t('web.project.summary', { count: artifact_count, time }), and actions: Upload (Task 7 wires it) and a menu with Rename, plus Archive or Unarchive (absent on the default project). Use the newest of `project.updated_at` and the first item's `updated_at` for `time`.
  - **Instructions box.** Then `InstructionsEditor`, then the toolbar with `ViewToggle`, then `ArtifactCollection`.
  - **Archived banner.** An archived project shows a banner with Unarchive.
  - **Empty state.** It offers Upload and "Connect an agent" (`/connect`).

  **`InstructionsEditor`.**
  - **Box.** `surface-muted`, labelled t('web.instructions.title') ("Instructions for agents") with the help text t('web.instructions.help') ("Agents read this over MCP before they publish to this project.").
  - **View mode.** `whitespace-pre-wrap`, clamped to 4 lines with "Show more".
  - **Edit mode.** An autosizing `Textarea` with a counter `n / 20,000`. Save with the button or mod+Enter; Cancel with the button or Escape.
  - **Errors.** Failures appear inline, verbatim.

  **Other pages.**
  - **Search page.** `/search?q=` has an input prefilled with `q` (Enter updates the URL), the heading t('web.search.resultsFor', { q }), and `useArtifacts({ q })`.
  - **All artifacts.** `/` shows `useArtifacts({})`.
  - **Artifact page stub.** It shows a breadcrumb (project / artifact), the version, a large `ArtifactThumb` `hero`, and an "Open page" link to `/a/:id/raw` or `/a/:id/v/:n/raw`. Its errors (404, 410) show the server message.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.** This is the product's main screen. Make the grid, cards and generated cards look deliberate in both themes, with real-looking artifacts and absurd ones (very long names, no thumbnail, light and dark theme colors).
- [ ] **Step 2: Write the failing tests.** `colors.test.ts`:

```ts
test('parses the theme colors the server accepts', () => {
  expect(parseColor('#0ea5e9')).toEqual({ r: 14, g: 165, b: 233 }); expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3 }); expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0 });
  for (const bad of ['rebeccapurple', 'red;background:url(x)', 'rgb(1,2)', '', null]) expect(parseColor(bad)).toBeNull();
});
test('generated cards use only computed colors and readable text', () => {
  const dark = generatedCardColors('art_1', '#111111'); expect(dark.foreground).toBe('#ffffff');
  expect(generatedCardColors('art_1', '#fafafa').foreground).toBe('#0d0d0d');
  const a = generatedCardColors('art_1', 'url(x)'); expect(a).toEqual(generatedCardColors('art_1', null));   // deterministic fallback
  for (const v of Object.values(a)) expect(v).toMatch(/^(rgb\(\d+ \d+ \d+\)|#0d0d0d|#ffffff)$/);
});
```

  `library.test.tsx` and the page tests:

```ts
test('cards show thumbnail or generated card, version, comments and sharing', ...);
  // has_thumbnail → img src '/api/v1/artifacts/art_1/thumbnail?v=ver_1', alt ''; none → generated card containing the title;
  // open_thread_count 2 → '2 comments'; share_link_count 1 → 'Shared'; both fields absent → neither shown; the card link name is the artifact name
test('a thumbnail that fails to load falls back to the generated card', ...);   // fireEvent.error(img)
test('long and markup-like names render as text', ...);
  // name '<img src=x onerror=alert(1)>' + 'x'.repeat(300) → that text is in the document; no img with src 'x'
test('grid or list is remembered per user', ...);   // 'List' → 'pinwall:library-view:usr_1' = 'list'; remount → list; me usr_2 → grid
test('view toggle survives a throwing localStorage', ...);   // Review Focus 5: getItem/setItem throw → grid renders; toggling to list works in memory
test('collections have skeleton, empty and error states and load more', ...);
  // delayed → status t('web.library.loading'); [] → empty node; 500 → ErrorState + retry; next_cursor 'c2' → 'Load more' → GET ?cursor=c2 → items appended
// project-page.test.tsx
test('project page shows title, counts and instructions', ...);   // 'Launch site', '3 artifacts · updated 2 hours ago', instructions text
test('instructions edit inline: mod+Enter saves, Escape cancels', ...);
  // PATCH /projects/prj_2 body { instructions: 'Dùng tiếng Việt' }; Escape restores the old text, no request; 20_001 chars → counter shows the
  // overflow and Save is disabled; 400 message → shown verbatim
test('rename and archive from the project menu', ...);   // PATCH { name: 'New' }; PATCH { archived: true } → banner + 'Unarchive'; default project: no 'Archive'
test('an empty project offers upload and connecting an agent', ...);
// search-page.test.tsx
test('search queries the server with the term as typed', ...);   // /search?q=chup%20anh → GET /artifacts?q=chup+anh&limit=48; heading 'Results for “chup anh”'; [] → t('web.search.empty', { q })
test('all artifacts lists everything with project names in list view', ...);
// artifact-page.test.tsx
test('the artifact page shows the rail and a link to the raw page', ...);   // breadcrumb 'Launch site' / 'Pricing'; link href '/a/art_1/raw'; /a/art_1/v/2 → '/a/art_1/v/2/raw'
test('a deleted artifact shows the server message', ...);   // 410 'This artifact was deleted.'
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/library src/pages`. Expected: FAIL.
- [ ] **Step 4: Implement.** Add the en.json keys under `web.library.*`, `web.project.*`, `web.instructions.*`, `web.artifact.*` and `web.search.*`. Plurals use `_one`/`_other`, e.g. `"web.project.artifacts_one": "{{count}} artifact"`.
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Visual check** of the project page, All artifacts, search and the artifact page at 360, 768 and 1280 px, light and dark, in grid and list view.
- [ ] **Step 7: Commit** `feat(web): add project page with agent instructions, artifact grid and list, all artifacts, search and artifact route`.

### Task 7: Upload — drop, pick, progress, verbatim errors (model: opus)

**Files:**
- Create: `apps/web/src/lib/upload/{collect.ts,send.ts}`, `apps/web/src/library/upload/{use-upload.tsx,drop-overlay.tsx,upload-dialog.tsx,upload-toast.tsx}`, `apps/web/src/test/fake-entries.ts`
- Modify: `apps/web/src/pages/{project-page.tsx,all-artifacts-page.tsx}` (Upload button, overlay, empty state), `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/lib/upload/{collect,send}.test.ts`, `apps/web/src/library/upload/upload.test.tsx`

**Interfaces:**
- Consumes: shared `PublishTargetInput`, `PublishResult`, `PublicConfig`; Task 3 `errorFromBody`, `notifyUnauthorized`, `errorMessage`, `formatBytes`; Task 6 `getArtifact`, `qk`.
- Produces:

```ts
// lib/upload/collect.ts
export interface UploadFile { path: string; file: File }
export type UploadSelection = { kind: 'archive'; file: File } | { kind: 'files'; files: UploadFile[] };
export const ARCHIVE_NAME = /\.(zip|tar|tgz|tar\.gz)$/i;
export function collectFromDataTransfer(dt: DataTransfer): Promise<UploadSelection | null>;
  // calls webkitGetAsEntry() on every item synchronously, before the first await; folders walked recursively,
  // readEntries() repeated until it returns []; one lone archive file → archive; else files with 'folder/sub/name' paths
export function collectFromFileList(list: FileList | File[], o: { folder: boolean }): UploadSelection | null;   // folder → webkitRelativePath
export function selectionStats(s: UploadSelection): { bytes: number; files: number; label: string };   // label: archive name, top folder, or first file (+ t('web.upload.andMore', { count }))
export function checkSelection(s: UploadSelection, limits: PublicConfig['limits'], t: TFunction): string | null;
  // files 0 → t('web.upload.empty'); bytes > max_upload_bytes → t('web.upload.tooLarge', { size, max }) (formatBytes);
  // files > max_files → t('web.upload.tooManyFiles', { max })
// lib/upload/send.ts
export interface UploadProgress { phase: 'uploading' | 'processing'; loaded: number; total: number }
export function buildUploadForm(target: PublishTargetInput, s: UploadSelection): FormData;
  // 'target' = JSON.stringify(target) first; files: per file a 'path' field then a 'file' part (filename = basename); archive: one 'file' part, no 'path'
export function sendUpload(form: FormData, o: { onProgress?(p: UploadProgress): void; signal?: AbortSignal }): Promise<PublishResult>;
  // XMLHttpRequest POST /api/v1/publish/upload, Accept application/json, no manual Content-Type; upload.onprogress → 'uploading';
  // upload load → 'processing'; 201 → PublishResult.parse; else errorFromBody(status, responseText) + notifyUnauthorized; abort → ApiError(0, 'aborted', '')
// library/upload
export function useUpload(target: { projectId: string | null; projectName: string; disabled?: boolean }):
  { start(s: UploadSelection): void; pick(kind: 'files' | 'folder'): void; inputs: ReactNode };
  // one persistent sonner toast per upload (UploadToast: label, progress bar role="progressbar", Cancel);
  // success → getArtifact(result.artifact_id) for the name (PublishResult has none; selection label if that fails), then
  //   toast t('web.upload.published', { name, number }) with an 'Open' action to /a/:id; non-empty result.warnings → the toast
  //   also shows warnings[0].message and t('web.upload.moreWarnings', { count }); invalidates artifacts, project, projects, recent;
  // failure → error toast with errorMessage(e) verbatim (role alert), no auto-dismiss; pre-check failures never send a request
export function DropOverlay(p: { label: string; disabled?: boolean; onSelection(s: UploadSelection): void }): JSX.Element;
  // window drag listeners while mounted; shows only when dataTransfer.types includes 'Files'; t('web.upload.dropHere', { project })
export function UploadDialog(p: { open: boolean; onOpenChange(o: boolean): void; upload: ReturnType<typeof useUpload> }): JSX.Element;
  // a dropzone plus 'Choose files or an archive' and 'Choose a folder'; closes when a selection starts
```

  The target is `{ project_id }` on a project page and `{}` (the default project) on All artifacts. In an archived project, upload is disabled and its tooltip is t('project.archived').

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill** (the overlay, dialog and toast).
- [ ] **Step 2: Write the failing tests.** `test/fake-entries.ts` builds fake `FileSystemFileEntry`/`DirectoryEntry` trees and DataTransfers. `collect.test.ts`:

```ts
test.each(['site.zip', 'site.tar', 'site.tgz', 'site.tar.gz', 'SITE.ZIP'])('a lone %s is sent as an archive', ...);
test('loose files keep their names; a dropped folder keeps relative paths', ...);
  // files a.html, b.css → paths ['a.html', 'b.css']; folder site/{index.html, css/a.css} → ['site/css/a.css', 'site/index.html'] (sorted)
test('reads every entry of a large folder', async () => {   // Review Focus 1
  const dt = fakeDrop([dir('big', Array.from({ length: 250 }, (_, i) => file(`f${i}.txt`)))], { batch: 100 });
  const s = await collectFromDataTransfer(dt);
  expect(s?.kind === 'files' && s.files.length).toBe(250);
});
test('takes every entry before the drop event ends', async () => {   // Review Focus 1
  // fakeDrop whose items return null from webkitGetAsEntry once a microtask has passed → all 3 dropped folders still collected
});
test('a folder input uses webkitRelativePath', ...);
test('checkSelection enforces the public limits', ...);
  // limits max_upload_bytes 95_000_000: 96 MB → t('web.upload.tooLarge', { size: '96 MB', max: '95 MB' }); max_files 2 with 3 files → tooManyFiles; empty folder → empty
test('buildUploadForm orders target, then path before each file', () => {
  const f = buildUploadForm({ project_id: 'prj_1' }, { kind: 'files', files: [{ path: 'site/index.html', file: html }, { path: 'site/a.css', file: css }] });
  expect([...f.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : (v as File).name])).toEqual([
    ['target', '{"project_id":"prj_1"}'], ['path', 'site/index.html'], ['file', 'index.html'], ['path', 'site/a.css'], ['file', 'a.css']]);
  // archive → [['target', '{}'], ['file', 'site.zip']]
});
```

  `send.test.ts` runs against MSW handlers for `POST ${API}/publish/upload`:

```ts
test('uploads and returns the published version', ...);   // 201 PublishResult → parsed; onProgress saw phase 'processing'; request multipart has 'target'
test('server errors come back verbatim', ...);
  // 400 { error: { code: 'bad_request', message: '../x: path segments "." and ".." are not allowed.', details: { reason: 'dot_segment' } } }
  // → ApiError code 'bad_request', the exact message, details.reason 'dot_segment'
test('a proxy 413 page gets a clear message', ...);   // Review Focus 2: 413 text/html → errorMessage = t('web.error.tooLarge')
test('cancel aborts the request', ...);               // AbortController.abort() while delayed → code 'aborted'
test('a 401 sends the user to sign in', ...);         // unauthorized → handler called
```

  `upload.test.tsx`:

```ts
test('dropping a folder on the project page publishes into that project', ...);
  // drop fake folder 'site' → POST with target {"project_id":"prj_2"} → toast 'Published “E2E Site” v1' with 'Open' → /a/art_9;
  // the artifacts list refetches and shows the new card
test('the overlay appears only for file drags', ...);   // dragenter with types ['text/plain'] → no overlay; ['Files'] → t('web.upload.dropHere', { project: 'Launch site' })
test('a selection over the limit is refused without a request', ...);
test('a failed upload keeps its message until dismissed', ...);   // 400 → error toast with the message; still present after 10 s of fake timers
test('publish warnings are shown with the result', ...);   // warnings [{ code: 'root_absolute_url', message: 'index.html refers to /x.css …' }] → that text in the success toast
test('upload is disabled in an archived project', ...);
test('the dialog picks files or a folder', ...);   // 'Choose a folder' → the hidden input has the webkitdirectory attribute; change → upload starts
test('All artifacts publishes to the default project', ...);   // target '{}'
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/lib/upload src/library/upload`. Expected: FAIL.
- [ ] **Step 4: Implement.** Copy for the en.json keys:
  - `"web.upload.tooLarge": "This upload is {{size}}, over this Pinwall's limit of {{max}} per upload."`
  - `"web.upload.tooManyFiles": "This upload has more than {{max}} files, this Pinwall's limit."`
  - `"web.upload.empty": "Nothing to upload: the selection has no files."`
  - `"web.upload.published": "Published “{{name}}” v{{number}}"`
  - `"web.upload.dropHere": "Drop to publish to {{project}}"`
  - `"web.upload.hint": "A file, a folder, or a .zip / .tar.gz archive"`
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Visual check.** Drag a real folder of about 300 files and a zip onto the project page in Chrome and Safari against a local server. Both publish, and the toast shows progress, then the result.
- [ ] **Step 7: Commit** `feat(web): add drag-and-drop and picker upload of files, folders and archives with progress`.

---

## M7a done when

- `pnpm lint && pnpm typecheck && pnpm test` pass, with every component and page test of Tasks 1–7 green.
- `pnpm --filter @pinwall/web build` succeeds.
- The Review Focus tests owned by Tasks 1–7 pass (items 1, 2, 3 and 5, and Task 4's part of item 4).
- `pnpm why -r zod` lists one version.
