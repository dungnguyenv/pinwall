# Pinwall M7b — Web App: Settings, Connect, Consent, Admin, End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The second half of the M7 React SPA. M7b (Tasks 8–12) builds:
- settings: profile, password, passkeys, and API tokens with the secret shown once;
- the connect-an-agent page and the OAuth consent page;
- the admin configuration API and the admin pages (users with role override and Revoke now; effective configuration with both isolation modes explained);
- the Playwright walk setup → sign-in → project → folder upload → grid, with an accessibility smoke check.

**Architecture:** M7b builds on M7a's primitives, API client, guards, shell and library. Read M7a's "Interface handed to M7b"; task numbers continue from M7a. Each page gets its own `api/<resource>.ts` module and its routes in `app/routes.tsx`. The one server addition, `GET /api/v1/admin/config` (Task 10), describes the effective `Config` by env var name and never includes a secret. The consent DTOs go into `@pinwall/shared`, where M6 serves them later.

**Tech Stack:** As M7a, plus `@axe-core/playwright` for the accessibility smoke check, and Hono + `@hono/zod-openapi` for Task 10.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md`. The sections that matter here:
- §3.1: env vars are the only source of infrastructure settings; the admin UI shows and explains them.
- §3.2: API tokens, Revoke now, MCP OAuth.
- §3.3: admin settings explain the isolation trade-off.
- §3.11: the connect page.
- §4.

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`. Its Routes table, with the consent API and `GET /api/v1/admin/config`, and its Global Constraints apply.

**Depends on:**
- **M7a** (`2026-11-10-pinwall-m7a-web-shell.md`, Tasks 1–7), committed on the M7 branch.
- **M2:** `/me` account routes, tokens, passkeys, admin users and Revoke now.
- **M1:** `Config` and `loadConfig`.

Where merged code differs in a name or signature, the code wins: change the import and keep the behavior.

**Worktree:** the same worktree, branch and file allowance as M7a.

## Global Constraints

M7a's Global Constraints and its Design tokens table apply verbatim to every task here; copy them into each implementer brief. The ones these tasks lean on most:
- **Lists and states.** Every list has a loading skeleton, an empty state, and an error state with Retry.
- **Accessibility.** Every control has an accessible name and a visible focus ring; target WCAG 2.1 AA in both themes; the layout works from 360 px up.
- **Strings.** Every visible string goes through `t()` with `web.*` keys in one block of `en.json`, and server messages are shown verbatim.
- **Secrets.** The API token secret appears once, in its dialog, and never enters the query cache. `GET /api/v1/admin/config` never returns a secret value.
- **Dependencies.** `@axe-core/playwright` and `axe-core` are MPL-2.0, test-only and never shipped, so the roadmap's build-time MPL clause allows them.

## Review Focus

M7a's Review Focus covers all of M7. M7b owns the end-to-end part of item 4 (a 360 px phone) → Task 12 `main pages have no accessibility violations`, which asserts no axe violations and `scrollWidth <= innerWidth` at 360 px.

---

### Task 8: Settings — profile, password, passkeys, API tokens (model: sonnet)

**Files:**
- Create: `apps/web/src/api/account.ts`, `apps/web/src/pages/settings/{settings-layout.tsx,profile-page.tsx,security-page.tsx,tokens-page.tsx}`
- Modify: `apps/web/src/app/routes.tsx` (`settings` → index redirects to `profile`; `security` inside `RequireOwner fallback="/settings/profile"`), `apps/web/src/api/keys.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/pages/settings/{profile,security,tokens}.test.tsx`

**Interfaces:**
- Consumes: shared `UpdateProfileRequest`, `ChangePasswordRequest`, `Passkey`, `PasskeyList`, `AddPasskeyRequest`, `ApiToken`, `ApiTokenList`, `CreateApiTokenRequest`, `CreatedApiToken`, `CeremonyOptions`; Task 5 `createPasskey`, `isPasskeyCancelled`, `passkeysUsable`, `passwordProblem`; Task 1 `CopyField`, `ConfirmDialog`.
- Produces:

```ts
export function updateProfile(body: UpdateProfileRequest): Promise<Me>;              // PATCH /me
export function changePassword(body: ChangePasswordRequest): Promise<void>;          // PUT /me/password
export function removePassword(): Promise<void>;                                     // DELETE /me/password
export function listPasskeys(): Promise<PasskeyList>; export function addPasskeyOptions(): Promise<CeremonyOptions>;
export function addPasskey(body: AddPasskeyRequest): Promise<Passkey>;
export function renamePasskey(id: string, name: string): Promise<Passkey>; export function deletePasskey(id: string): Promise<void>;
export function listTokens(): Promise<ApiTokenList>; export function createToken(body: CreateApiTokenRequest): Promise<CreatedApiToken>;
export function revokeToken(id: string): Promise<void>;
export const TOKEN_EXPIRY_CHOICES = [30, 90, 365, null] as const;                    // default 90; null = never
// qk adds: passkeys, tokens. The token secret is never put in the query cache.
```

  **Layout.** Settings has a sub-nav (vertical at ≥ 768 px, horizontal pills on phones) with Profile, Security (owners only) and API tokens.
  - **Profile.** Owners edit name and email; an emptied email is sent as `null`. OIDC users see their details read-only, with t('web.profile.managedBy', { idp }).
  - **Security, Password card.** With a password: current, new and confirm fields; after success, the toast t('web.security.passwordChanged') ("Password changed. Your other sessions were signed out."). Without one: "Add a password" with new and confirm only. "Remove password" appears when passkeys ≥ 1, and a 409 shows verbatim.
  - **Security, Passkeys card.** A list with name, created and last used, plus Add, Rename (dialog) and Delete (confirm). Each list has its skeleton, empty and error states. When passkeys are unusable, Add is disabled and t('auth.passkeysUnavailable') explains why.
  - **API tokens.** A list with name, prefix (mono, `pw_…`), created, last used and expiry. Create opens a dialog with name and expiry. Its result step shows a `CopyField` with the secret and t('web.tokens.secretOnce'). "Done" closes the dialog and drops the secret. Revoke asks for confirmation. The empty state points agents to `/connect`.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.**
- [ ] **Step 2: Write the failing tests:**

```ts
test('the owner saves name and email', ...);         // PATCH /me { name: 'Ada L.', email: null } → toast t('web.profile.saved')
test('an SSO user sees read-only details and no Security tab', ...);   // kind 'oidc' → no 'Security' link; /settings/security → /settings/profile
test('change password sends current and new', ...);  // PUT /me/password { current_password: 'old password 1', new_password: 'new password 12' }; 401 'Wrong password.' → verbatim
test('a passkey-only owner adds a password without a current one', ...);   // body { new_password } only
test('removing the last credential shows the server refusal', ...);        // 409 'You cannot remove your last way to sign in. …' → verbatim
test('passkeys: add, rename, delete', ...);
  // POST /me/passkeys/options → createPasskey → POST /me/passkeys { ceremony_id: 'c1', response, name: 'Work laptop' }; rename → PATCH { name };
  // delete → confirm → DELETE; a cancelled prompt → t('web.passkey.cancelled'), no POST
test('the token secret is shown once', async () => {
  // create { name: 'ci', expires_in_days: 90 } → CopyField shows 'pw_…'; t('web.tokens.secretOnce') visible
  // 'Done' → queryByText(secret) null; list refetched shows prefix 'pw_abcdefgh'
});
test('a token without expiry sends null', ...);       // 'No expiry' → expires_in_days null
test('revoking a token asks first', ...);             // cancel → no request; confirm → DELETE /me/tokens/tok_1
test('settings lists have loading, empty and error states', ...);
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/pages/settings`. Expected: FAIL.
- [ ] **Step 4: Implement.** en.json: `"web.tokens.secretOnce": "Copy this token now. Pinwall keeps only a hash of it, so you will not see it again."`, plus the `web.settings.*`, `web.profile.*`, `web.security.*` and `web.tokens.*` keys.
- [ ] **Step 5: Run** the Step 3 command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): add settings for profile, password, passkeys and API tokens`.

### Task 9: Connect-an-agent page and OAuth consent page (model: opus)

**Files:**
- Create: `packages/shared/src/api/oauth-consent.ts`, `apps/web/src/api/oauth.ts`, `apps/web/src/pages/oauth/consent-page.tsx`, `apps/web/src/pages/connect/{connect-page.tsx,snippets.ts,skill.ts}`
- Modify: `packages/shared/src/api/index.ts` (one export line), `apps/web/src/app/routes.tsx` (`connect` in the shell; `oauth/consent` inside `RequireAuth` without the shell), `apps/web/src/api/keys.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/pages/oauth/consent-page.test.tsx`, `apps/web/src/pages/connect/connect-page.test.tsx`

**Interfaces:**
- Consumes: the roadmap's consent API contract; Task 1 `CopyField`, `Tabs`; Task 3 `browser`, `signInPath`, `useSignOut`.
- Produces:

```ts
// packages/shared/src/api/oauth-consent.ts — M6's routes must use these
export const OAuthConsentRequest = z.object({ client_name: z.string(), client_uri: z.string().nullable(), redirect_host: z.string(),
  scopes: z.array(z.string()), user: z.object({ name: z.string(), email: z.string().nullable() }) });
export const OAuthDecisionRequest = z.object({ approve: z.boolean() });
export const OAuthDecisionResult = z.object({ redirect_to: z.string() });
// api/oauth.ts
export function getConsentRequest(id: string): Promise<OAuthConsentRequest>;       // GET /oauth/requests/{id}; qk adds consent(id)
export function decideConsent(id: string, approve: boolean): Promise<OAuthDecisionResult>;   // POST /oauth/requests/{id}/decision
// pages/connect/snippets.ts
export function connectSnippets(origin: string): { mcpUrl: string; claudeCode: string; cursor: string; codex: string };
// pages/connect/skill.ts
export const skillText: string | null;
  // import.meta.glob('../../../../../skills/pinwall/SKILL.md', { query: '?raw', import: 'default', eager: true }) → the text, or null before M6 adds it
```

  **Consent page** (`/oauth/consent?request=<id>`):
  - **Layout.** A centered card without the shell. It says t('web.consent.title', { client }) ("{{client}} wants to connect to your Pinwall"), then the generic access line t('web.consent.access'). There are no fine-grained scopes in v1, so each raw scope also appears as a mono chip.
  - **Return host.** The prominent line is t('web.consent.returnsTo', { host: redirect_host }) ("After you choose, you go back to {{host}}"). `client_uri` is shown as plain text, never as a link.
  - **Identity.** "Signed in as {{name}} ({{email}})", with "Not you?". That signs out, then goes to `signInPath(currentConsentUrl)`.
  - **Buttons.** "Deny" (secondary) and "Allow" (primary), neither auto-focused. Both are disabled once one is pressed, and the decision is followed by `browser.assign(redirect_to)`.
  - **Errors.** A 404 or 410 shows the server message verbatim, plus t('web.consent.restart').

  **Connect page** (`/connect`): `origin = window.location.origin`, because the SPA only works at the public origin.
  - **Client tabs.** Claude Code, Cursor, Codex, Other. Each tab has `CopyField`s and one or two lines of guidance.
  - **Skill section.** Shown only when `skillText` exists: a "Download SKILL.md" button (Blob URL with `download`) and the copyable command `mkdir -p ~/.claude/skills/pinwall && mv ~/Downloads/SKILL.md ~/.claude/skills/pinwall/`.
  - **Scripts.** A link to `/settings/tokens` for scripts and clients without OAuth.

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.** Check the Cursor and Codex MCP configuration syntax against their current public docs. Adjust the snippet shapes if they changed, and keep the URL `<origin>/mcp`.
- [ ] **Step 2: Write the failing tests:**

```ts
// connect-page.test.tsx (jsdom origin http://localhost:3000)
test('snippets use this Pinwall address', () => {
  const s = connectSnippets('https://pinwall.example');
  expect(s.claudeCode).toBe('claude mcp add --transport http pinwall https://pinwall.example/mcp');
  expect(JSON.parse(s.cursor)).toEqual({ mcpServers: { pinwall: { url: 'https://pinwall.example/mcp' } } });
  expect(s.codex).toContain('[mcp_servers.pinwall]'); expect(s.codex).toContain('url = "https://pinwall.example/mcp"');
});
test('the page shows each client with copyable snippets', ...);   // tab 'Cursor' → '~/.cursor/mcp.json' and the JSON
test('the skill section appears only when the skill is bundled', ...);   // vi.mock('./skill.ts') null → no 'Download SKILL.md'; text → button
// consent-page.test.tsx
test('shows who asks, where it returns and as whom', ...);
  // GET /oauth/requests/req_1 → { client_name: 'Claude Code', client_uri: null, redirect_host: 'localhost:33418', scopes: ['mcp'], user: { name: 'Ada', email: 'ada@example.com' } }
  // → title 'Claude Code wants to connect to your Pinwall', 'After you choose, you go back to localhost:33418', 'Ada (ada@example.com)'
test('client name and uri are shown as text', ...);   // client_name '<b>Pinwall</b> Official', client_uri 'javascript:alert(1)' → literal text; no <b>; no link
test('allow and deny post the decision and follow redirect_to', ...);
  // Allow → POST body { approve: true } → browser.assign('http://localhost:33418/callback?code=x'); Deny → { approve: false }; double click → one POST
test('an expired request shows the server message', ...);   // 404 'This authorization request has expired.' → verbatim + t('web.consent.restart')
test('a signed-out visitor signs in first and comes back', ...);   // me null → /signin?return_to=%2Foauth%2Fconsent%3Frequest%3Dreq_1
test('not you? signs out and returns here after sign-in', ...);
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/pages/oauth src/pages/connect`. Expected: FAIL.
- [ ] **Step 4: Implement.** en.json: `"web.consent.access": "It will act as you in Pinwall: read projects, artifacts and comments, publish new versions, reply to and resolve comments, and manage share links."`, `"web.consent.restart": "Start the connection again from your agent."`, plus the `web.connect.*` keys.
- [ ] **Step 5: Run** the Step 3 command, then `pnpm --filter @pinwall/shared test` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): add connect-an-agent page and OAuth consent page with shared consent DTOs`.

### Task 10: Admin configuration API (server) (model: opus)

**Files:**
- Create: `packages/shared/src/api/admin-config.ts`, `apps/server/src/api/admin-config.ts`
- Modify: `packages/shared/src/api/index.ts` (one export line), `apps/server/src/api/router.ts` (one `registerAdminConfigRoutes(api)` line)
- Test: `apps/server/test/api/admin-config.test.ts`

**Interfaces:**
- Consumes: M1 `Config`, `loadConfig`, `createTestContext`; M2 `requireAdmin`, `createSignedInUser`, `apiInit`, `registerXRoutes` convention.
- Produces:

```ts
// shared
export const ConfigSection = z.enum(['general', 'isolation', 'database', 'storage', 'sign_in', 'access', 'limits', 'lifetimes']);
export const ConfigEntry = z.object({ section: ConfigSection, env: z.string(), value: z.string().nullable(), secret: z.boolean(), set: z.boolean() });
  // value: display text; null = not set. Secrets: value always null, set says whether it is configured.
export const AdminConfig = z.object({ isolation: z.enum(['single-domain', 'content-domain']), content_origin: z.string().nullable(),
  entries: z.array(ConfigEntry), warnings: z.array(z.string()) });
// server api/admin-config.ts
export function redactUrl(url: string): string;          // `${protocol}//${username ? username + '@' : ''}${host}${pathname}`; password, query, fragment dropped
export function formatDuration(ms: number): string;      // largest exact unit of d, h, m, s; else `${ms}ms`
export function describeConfig(config: Config): AdminConfig;
export function registerAdminConfigRoutes(api: OpenAPIHono<AppEnv>): void;   // GET /admin/config, requireAdmin → 200 AdminConfig
```

  **Entries** come in roadmap Configuration-table order. Each `env` name is the variable that sets it; secrets are marked with ★.
  - **general:** `PINWALL_PUBLIC_ORIGIN`, `PINWALL_HOST`, `PINWALL_PORT`, `PINWALL_DATA_DIR`, `PINWALL_TRUST_PROXY` (`false`, `true`, or the CIDRs joined by `, `), `PINWALL_WEB_DIR`, `PINWALL_LOG_LEVEL`, `PINWALL_METRICS_PORT`, and `PINWALL_SECRET_KEY` ★ (`set: true`).
  - **isolation:** `PINWALL_ISOLATION`, `PINWALL_CONTENT_ORIGIN`.
  - **database:** `PINWALL_DATABASE_URL` (`sqlite:<path>`, or `redactUrl` for postgres), `PINWALL_DATABASE_POOL_SIZE` (postgres only, else null).
  - **storage:** `PINWALL_STORAGE`; for s3 also `PINWALL_S3_BUCKET`, `_REGION`, `_ENDPOINT` (redacted), `_FORCE_PATH_STYLE`, `_PREFIX`, `_ACCESS_KEY_ID` ★, `_SECRET_ACCESS_KEY` ★.
  - **sign_in:** `PINWALL_OIDC_ISSUER` (redacted), `PINWALL_OIDC_CLIENT_ID`, `PINWALL_OIDC_CLIENT_SECRET` ★, `PINWALL_OIDC_SCOPES` (space-joined), `PINWALL_OIDC_DISPLAY_NAME`, `PINWALL_OIDC_EXTRA_AUTH_PARAMS` (`k=v&k=v`).
  - **access:** `PINWALL_OIDC_ROLES_CLAIM`, `PINWALL_OIDC_ADMIN_GROUPS`, `PINWALL_OIDC_MEMBER_GROUPS`, `PINWALL_ADMIN_EMAILS`, `PINWALL_MEMBER_EMAILS`, `PINWALL_MEMBER_DOMAINS` (lists comma-joined; empty → null), `PINWALL_ACCESS_RECHECK_INTERVAL`.
  - **limits:** the six `PINWALL_MAX_*`, as byte or count strings.
  - **lifetimes:** `PINWALL_SESSION_TTL`, `PINWALL_PREVIEW_TTL`, `PINWALL_UPLOAD_SESSION_TTL`.

  With OIDC off, the sign_in entries other than the client secret have `value: null`.

- [ ] **Step 1: Write the failing tests** (`entry(d, env)` finds one entry):

```ts
test('secrets never appear in the description', () => {
  const c = loadConfig({ PINWALL_DATA_DIR: '/tmp/pw',
    PINWALL_DATABASE_URL: 'postgres://pw:db-pass-123@db:5432/pinwall?sslmode=require&password=q-pass-456',
    PINWALL_STORAGE: 's3', PINWALL_S3_BUCKET: 'b', PINWALL_S3_ACCESS_KEY_ID: 'AKIA-key-789', PINWALL_S3_SECRET_ACCESS_KEY: 's3-secret-000',
    PINWALL_OIDC_ISSUER: 'https://idp.example', PINWALL_OIDC_CLIENT_ID: 'pinwall', PINWALL_OIDC_CLIENT_SECRET: 'oidc-secret-222',
    PINWALL_SECRET_KEY: 'ab'.repeat(32) });
  const d = describeConfig(c); const json = JSON.stringify(d);
  for (const s of ['db-pass-123', 'q-pass-456', 'AKIA-key-789', 's3-secret-000', 'oidc-secret-222', 'ab'.repeat(32)]) expect(json).not.toContain(s);
  expect(entry(d, 'PINWALL_DATABASE_URL').value).toBe('postgres://pw@db:5432/pinwall');
  expect(entry(d, 'PINWALL_S3_SECRET_ACCESS_KEY')).toEqual({ section: 'storage', env: 'PINWALL_S3_SECRET_ACCESS_KEY', value: null, secret: true, set: true });
  expect(entry(d, 'PINWALL_OIDC_CLIENT_SECRET')).toMatchObject({ value: null, secret: true, set: true });
  expect(entry(d, 'PINWALL_OIDC_CLIENT_ID').value).toBe('pinwall');
});
test('defaults read as environment values', () => {
  const d = describeConfig(loadConfig({ PINWALL_DATA_DIR: '/tmp/pw' }));
  expect(entry(d, 'PINWALL_ISOLATION').value).toBe('single-domain');
  expect(entry(d, 'PINWALL_DATABASE_URL').value).toBe('sqlite:/tmp/pw/pinwall.db');
  expect(entry(d, 'PINWALL_MAX_UPLOAD_BYTES').value).toBe('95000000');
  expect(entry(d, 'PINWALL_ACCESS_RECHECK_INTERVAL').value).toBe('12h');
  expect(entry(d, 'PINWALL_SESSION_TTL').value).toBe('30d');
  expect(entry(d, 'PINWALL_UPLOAD_SESSION_TTL').value).toBe('10m');
  expect(entry(d, 'PINWALL_OIDC_CLIENT_SECRET')).toMatchObject({ value: null, secret: true, set: false });
  expect(new Set(d.entries.map((e) => e.env)).size).toBe(d.entries.length);
  expect(AdminConfig.parse(d)).toEqual(d);
});
test('content-domain mode reports its origin and warnings', ...);
  // PINWALL_PUBLIC_ORIGIN https://pinwall.example.com, content-domain, PINWALL_CONTENT_ORIGIN https://content.example.com:8443 →
  // content_origin 'https://content.example.com:8443'; entry value the same; warnings mention 'registrable domain'
test('redactUrl and formatDuration', ...);   // 'https://u:p@minio.example:9000/x?a=1#f' → 'https://u@minio.example:9000/x'; 90_000 → '90s'; 1500 → '1500ms'
test('GET /admin/config is for admins only', ...);
  // owner cookie → 200, parses with AdminConfig; oidc member → 403 t('auth.adminOnly'); no auth → 401; listed in /api/v1/openapi.json
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/admin-config`. Expected: FAIL.
- [ ] **Step 3: Implement.** The value is always built from `Config`, never from `process.env`. A secret's `set` comes from the config field being defined.
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add admin configuration endpoint with effective settings and secrets redacted`.

### Task 11: Admin pages — users and configuration (model: sonnet)

**Files:**
- Create: `apps/web/src/api/admin.ts`, `apps/web/src/pages/admin/{admin-layout.tsx,users-page.tsx,config-page.tsx}`
- Modify: `apps/web/src/app/routes.tsx` (`admin` inside `RequireAdmin`; index → `users`), `apps/web/src/api/keys.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/web/src/pages/admin/{users,config}.test.tsx`

**Interfaces:**
- Consumes: shared `AdminUser`, `AdminUserList`, `SetRoleRequest`, `RevokeResult`, `AdminConfig`; Task 5 `IsolationExplainer`; Task 1 `Select`, `ConfirmDialog`, `Avatar`, `Badge`, `Tooltip`; Task 3 `formatBytes`, `useSignOut`.
- Produces:

```ts
export function listAdminUsers(p: { cursor?: string | null; limit?: number }): Promise<AdminUserList>;   // limit 50
export function setUserRole(id: string, role_override: SetRoleRequest['role_override']): Promise<AdminUser>;
export function revokeUser(id: string): Promise<RevokeResult>;
export function getAdminConfig(): Promise<AdminConfig>;
export const ROLE_OPTIONS = ['idp', 'admin', 'member', 'blocked'] as const;   // 'idp' ↔ role_override null (Radix Select has no empty value)
// qk adds: adminUsers, adminConfig
```

  **Users page.** At ≥ 768 px it is a table; below, stacked cards. Each row shows:
  - person: avatar, name, email (with a verified marker), and a kind badge ("Owner" / "SSO");
  - the effective role badge, which is `danger` for blocked;
  - the IdP role;
  - a `Select` override with t('web.admin.role.idp') ("Use identity provider role"), Admin, Member and Blocked;
  - last seen;
  - a status badge when `disabled_reason` is set (`idp_removed` → t('web.admin.status.idp_removed'));
  - the "Revoke now" button.

  On your own row the Select is disabled, with a Tooltip t('auth.ownRole'). "Revoke now" opens a `ConfirmDialog` with tone `danger`:
  - `"web.admin.revoke.body": "{{name}} is signed out of every browser at once, and their API tokens and agent connections stop working. They can sign in again if they still have access."`
  - your own row uses `"web.admin.revoke.selfBody": "You will be signed out everywhere, including here."`
  - on success, the toast `"web.admin.revoke.done": "Revoked {{sessions}} sessions, {{tokens}} API tokens and {{agents}} agent connections."`

  **Configuration page.**
  - **Intro.** t('web.config.envNote') ("These settings come from environment variables. Pinwall shows them but never changes them: edit your deployment and restart."), then the `IsolationExplainer` with the current mode, plus `content_origin` when set.
  - **Warnings.** `warnings` appear as warning callouts.
  - **Sections.** One per `ConfigSection` (t(`web.config.section.${s}`)), each a definition list. A row shows the env name (mono), the value (mono), and a one-sentence help line t(`web.config.help.${env}`), one key per env name. Values ending in `_BYTES` add `≈ formatBytes(n)`. A secret that is set shows a lock and t('web.config.secretSet') ("Set (hidden)"); an unset value shows t('web.config.notSet') ("Not set").

- [ ] **Step 1: Load the `frontend-design:frontend-design` skill.**
- [ ] **Step 2: Write the failing tests:**

```ts
test('users show effective role, kind, last seen and removal status', ...);   // owner 'admin' + 'Owner'; member; 'idp_removed' badge
test('the role override is saved, including back to the IdP role', ...);
  // select 'Blocked' → PUT /admin/users/usr_2/role { role_override: 'blocked' }; 'Use identity provider role' → { role_override: null }; 403 message verbatim
test('your own role cannot be changed', ...);   // own row Select disabled; focus shows t('auth.ownRole')
test('Revoke now asks, then reports what ended', ...);
  // cancel → no request; confirm → POST /admin/users/usr_2/revoke → { sessions: 2, api_tokens: 1, oauth_grants: 1 } → 'Revoked 2 sessions, 1 API tokens and 1 agent connections.'
test('revoking yourself signs you out', ...);   // own row → selfBody copy; success → /signin, cache cleared
test('the user list pages', ...);               // next_cursor → 'Load more' → ?cursor=
test('non-admins see the admin-only message and nothing is fetched', ...);   // role member → t('auth.adminOnly'); no request to /admin/users
test('configuration shows sections, values, hidden secrets and help', ...);
  // entry PINWALL_S3_SECRET_ACCESS_KEY secret set → 'Set (hidden)'; PINWALL_OIDC_ISSUER null → 'Not set';
  // PINWALL_MAX_UPLOAD_BYTES '95000000' → '≈ 95 MB'; each entry has its t(`web.config.help.${env}`) text
test('configuration explains both isolation modes and marks the current one', ...);
test('admin lists have loading and error states', ...);
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/web test src/pages/admin`. Expected: FAIL.
- [ ] **Step 4: Implement.** Add the en.json keys under `web.admin.*` and `web.config.*`. Write a `web.config.help.<ENV>` entry for every env name Task 10 lists, in one plain sentence each.
- [ ] **Step 5: Run** `pnpm --filter @pinwall/web test`, then `pnpm lint && pnpm typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): add admin users with role override and Revoke now, and the configuration view`.

### Task 12: End-to-end walk and accessibility smoke (model: sonnet)

**Files:**
- Create: `e2e/playwright.config.ts`, `e2e/support/{pinwall-server.ts,global-setup.ts,global-teardown.ts,site.ts}`, `e2e/web-shell.spec.ts`
- Modify: the root `package.json` (`"test:e2e": "pnpm --filter @pinwall/web build && playwright test -c e2e/playwright.config.ts"`; devDeps `@axe-core/playwright` and `axe-core`), `.gitignore` (`e2e/test-results/`, `e2e/report/`)

**Interfaces:**
- Consumes: everything above; M1 `main.ts serve`; M2's setup-link log line `{ setup_url }`.
- Produces:

```ts
// e2e/support/pinwall-server.ts
export interface RunningPinwall { origin: string; setupUrl: string; dataDir: string; stop(): Promise<void> }
export function startPinwall(o: { port: number }): Promise<RunningPinwall>;
  // temp PINWALL_DATA_DIR; spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'serve'], { cwd: 'apps/server', env: { PINWALL_DATA_DIR,
  //   PINWALL_WEB_DIR: <abs apps/web/dist>, PINWALL_PORT, PINWALL_PUBLIC_ORIGIN: `http://localhost:${port}`, PINWALL_METRICS_PORT: '0' } });
  // parses JSON log lines from stdout until it has both `setup_url` and the 'listening' line (30 s timeout; on failure throws with the log tail)
// e2e/support/site.ts
export function makeSite(dir: string): Promise<void>;
  // index.html with <title>E2E Site</title> and <meta property="og:image" content="img/cover.png">, style.css, img/cover.png (8×8 PNG from base64)
```

  Config: `workers: 1`, `fullyParallel: false`, the chromium project only, `baseURL = http://localhost:${PINWALL_E2E_PORT ?? 18087}`, `globalSetup` and `globalTeardown`. Global setup puts `PINWALL_E2E_SETUP_URL` into `process.env` for the workers.

- [ ] **Step 1: Write the spec** (`test.describe.configure({ mode: 'serial' })`; `axe(page)` = `new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()` with `violations` expected `[]`):

```ts
test('setup → sign-in → create project → upload a folder → see it in the grid', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await page.goto(process.env.PINWALL_E2E_SETUP_URL!); expect((await axe(page)).violations).toEqual([]);
  // name 'Ada', passkey on, password + confirm 'correct horse battery staple' → heading 'All artifacts', empty state
  // account menu → 'Sign out' → /signin; axe → []
  // password sign-in → '/'; 'New project' → name 'Launch site', instructions 'Use English. Brand color #4b56e3.' → heading 'Launch site'
  // 'Upload' → 'Choose a folder' → page.setInputFiles(folderInput, siteDir) → toast 'Published “E2E Site” v1'
  // a card 'E2E Site' showing 'v1'; its thumbnail img has naturalWidth > 0
  // 'List' view → reload → still list
  // sign out → 'Sign in with a passkey' → '/'
  // mod+K, 'e2e', Enter on the first result → /a/<id>, link 'Open page' href `/a/${id}/raw`
  // GET /favicon.svg → 200 image/svg+xml; GET /manifest.webmanifest → 200
});
test('main pages have no accessibility violations', async ({ page }) => {
  // sign in by password; for each viewport [1280×800, 360×740] and color scheme ['light', 'dark'] (page.emulateMedia):
  //   '/', '/projects/<id>', '/search?q=e2e', '/a/<id>', '/settings/profile', '/settings/security', '/settings/tokens', '/connect',
  //   '/admin/users', '/admin/config' → axe violations []; at 360: document.documentElement.scrollWidth <= window.innerWidth   (Review Focus 4)
  // on '/': Tab five times; each focused element has a non-'none' outline style (visible focus)
  // signed out: '/signin' → axe [] in both schemes
});
```

- [ ] **Step 2: Run** `pnpm exec playwright install chromium && pnpm test:e2e`. Expected: FAIL at the first screen that is missing or broken. Fix only through the task that owns that screen, then re-run.
- [ ] **Step 3: Implement** the support files and config. `globalTeardown` stops the server and removes the data dir, whatever the outcome.
- [ ] **Step 4: Run** `pnpm test:e2e`. Expected: 2 passed. Then run `pnpm lint && pnpm typecheck && pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** `test(e2e): walk setup, sign-in, project, folder upload and grid with an accessibility smoke check`.

---

## M7 done when (M7a and M7b together)

- `pnpm lint && pnpm typecheck && pnpm test` pass, with every web component and page test, and the server `admin-config` test, green.
- `pnpm test:e2e` passes. It walks setup → sign-in (password and passkey) → create project → folder upload → project grid. Axe finds no WCAG 2.1 AA violations on the main pages at 1280 and 360 px, in light and dark.
- Every Review Focus test passes.
- `pnpm why -r zod` lists one version, and no dependency outside the roadmap's license list was added.
