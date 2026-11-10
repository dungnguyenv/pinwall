# Pinwall M3 — OIDC, Roles, Access Re-check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign-in through any standards-compliant OIDC provider, with users created on first sign-in, roles mapped from a groups claim or from verified email and domain lists, an HTML "no access" page that shows who signed in and offers "Use a different account", the IdP refresh token stored encrypted, and an access re-check that cuts off people removed at the IdP within 24 hours on every credential.

**Architecture:** Everything new lives in `apps/server/src/auth/oidc/`. Pure policy code comes first: claims to identity, identity to role, and `return_to` checks. Then a per-`AppDeps` runtime that discovers the IdP once with `openid-client` v6. Two browser routes, `GET /auth/oidc/start` and `GET /auth/oidc/callback`, keep the pending login in M1's `OneTimeStore` and answer every failure with an HTML page. `recheckUser` runs a refresh-token grant plus userinfo for one user. It is single-flight per user and guarded by a DB lease. A `Scheduler` job runs it for every due user, and a gate inside M2's `resolveAuth` runs it inline for browser sessions and refuses credentials whose IdP check is too old.

**Tech Stack:** `openid-client` 6.8 (`discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`, `refreshTokenGrant`, `fetchUserInfo`, `ResponseBodyError`, `AuthorizationResponseError`), Hono 4 + `hono/jsx`, Kysely, `oidc-provider` 9.13 (test IdP only, devDependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` (§3.2 OIDC sign-in, Losing access, browser errors; §9 acceptance 3 and 3b).

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md`. It holds the Configuration table, Data model, Routes and Security model. Its Global Constraints apply to every task.

**Depends on:** M2 (`docs/superpowers/plans/2026-11-10-pinwall-m2-identity.md`) and, through it, M1. This plan uses their Interfaces blocks. Where the merged code differs in a name or signature, the code wins: change the import and keep the behavior. M1's `createDeps` is expected to put `ensureSecretKey`'s result into `config.secretKey`. If it keeps the key somewhere else, read it from there.

**Parallel work:** M3 runs on its own worktree alongside M4 and merges afterwards. Shared files get only small additive edits:
- `app.ts`: one `app.route` line.
- `en.json`: `oidc.*` keys only.
- M2's `auth/sessions.ts`: the `AuthMethod` union.
- M2's `auth/resolve.ts`: two gate calls.
- M2's `auth/startup.ts`: one `startOidc` call.

M3 adds no migration: `0001_initial` already has every `users` column it needs.

## Global Constraints

The roadmap's Global Constraints apply, plus these for M3:
- **Authorization request:** code flow only (`response_type=code`), PKCE `S256`, and fresh `state` and `nonce` (`randomState`, `randomNonce`, `randomPKCECodeVerifier`) on every start. `PINWALL_OIDC_EXTRA_AUTH_PARAMS` can never override `response_type`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge` or `code_challenge_method`.
- **Redirect URI** is exactly `publicUrl(config, '/auth/oidc/callback')`. The callback URL handed to `authorizationCodeGrant` is rebuilt from the public origin plus the request's query string, never from the request URL.
- **Pending login:** stored in `OneTimeStore` under `oidc:login:<hashSecret(state)>` with TTL `600_000` ms; taken once.
- **Browser binding cookie** (login-CSRF defense): `__Host-pinwall_oidc` on https, else `pinwall_oidc`. Attributes `HttpOnly; SameSite=Lax; Path=/; Max-Age=600`, plus `Secure` on https. The value is a `newSecret()`, reused while the browser holds a well-formed one. The pending login stores its `hashSecret`.
- **`return_to`** is a same-origin relative path, else `/`. It must start with a single `/`, contain no `\`, no control characters (`\x00-\x1f`, `\x7f`), be ≤ 2048 chars, not start with `/auth/oidc/`, and resolve against `PINWALL_PUBLIC_ORIGIN` to that same origin.
- **Browser failures are HTML.** Every response from `/auth/oidc/*` is a redirect or an HTML page (M1 `renderErrorPage`, or the no-access page), whatever the `Accept` header, with `Cache-Control: no-store`. IdP-supplied `error_description` text is never shown.
- **Identity key:** users are keyed by (`oidc_issuer` = discovered issuer, `oidc_subject` = `sub`). Accounts are never linked by email.
- **Roles:** follow the roadmap Configuration table exactly. Email rules count only when `email_verified` is `true` or the string `"true"`. Domain matches are exact and case-insensitive. Group matches are exact and case-sensitive. When no member group, email or domain is configured, every IdP identity is a member. `role_override` wins over the mapped role. It does not keep someone the IdP itself rejects (`invalid_grant`).
- **Refresh token:** stored only as `encryptString(deriveKey(secretKey, 'idp-refresh-token'), token)`. It is never logged and never returned by any API. A denied identity keeps none.
- **Re-check timing:**
  - Job `access-recheck` runs every `900_000` ms.
  - A user is due when `now - idp_checked_at >= PINWALL_ACCESS_RECHECK_INTERVAL`.
  - With a refresh token, access holds for at most `86_400_000` ms after the last successful check.
  - Without one, access holds only until the user is due.
  - An inline browser re-check waits at most `5_000` ms. After a transient failure, inline checks for that user pause for `60_000` ms.
- **Only `invalid_grant` or "no longer admitted" disables anyone:** set `disabled_at = now`, `disabled_reason = 'idp_removed'`, then call `revokeAllCredentials`. Network errors, timeouts, 5xx responses and other 4xx responses are transient: log them and retry. No provider-specific code (no Google Directory API, no `hd` claim, no Zitadel API).
- **Logs** never contain tokens, codes, `state`, the verifier, the nonce or email addresses. Log user ids.
- **Tests** run against the in-process `oidc-provider` on `127.0.0.1` with a random port; no request leaves the machine. DB-touching tests run inside `describe.each(dialects)`, with `clock = new FixedClock(Date.UTC(2026, 10, 10))`.
- **i18n:** every string a person reads goes through `t()`, with the exact copy each task gives. `{{idp}}` is always `config.oidc.displayName`.

## Review Focus

1. **Behind a TLS-terminating proxy.** The public origin is https, but requests arrive at `http://internal:8080`. Expected: the IdP gets `https://…/auth/oidc/callback` in both the authorization and the token request, and the session cookie is `__Host-` with `Secure`. → Task 4 `behind a TLS proxy the redirect URI and cookies use the public origin`.
2. **Rotating refresh tokens under parallel requests.** The SPA fires several API calls the moment a user falls due. Expected: exactly one refresh grant. A reused rotated token would get `invalid_grant` and wrongly disable the person. → Task 5 `concurrent re-checks of one user share one refresh`; Task 6 `parallel requests from a due session trigger one refresh`.
3. **IdP outage** (unreachable, slow, 5xx). Expected:
   - nobody is disabled;
   - requests are not slowed on every call;
   - access is refused 24 h after the last successful check;
   - access returns without admin action once the IdP is back.

   → Task 5 `an unreachable IdP is transient and changes nothing`, `an IdP 5xx is transient`. Task 6 `an unreachable IdP keeps access until 24 hours after the last successful check`, `access returns without admin action when the IdP is reachable again`, `an IdP outage does not slow every request`, `a slow IdP is cut off at the inline timeout`.
4. **Claim shapes real IdPs send.** Expected: these all map:
   - Zitadel's object-valued roles claim;
   - Keycloak's nested `realm_access.roles`;
   - URL-named claims such as `https://example.com/groups`;
   - `email_verified: "true"` as a string;
   - mixed-case emails;
   - HTML in a name, which is escaped on the page.

   → Task 1 identity tests; Task 4 `claims are escaped on the no-access page`; Task 7 parts A and B.
5. **Hostile `return_to` and login CSRF.** Inputs: `//evil`, `/\evil`, `/\t/evil`, `javascript:`, and a `return_to` that loops back to `/auth/oidc/start`. Also a callback replayed in a victim's browser. Expected: a redirect to `/`, and the callback refused without creating a session. → Task 1 `safeReturnTo` tests; Task 4 `return_to tricks fall back to /`, `a callback from another browser is refused`.

---

### Task 1: Identity claims, role mapping, `return_to` (model: opus)

**Files:**
- Create: `apps/server/src/auth/oidc/{identity.ts,policy.ts,return-to.ts}`
- Test: `apps/server/test/auth/oidc/{identity,policy,return-to}.test.ts`

**Interfaces:**
- Consumes: M1 `Config`; M2 `Role` (`auth/roles.ts`).
- Produces:

```ts
// identity.ts
export interface OidcIdentity {
  subject: string;
  email: string | null;        // trimmed, lowercased; null when absent, not an email (z.email()) or > 254 chars
  emailVerified: boolean;      // true only for true or "true"
  name: string;                // name → preferred_username → "given_name family_name" → email → subject; trimmed, cut to 200 chars
  avatarUrl: string | null;    // picture when an https: URL of ≤ 2048 chars
  groups: string[];
}
export function readClaim(claims: Record<string, unknown>, name: string): unknown;   // exact key first; else, if name has '.', walk the path
export function extractGroups(value: unknown): string[];   // string → [it]; array → its non-empty strings; plain object → its keys; deduped, order kept
export function identityFromClaims(claims: Record<string, unknown>, rolesClaim: string | undefined): OidcIdentity;  // throws Error without a string sub
// policy.ts
export interface AccessPolicy { adminGroups: string[]; memberGroups: string[]; adminEmails: string[]; memberEmails: string[]; memberDomains: string[] }
export function accessPolicy(config: Config): AccessPolicy;   // from config.oidc (groups) and config.access (emails, domains)
export function mapIdpRole(policy: AccessPolicy, id: Pick<OidcIdentity, 'email' | 'emailVerified' | 'groups'>): Role | null;
// return-to.ts
export function safeReturnTo(raw: string | null | undefined, publicOrigin: string): string;
```

- [ ] **Step 1: Write the failing tests.**

```ts
// identity.test.ts
test('reads a top-level claim, then a dotted path', () => {
  expect(readClaim({ groups: ['a'] }, 'groups')).toEqual(['a']);
  expect(readClaim({ 'https://example.com/groups': ['a'] }, 'https://example.com/groups')).toEqual(['a']);
  expect(readClaim({ realm_access: { roles: ['r'] } }, 'realm_access.roles')).toEqual(['r']);
  expect(readClaim({ 'urn:zitadel:iam:org:project:roles': { admin: {} } }, 'urn:zitadel:iam:org:project:roles')).toEqual({ admin: {} });
  expect(readClaim({}, 'missing.path')).toBeUndefined();
});
test('groups from a string, an array or object keys', () => {
  expect(extractGroups('admins')).toEqual(['admins']);
  expect(extractGroups(['admins', 7, '', 'ops', 'admins'])).toEqual(['admins', 'ops']);
  expect(extractGroups({ admin: { '2799': 'org.example' }, member: {} })).toEqual(['admin', 'member']);
  for (const v of [null, undefined, 42, true]) expect(extractGroups(v)).toEqual([]);
});
test('identity from claims normalizes email and verification', () => {
  expect(identityFromClaims({ sub: 's1', email: ' Ada@Example.COM ', email_verified: 'true', name: 'Ada',
    picture: 'https://img.example/a.png', groups: ['x'] }, 'groups')).toEqual({ subject: 's1', email: 'ada@example.com',
    emailVerified: true, name: 'Ada', avatarUrl: 'https://img.example/a.png', groups: ['x'] });
  expect(identityFromClaims({ sub: 's', email_verified: 'yes', groups: ['x'] }, undefined))
    .toMatchObject({ email: null, emailVerified: false, name: 's', groups: [] });
  expect(identityFromClaims({ sub: 's', picture: 'javascript:alert(1)' }, undefined).avatarUrl).toBeNull();
  expect(identityFromClaims({ sub: 's', picture: 'http://img.example/a.png' }, undefined).avatarUrl).toBeNull();
  expect(identityFromClaims({ sub: 's', preferred_username: 'ada' }, undefined).name).toBe('ada');
  expect(identityFromClaims({ sub: 's', given_name: 'Ada', family_name: 'Lovelace' }, undefined).name).toBe('Ada Lovelace');
  expect(identityFromClaims({ sub: 's', email: 'a@b.example' }, undefined).name).toBe('a@b.example');
  expect(identityFromClaims({ sub: 's', name: 'x'.repeat(300) }, undefined).name).toHaveLength(200);
  expect(() => identityFromClaims({ email: 'a@b.example' }, undefined)).toThrow();
});
// policy.test.ts
const policy = (p: Partial<AccessPolicy> = {}): AccessPolicy =>
  ({ adminGroups: [], memberGroups: [], adminEmails: [], memberEmails: [], memberDomains: [], ...p });
const who = (o: Partial<Pick<OidcIdentity, 'email' | 'emailVerified' | 'groups'>> = {}) =>
  ({ email: null, emailVerified: false, groups: [], ...o });
test('with no member restriction every identity is a member', () => {
  expect(mapIdpRole(policy(), who())).toBe('member');
  expect(mapIdpRole(policy({ adminGroups: ['admins'] }), who({ groups: ['admins'] }))).toBe('admin');
  expect(mapIdpRole(policy({ adminEmails: ['boss@example.com'] }), who())).toBe('member');
});
test('groups map to admin and member, exactly', () => {
  const p = policy({ adminGroups: ['pinwall-admins'], memberGroups: ['pinwall-users'] });
  expect(mapIdpRole(p, who({ groups: ['pinwall-admins'] }))).toBe('admin');
  expect(mapIdpRole(p, who({ groups: ['other', 'pinwall-users'] }))).toBe('member');
  expect(mapIdpRole(p, who({ groups: ['other'] }))).toBeNull();
  expect(mapIdpRole(p, who({ groups: ['Pinwall-Users'] }))).toBeNull();
});
test('verified emails and exact domains', () => {
  const p = policy({ adminEmails: ['boss@example.com'], memberEmails: ['friend@gmail.com'], memberDomains: ['example.com'] });
  const v = (email: string, emailVerified = true) => mapIdpRole(p, who({ email, emailVerified }));
  expect(v('boss@example.com')).toBe('admin');
  expect(v('ann@example.com')).toBe('member');
  expect(v('friend@gmail.com')).toBe('member');
  expect(v('stranger@gmail.com')).toBeNull();
  expect(v('ann@sub.example.com')).toBeNull();
  expect(v('ann@example.com.evil.net')).toBeNull();
  expect(v('boss@example.com', false)).toBeNull();
});
test('accessPolicy reads the configuration', () => { /* loadConfig with PINWALL_OIDC_* groups and the three email lists → the same lists */ });
// return-to.test.ts
const o = 'https://pinwall.test';
test('keeps same-origin paths', () => {
  expect(safeReturnTo('/projects/p1?tab=a#c', o)).toBe('/projects/p1?tab=a#c');
  expect(safeReturnTo('/a/art_1/v/2', o)).toBe('/a/art_1/v/2');
});
test('everything else falls back to /', () => {
  for (const raw of [undefined, null, '', 'projects', '//evil.example', '/\\evil.example', '\\\\evil.example',
    '/\t/evil.example', '/\n/evil.example', 'https://evil.example/', 'https://pinwall.test/x', 'javascript:alert(1)',
    '/auth/oidc/start?return_to=/', '/auth/oidc/callback', `/${'x'.repeat(2048)}`])
    expect(safeReturnTo(raw, o)).toBe('/');
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/auth/oidc/identity test/auth/oidc/policy test/auth/oidc/return-to`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.** `mapIdpRole`, in this order:
  1. The verified email is `emailVerified && email ? email : null`; its domain is the text after the last `@`.
  2. Any admin group, or the verified email in `adminEmails`, gives `'admin'`.
  3. With `memberGroups`, `memberEmails` and `memberDomains` all empty, the result is `'member'`.
  4. Any member group, the verified email in `memberEmails`, or its domain in `memberDomains` gives `'member'`.
  5. Otherwise `null`.

  `safeReturnTo` returns the parsed URL's `pathname + search + hash`, after the Global Constraints checks.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): map OIDC claims to identities and roles, and validate return_to`.

### Task 2: OIDC client runtime and the test IdP (model: opus)

**Files:**
- Create: `apps/server/src/auth/oidc/client.ts`, `apps/server/test/helpers/oidc-idp.ts`
- Test: `apps/server/test/auth/oidc/client.test.ts`

**Interfaces:**
- Consumes: M1 `AppDeps`, `Config`, `loadConfig`, `publicUrl`, `newSecret`; Task 1 nothing.
- Produces:

```ts
// client.ts
export const OIDC_HTTP_TIMEOUT_SECONDS = 10;
export interface OidcRuntime {
  configuration(): Promise<Configuration>;        // discovery once, cached; a rejected discovery is dropped so the next call retries
  readonly holder: string;                        // lease holder id for this process (newSecret())
  readonly inflight: Map<string, Promise<unknown>>;  // single-flight re-checks by user id (Task 5)
  readonly inlineBackoffUntil: Map<string, number>;  // user id → epoch ms (Task 6)
  inlineRecheckTimeoutMs: number;                 // 5_000 (Task 6); tests lower it
}
export function oidcRuntime(deps: AppDeps): OidcRuntime;        // one per AppDeps (WeakMap); throws when config.oidc is null
export function callbackUrl(config: Config): string;             // publicUrl(config, '/auth/oidc/callback')
export function buildAuthParams(oidc: NonNullable<Config['oidc']>, p: { redirectUri: string; state: string; nonce: string;
  codeChallenge: string; selectAccount: boolean }): Record<string, string>;
export type OidcErrorClass = 'invalid_grant' | 'cancelled' | 'unavailable' | 'failed';
export function classifyOidcError(e: unknown): OidcErrorClass;
//   ResponseBodyError error 'invalid_grant' → invalid_grant; ResponseBodyError status ≥ 500 → unavailable;
//   AuthorizationResponseError: 'temporarily_unavailable' | 'server_error' → unavailable, else cancelled;
//   TypeError (fetch failed), AbortError/TimeoutError, and discovery failures → unavailable; anything else → failed
```

```ts
// test/helpers/oidc-idp.ts
export interface TestIdpAccount { sub: string; email?: string; email_verified?: boolean | string; name?: string; picture?: string; groups?: unknown }
export interface TestIdpOptions {
  redirectUris?: string[];      // default ['http://localhost:8080/auth/oidc/callback', 'https://pinwall.test/auth/oidc/callback']
  groupsClaim?: string | null;  // claim released with scope 'groups', default 'groups'; null = Google-like: no groups scope or claim
  refreshTokens?: boolean;      // default true; false → client without the refresh_token grant
}
export interface TestIdp {
  readonly issuer: string;                                    // http://127.0.0.1:<port>
  env(extra?: Record<string, string>): Record<string, string>;
  //   PINWALL_OIDC_ISSUER, PINWALL_OIDC_CLIENT_ID 'pinwall', PINWALL_OIDC_CLIENT_SECRET 'pinwall-test-secret', PINWALL_OIDC_DISPLAY_NAME 'Test IdP';
  //   with a groups claim also PINWALL_OIDC_SCOPES 'openid email profile offline_access groups' and PINWALL_OIDC_ROLES_CLAIM = groupsClaim
  addAccount(a: TestIdpAccount): void;
  setGroups(sub: string, groups: unknown): void;
  disable(sub: string): void;                 // findAccount stops returning it → refresh is invalid_grant
  revokeGrants(sub: string): Promise<void>;   // destroys its grants → refresh is invalid_grant
  signInAs(sub: string): void;                // the account the next interaction completes as
  cancelNextSignIn(): void;                   // the next interaction ends with error=access_denied
  setReachable(reachable: boolean): void;     // false: each request is counted, then its socket destroyed
  setLatency(ms: number): void;               // delay before handling every request
  failTokenRequests(f: { status: number; error: string } | null): void;   // token endpoint answers this JSON error instead
  readonly authorizationRequests: URLSearchParams[];          // query of every /auth request, in order
  tokenRequests(grantType: 'authorization_code' | 'refresh_token'): number;   // counted on arrival, even when dropped
  close(): Promise<void>;
}
export function startTestIdp(opts?: TestIdpOptions): Promise<TestIdp>;
export function idpBrowserAuthorize(idp: TestIdp, authorizeUrl: string): Promise<URL>;
//   follows the IdP's redirects with a per-call cookie jar until a Location outside the issuer; returns that URL (the client callback)
```

- [ ] **Step 1: Write the failing tests** (`client.test.ts`). They use one IdP per file, and each test adds its own account with a random `sub`. `tokensFor(idp, sub)` is a local helper: it runs `buildAuthorizationUrl`, then `idpBrowserAuthorize`, then `authorizationCodeGrant` with the runtime's configuration.

```ts
test('discovers the issuer once and caches it', async () => {
  const rt = oidcRuntime(ctx.deps);
  const [a, b] = await Promise.all([rt.configuration(), rt.configuration()]);
  expect(a).toBe(b);
  expect(a.serverMetadata().issuer).toBe(idp.issuer);
});
test('a failed discovery is retried on the next call', ...);   // fresh ctx; setReachable(false) → rejects; setReachable(true) → resolves
test('authorization params carry PKCE S256, state, nonce and scopes that extra params cannot override', () => {
  const oidc = loadConfig({ ...idp.env(), PINWALL_OIDC_SCOPES: 'openid email profile offline_access',
    PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'access_type=offline&state=evil&redirect_uri=https://evil.example' }).oidc!;
  expect(buildAuthParams(oidc, { redirectUri: 'http://localhost:8080/auth/oidc/callback', state: 's', nonce: 'n',
    codeChallenge: 'c', selectAccount: false })).toEqual({ access_type: 'offline', response_type: 'code',
    redirect_uri: 'http://localhost:8080/auth/oidc/callback', scope: 'openid email profile offline_access',
    state: 's', nonce: 'n', code_challenge: 'c', code_challenge_method: 'S256' });
});
test('select_account adds consent when offline_access is requested', () => {
  const prompt = (env: Record<string, string>, selectAccount: boolean) => new Set(buildAuthParams(loadConfig({ ...idp.env(), ...env }).oidc!,
    { redirectUri: 'r', state: 's', nonce: 'n', codeChallenge: 'c', selectAccount }).prompt?.split(' '));
  expect(prompt({}, true)).toEqual(new Set(['select_account', 'consent']));
  expect(prompt({ PINWALL_OIDC_SCOPES: 'openid email' }, true)).toEqual(new Set(['select_account']));
  expect(prompt({ PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'prompt=consent' }, false)).toEqual(new Set(['consent']));
  expect(prompt({ PINWALL_OIDC_EXTRA_AUTH_PARAMS: 'prompt=none' }, true)).toEqual(new Set(['select_account', 'consent']));
  expect(prompt({}, false)).toEqual(new Set());   // no prompt param at all
});
test('the test IdP issues refresh tokens and reflects group changes', ...);
  // tokensFor → refresh_token defined; fetchUserInfo groups ['g1']; setGroups(['g2']) → refreshTokenGrant, then userinfo groups ['g2']
test('rotated refresh tokens cannot be reused', ...);            // refresh with RT1 → RT2 ≠ RT1; refresh with RT1 again → classify 'invalid_grant'
test('errors are classified for sign-in and re-check', ...);
  // disable(sub) → refreshTokenGrant rejects, classify 'invalid_grant'; revokeGrants → 'invalid_grant'; setReachable(false) → 'unavailable';
  // failTokenRequests({ status: 503, error: 'temporarily_unavailable' }) → 'unavailable'; { status: 401, error: 'invalid_client' } → 'failed';
  // cancelNextSignIn → authorizationCodeGrant on the returned callback URL rejects, classify 'cancelled'
test('a Google-like IdP has no groups claim', ...);   // startTestIdp({ groupsClaim: null }) → env() has no PINWALL_OIDC_ROLES_CLAIM; userinfo has no groups
test('an IdP without refresh tokens issues none', ...);   // refreshTokens: false → tokensFor(...).refresh_token undefined
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/auth/oidc/client`. Expected: FAIL.
- [ ] **Step 3: Implement `client.ts`.**
  - Call `discovery(new URL(issuer), clientId, metadata, clientAuth, { timeout: OIDC_HTTP_TIMEOUT_SECONDS, execute })`.
  - Client authentication is `ClientSecretBasic(secret)` when a client secret is set, else `None()`.
  - An `http:` issuer adds `allowInsecureRequests` to `execute` and logs one warning: `{ issuer }`, `'PINWALL_OIDC_ISSUER uses http: tokens travel unencrypted'`.
  - `buildAuthParams` builds its result in three layers:
    1. the extra params;
    2. then the protected keys, which replace any same-named extra param;
    3. then `prompt`, a set of: the extra `prompt` values minus `none`, plus `select_account` when asked, plus `consent` when asked and the scopes include `offline_access`.

    It omits `prompt` when the set is empty.
- [ ] **Step 4: Implement the test IdP.**
  - Use `new Provider(issuer, …)` from `oidc-provider`, served by `http.createServer` on `127.0.0.1:0`. Requests to `/interaction/:uid` are handled before `provider.callback()`.
  - One client: `pinwall` / `pinwall-test-secret`, `client_secret_basic`, `response_types: ['code']`. `grant_types` are `authorization_code`, plus `refresh_token` when `refreshTokens` is true.
  - Scopes `openid offline_access email profile`, plus `groups`. Claims: `email` → `email`, `email_verified`; `profile` → `name`, `picture`; `groups` → the groups claim.
  - `rotateRefreshToken: true`, so every refresh rotates.
  - `features.devInteractions.enabled: false`. Pass a generated RS256 JWK.
  - The interaction policy is `interactionPolicy.base()` plus a requestable `select_account` Prompt. Without it, oidc-provider rejects `prompt=select_account`.
  - The interaction handler:
    1. reads `interactionDetails`;
    2. creates a `Grant` for the `signInAs` account with the requested OIDC scopes and remembers its id for `revokeGrants`;
    3. calls `interactionFinished` with `{ login: { accountId }, consent: { grantId } }`, or `{ error: 'access_denied' }` after `cancelNextSignIn`.
  - `findAccount` reads the mutable account map and returns `undefined` for disabled accounts.
- [ ] **Step 5: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): add the OIDC client runtime and an in-process test IdP`.

### Task 3: OIDC users — upsert on sign-in, sealed refresh token (model: opus)

**Files:**
- Create: `apps/server/src/auth/oidc/users.ts`
- Test: `apps/server/test/auth/oidc/users.test.ts`

**Interfaces:**
- Consumes: Task 1 `OidcIdentity`, `accessPolicy`, `mapIdpRole`; M2 `effectiveRole`; M1 `encryptString`, `decryptString`, `deriveKey`, `newId('usr')`, `UserRow`.
- Produces:

```ts
export const IDP_REFRESH_TOKEN_PURPOSE = 'idp-refresh-token';
export function sealRefreshToken(deps: AppDeps, token: string): string;
export function openRefreshToken(deps: AppDeps, sealed: string): string | null;   // null (error logged with no payload) when it cannot be decrypted
export interface OidcUpsertResult { user: UserRow; created: boolean; admitted: boolean; reenabled: boolean }
export function upsertOidcUser(deps: AppDeps, p: { issuer: string; identity: OidcIdentity; refreshToken: string | null }): Promise<OidcUpsertResult>;
export function applyIdentity(deps: AppDeps, userId: string, identity: OidcIdentity): Promise<UserRow>;
//   used by Task 5: writes email, email_verified, name, avatar_url, idp_role (mapIdpRole) and idp_checked_at = now
```

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; `id(o)` builds an `OidcIdentity` with defaults `subject 's1'`, `email 'ada@example.com'`, `emailVerified true`, `name 'Ada'`, `groups ['pinwall-users']`; env sets `PINWALL_OIDC_ADMIN_GROUPS=pinwall-admins`, `PINWALL_OIDC_MEMBER_GROUPS=pinwall-users`):

```ts
test('first sign-in creates an oidc user keyed by issuer and subject', async () => {
  const r = await upsertOidcUser(ctx.deps, { issuer: 'https://idp.test', identity: id(), refreshToken: 'rt-1' });
  expect(r).toMatchObject({ created: true, admitted: true, reenabled: false });
  expect(r.user).toMatchObject({ kind: 'oidc', oidc_issuer: 'https://idp.test', oidc_subject: 's1', email: 'ada@example.com',
    email_verified: 1, name: 'Ada', idp_role: 'member', role_override: null, idp_checked_at: clock.now(), disabled_at: null });
  expect(r.user.id).toMatch(/^usr_/);
});
test('a later sign-in updates the same row', ...);              // new email, name and groups ['pinwall-admins'] → same id, created false, idp_role 'admin'
test('the same subject at another issuer is another user', ...);
test('the same email under another subject is not linked', ...); // two rows; a seeded owner with that email keeps kind 'owner' and its fields
test('the refresh token is stored sealed', ...);
  // column startsWith('v1.') and does not contain 'rt-1'; openRefreshToken(deps, column) === 'rt-1'
test('a sign-in without a refresh token keeps the stored one', ...);   // rt-1, then null → still opens to 'rt-1'; then 'rt-2' → 'rt-2'
test('a denied identity is recorded without a refresh token', ...);
  // after an admitted sign-in with rt-1: groups ['other'] → admitted false, idp_role null, idp_refresh_token null
test('role_override wins over the mapped role', ...);
  // override 'member' + groups ['other'] → admitted true; override 'blocked' + groups ['pinwall-admins'] → admitted false
test('an idp_removed user who is admitted again is re-enabled', ...);
  // set disabled_at, disabled_reason 'idp_removed' → reenabled true, both null; with groups ['other'] instead → stays disabled, reenabled false
test('two concurrent first sign-ins create one row', ...);      // Promise.all of two upserts → one users row; both results carry its id
test('a token sealed under another secret key opens as null', ...);   // seal with a ctx whose PINWALL_SECRET_KEY differs → null, logger.error called once
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/auth/oidc/users`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The key is `deriveKey(deps.config.secretKey, IDP_REFRESH_TOKEN_PURPOSE)`; throw when `secretKey` is null.
  - `upsertOidcUser`, in this order:
    1. Insert a bare row (`kind 'oidc'`, `email_verified 0`, `created_at` now) with `onConflict((oc) => oc.columns(['oidc_issuer', 'oidc_subject']).doNothing())`.
    2. Read the row back. `created` is true when the insert wrote it.
    3. Compute `idp_role = mapIdpRole(...)` and `admitted = effectiveRole({ ...row, idp_role })` ∈ `{admin, member}`.
    4. Run one update: the identity fields; `idp_checked_at = now`; `idp_refresh_token` = `admitted ? (refreshToken ? seal : existing) : null`; and, when admitted with `disabled_reason === 'idp_removed'`, `disabled_at = null` and `disabled_reason = null`.

    It never writes `role_override`.
- [ ] **Step 4: Run** the Step 2 command, plain and with `PINWALL_TEST_POSTGRES_URL`. Expected: PASS on both dialects.
- [ ] **Step 5: Commit** `feat(server): create and update OIDC users on sign-in with a sealed IdP refresh token`.

### Task 4: Sign-in routes, no-access page, error pages (model: opus)

**Files:**
- Create: `apps/server/src/auth/oidc/{sign-in.ts,routes.ts}`, `apps/server/src/pages/no-access.tsx`, `apps/server/test/helpers/oidc-browser.ts`
- Modify: `apps/server/src/app.ts` (add `app.route('/auth/oidc', buildOidcRouter())` after the health routes, before the SPA fallback), `apps/server/src/auth/sessions.ts` (`AuthMethod` gains `'oidc'`), `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/auth/oidc/sign-in.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1–3: `safeReturnTo`, `identityFromClaims`, `oidcRuntime`, `callbackUrl`, `buildAuthParams`, `classifyOidcError`, `upsertOidcUser`;
  - M2: `startSession`, `hasAccess`, `enforceRateLimit`, `RateRule`, `sessionCookieFrom`, `apiInit`;
  - M1: `renderErrorPage`, the page layout it uses, `hashSecret`, `newSecret`, `t`.
- Produces:

```ts
// sign-in.ts
export const PENDING_LOGIN_TTL_MS = 600_000;
export interface PendingLogin { codeVerifier: string; nonce: string; returnTo: string; selectAccount: boolean; browserHash: string }
export type OidcFailure = 'not_configured' | 'unavailable' | 'expired' | 'other_browser' | 'cancelled' | 'failed';
export class OidcFlowError extends Error { constructor(readonly failure: OidcFailure, readonly returnTo: string, options?: { cause?: unknown }) }
export function beginOidcSignIn(deps: AppDeps, p: { returnTo: string; selectAccount: boolean; browserSecret: string }): Promise<string>;  // the IdP URL
export type CallbackOutcome = { kind: 'admitted'; user: UserRow; returnTo: string }
  | { kind: 'denied'; user: UserRow; identity: OidcIdentity; returnTo: string; selectAccount: boolean };
export function finishOidcSignIn(deps: AppDeps, p: { query: string; browserSecret: string | undefined }): Promise<CallbackOutcome>;  // throws OidcFlowError
// routes.ts
export const OIDC_START_RATE: RateRule = { name: 'oidc-start', limit: 60, windowMs: 900_000 };
export const OIDC_CALLBACK_RATE: RateRule = { name: 'oidc-callback', limit: 30, windowMs: 900_000 };
export function oidcBindingCookieName(config: Config): '__Host-pinwall_oidc' | 'pinwall_oidc';
export function startPath(returnTo: string, selectAccount: boolean): string;   // '/auth/oidc/start?return_to=%2Fx[&prompt=select_account]'
export function buildOidcRouter(): Hono<AppEnv>;                                // GET /start, GET /callback
// pages/no-access.tsx
export function renderNoAccessPage(p: { idp: string; name: string; email: string | null; emailVerified: boolean;
  switchHref: string; retried: boolean; requestId: string }): string;
// test/helpers/oidc-browser.ts
export function signInWithIdp(ctx: TestContext, idp: TestIdp, o: { as: string; returnTo?: string; selectAccount?: boolean;
  baseUrl?: string; cookie?: string }): Promise<Response>;   // Pinwall start → idpBrowserAuthorize → Pinwall callback (binding cookie carried); the callback response
export function signInOidcUser(ctx: TestContext, idp: TestIdp, a: TestIdpAccount): Promise<{ user: UserRow; cookie: string }>;
//   addAccount + signInAs + signInWithIdp; asserts the 302; returns the row and the session cookie
```

- [ ] **Step 1: Write the failing tests.** They run in `describe.each(dialects)`, with one `startTestIdp()` per file, a fresh `ctx` per test (so rate-limit counters start at zero), a random `sub` per account, and env `idp.env({ PINWALL_OIDC_ADMIN_GROUPS: 'pinwall-admins', PINWALL_OIDC_MEMBER_GROUPS: 'pinwall-users' })`.

```ts
test('start redirects to the IdP with PKCE, state and nonce', async () => {
  const r = await ctx.request('/auth/oidc/start?return_to=/projects/p1');
  expect(r.status).toBe(302);
  expect(r.headers.get('cache-control')).toBe('no-store');
  const url = new URL(r.headers.get('location')!);
  expect(url.origin + url.pathname).toBe(`${idp.issuer}/auth`);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  for (const k of ['state', 'nonce', 'code_challenge']) expect(url.searchParams.get(k)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/auth/oidc/callback');
  expect(url.searchParams.get('prompt')).toBeNull();
  const sc = r.headers.getSetCookie().find((c) => c.startsWith('pinwall_oidc='))!;
  expect(sc).toMatch(/^pinwall_oidc=[A-Za-z0-9_-]{43};/);
  for (const part of ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) expect(sc).toContain(part);
});
test('a member signs in and lands on return_to with a session', ...);
  // groups ['pinwall-users'] → 302, location '/projects/p1', cache-control no-store; GET /api/v1/me with the session cookie →
  // 200 { kind: 'oidc', role: 'member', via: 'session', email, name, credentials: null }; sessions row auth_method 'oidc'; idp_refresh_token not null
test('an admin group member is an admin', ...);                // groups ['pinwall-admins'] → /me role 'admin'
test('an unadmitted identity gets the no-access page and no session', async () => {
  // addAccount { sub, name: 'Eve Example', email: 'eve@example.com', email_verified: true, groups: ['other'] }
  const r = await signInWithIdp(ctx, idp, { as: sub, returnTo: '/projects/p1' });
  expect(r.status).toBe(403);
  expect(r.headers.get('content-type')).toMatch(/^text\/html/);
  const body = await r.text();
  for (const s of ['Eve Example', 'eve@example.com', t('oidc.noAccess.switch'), t('oidc.noAccess.signedInAs', { idp: 'Test IdP' })])
    expect(body).toContain(s);
  expect(body).toContain('href="/auth/oidc/start?return_to=%2Fprojects%2Fp1&amp;prompt=select_account"');
  expect(body).not.toContain(t('oidc.noAccess.retryHint', { idp: 'Test IdP' }));
  expect(sessionCookieFrom(r)).toBeNull();
  // sessions table empty; the users row exists with idp_role null
});
test('use a different account restarts with prompt=select_account and keeps return_to', ...);
  // signInWithIdp({ as: admitted sub, returnTo: '/projects/p1', selectAccount: true }) → 302 '/projects/p1';
  // new Set(idp.authorizationRequests.at(-1)!.get('prompt')!.split(' ')) equals {'select_account', 'consent'}; the user's idp_refresh_token not null
test('a retry that lands on the same unadmitted account shows the sign-out hint', ...);   // selectAccount + same denied sub → body contains retryHint
test('an unverified email is shown as unverified', ...);       // PINWALL_MEMBER_DOMAINS=example.com, email_verified false → 403, body contains t('oidc.noAccess.unverified')
test('claims are escaped on the no-access page', ...);         // name '<script>alert(1)</script>' → body contains '&lt;script&gt;alert(1)&lt;/script&gt;', not '<script>alert'
test('return_to tricks fall back to /', ...);                  // '//evil.example', '/\\evil.example', 'https://evil.example', '/auth/oidc/start' → admitted sign-in, location '/'
test('a callback without its pending login is an HTML error page', ...);
  // GET /auth/oidc/callback?state=unknown&code=x with accept 'application/json' → 400 text/html containing t('oidc.expired.title'), cache-control no-store
test('a callback replay is refused', ...);                     // the same callback URL and cookie twice → 2nd 400 expired page; one session row
test('a pending login expires after ten minutes', ...);        // clock.advance(600_001) between start and callback → expired page
test('a callback from another browser is refused', ...);
  // callback without the binding cookie → 400 text/html t('oidc.otherBrowser.message'); no users row for the sub; no session
test('a cancelled sign-in is an HTML page with try again', ...);
  // idp.cancelNextSignIn() → 400 text/html containing t('oidc.cancelled.message', { idp: 'Test IdP' }) and
  // href="/auth/oidc/start?return_to=%2Fprojects%2Fp1"
test('an unreachable IdP is an HTML 502 page', ...);           // fresh ctx, setReachable(false) → start → 502 text/html t('oidc.unavailable.title', { idp: 'Test IdP' })
test('OIDC routes are 404 pages when OIDC is off', ...);       // no OIDC env → start and callback → 404 text/html t('oidc.notConfigured.title')
test('behind a TLS proxy the redirect URI and cookies use the public origin', async () => {
  // env PINWALL_PUBLIC_ORIGIN=https://pinwall.test; signInWithIdp({ baseUrl: 'http://internal:8080' }) with header host: internal:8080
  // → authorizationRequests.at(-1).get('redirect_uri') === 'https://pinwall.test/auth/oidc/callback'; callback 302;
  // the binding cookie starts '__Host-pinwall_oidc=' with Secure; the session cookie starts '__Host-pinwall_session=' with Secure
});
test('sign-in replaces the session presented with the request', ...);   // signInWithIdp({ cookie: earlier session }) → that sessions row is gone
test('start and callback are rate limited per IP', ...);       // 60 starts → 302; the 61st → 429 text/html with a numeric Retry-After
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/auth/oidc/sign-in`. Expected: FAIL.
- [ ] **Step 3: Implement `sign-in.ts`.**
  - **`beginOidcSignIn`:** discovers, then mints state, nonce and verifier. It stores `PendingLogin` with `browserHash = hashSecret(browserSecret)` and returns `buildAuthorizationUrl(configuration, buildAuthParams(...)).href`. A discovery failure is `OidcFlowError('unavailable')`.
  - **`finishOidcSignIn`, in this order:**
    1. A missing `state`, or a null `take`, is `expired`.
    2. A missing `browserSecret`, or one whose hash differs from the stored one, is `other_browser`.
    3. Build `current = new URL(callbackUrl(config))` with `search = query`. Call `authorizationCodeGrant(configuration, current, { pkceCodeVerifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true })`. Map errors with `classifyOidcError`: `unavailable` stays `unavailable`, `cancelled` stays `cancelled`, everything else becomes `failed`.
    4. Claims are the ID token's claims, overlaid with `fetchUserInfo(configuration, access_token, sub)` when the metadata has a `userinfo_endpoint`. A userinfo error is `unavailable` or `failed` by class.
    5. Run `upsertOidcUser` with `issuer = configuration.serverMetadata().issuer`.
    6. The outcome is `admitted` when `result.admitted && hasAccess(result.user)`, else `denied`.

    Log info `{ user_id, created }` `'oidc sign-in'`, or `{ user_id }` `'oidc sign-in denied'`. Log a warn with the failure class only.
- [ ] **Step 4: Implement `routes.ts` and the page.**
  - **`/start`:**
    1. `config.oidc` null → `not_configured`.
    2. `enforceRateLimit(c, OIDC_START_RATE)`.
    3. Compute `returnTo = safeReturnTo(query return_to)`; `selectAccount` is true only when `prompt === 'select_account'`.
    4. Reuse the binding cookie when it matches `/^[A-Za-z0-9_-]{43}$/`, else mint one, and (re)set it.
    5. Answer 302 to the IdP URL.
  - **`/callback`:**
    1. `not_configured`, then `enforceRateLimit(c, OIDC_CALLBACK_RATE)`.
    2. Call `finishOidcSignIn` with the raw query and the binding cookie.
    3. `admitted` → `startSession(c, user, 'oidc')`, then 302 to `returnTo`.
    4. `denied` → 403 `renderNoAccessPage`, with `switchHref = startPath(returnTo, true)`, `retried = selectAccount`, and the identity's name and email.
  - **Wrapper.** Both handlers run inside one wrapper that turns any throw into `c.html(renderErrorPage(...), status)` with `Cache-Control: no-store`, so `Accept` never matters:

    | Error | Status | Title / message keys | Actions |
    | --- | --- | --- | --- |
    | `not_configured` | 404 | `oidc.notConfigured.*` | `error.goHome` → `/` |
    | `unavailable` | 502 | `oidc.unavailable.*` | `oidc.tryAgain` → `startPath(err.returnTo, false)` |
    | `expired` | 400 | `oidc.expired.*` | `oidc.tryAgain` → `startPath(err.returnTo, false)` |
    | `other_browser` | 400 | `oidc.otherBrowser.*` | `oidc.tryAgain` → `startPath(err.returnTo, false)` |
    | `cancelled` | 400 | `oidc.cancelled.*` | `oidc.tryAgain` → `startPath(err.returnTo, false)` |
    | `failed` | 400 | `oidc.failed.*` | `oidc.tryAgain` → `startPath(err.returnTo, false)` |
    | `AppError` `rate_limited` | 429 | title `oidc.rateLimited.title`, the error's message | — |
    | anything else | 500 | M1's server error page | — |

    The 429 page also sends `Retry-After` from `details.retry_after_seconds`.
  - **`renderNoAccessPage`** uses M1's page layout. Content, in order:
    1. the title;
    2. `signedInAs`;
    3. name and email (or `noEmail`), with `unverified` beside an unverified email;
    4. the message;
    5. the primary button link `switchHref`;
    6. `retryHint` when `retried`;
    7. the request id.
- [ ] **Step 5: Add en.json keys:**
  - `"oidc.notConfigured.title": "Single sign-on is not set up"`
  - `"oidc.notConfigured.message": "This Pinwall has no identity provider configured. Sign in with the owner account instead."`
  - `"oidc.unavailable.title": "Could not reach {{idp}}"`
  - `"oidc.unavailable.message": "Pinwall could not reach {{idp}} to finish signing you in. Try again in a moment."`
  - `"oidc.expired.title": "This sign-in has expired"`
  - `"oidc.expired.message": "The sign-in took longer than 10 minutes or was already used. Start again."`
  - `"oidc.otherBrowser.title": "Sign-in started elsewhere"`
  - `"oidc.otherBrowser.message": "This sign-in was started in another browser, or this browser blocked Pinwall's cookie. Start again here."`
  - `"oidc.cancelled.title": "Not signed in"`
  - `"oidc.cancelled.message": "{{idp}} did not sign you in. The sign-in may have been cancelled or refused."`
  - `"oidc.failed.title": "Sign-in failed"`
  - `"oidc.failed.message": "{{idp}} sent a response Pinwall could not verify. Try again, or ask an admin to check the server log."`
  - `"oidc.rateLimited.title": "Too many sign-in attempts"`
  - `"oidc.tryAgain": "Try again"`
  - `"oidc.noAccess.title": "No access with this account"`
  - `"oidc.noAccess.signedInAs": "You signed in to {{idp}} as"`
  - `"oidc.noAccess.message": "This account does not have access to this Pinwall. Ask an admin to add you, or use a different account."`
  - `"oidc.noAccess.noEmail": "No email address"`
  - `"oidc.noAccess.unverified": "Email address not verified"`
  - `"oidc.noAccess.switch": "Use a different account"`
  - `"oidc.noAccess.retryHint": "If {{idp}} picks the same account again, sign out of {{idp}} first, then try again."`
- [ ] **Step 6: Run** `pnpm --filter @pinwall/server test`. Expected: PASS, M1 and M2 suites included.
- [ ] **Step 7: Commit** `feat(server): add OIDC sign-in with PKCE, a no-access page and HTML error pages`.

### Task 5: Access re-check service and job (model: opus)

**Files:**
- Create: `apps/server/src/auth/oidc/{recheck.ts,job.ts}`
- Modify: `apps/server/src/auth/startup.ts` (`startAuth` also calls `startOidc(deps)`)
- Test: `apps/server/test/auth/oidc/{recheck,job}.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1–4: `identityFromClaims`, `oidcRuntime`, `classifyOidcError`, `openRefreshToken`, `sealRefreshToken`, `applyIdentity`, `signInOidcUser`;
  - M2: `effectiveRole`, `revokeAllCredentials`, `createUserToken`;
  - M1: `LeaseManager`, `Scheduler`.
- Produces:

```ts
// recheck.ts
export const RECHECK_LEASE_TTL_MS = 60_000;
export type RecheckOutcome = 'ok' | 'removed' | 'transient' | 'no_refresh_token' | 'skipped';
export interface RecheckResult { outcome: RecheckOutcome; user: UserRow | undefined }
export function recheckUser(deps: AppDeps, userId: string): Promise<RecheckResult>;   // single-flight per user id
export function disableRemovedUser(deps: AppDeps, userId: string): Promise<UserRow>;  // disabled_at now, 'idp_removed', idp_refresh_token null, then revokeAllCredentials
// job.ts
export const RECHECK_JOB_NAME = 'access-recheck';
export const RECHECK_JOB_PERIOD_MS = 900_000;
export const RECHECK_BATCH_LIMIT = 200;
export interface RecheckSummary { checked: number; ok: number; removed: number; transient: number }
export function runAccessRecheck(deps: AppDeps): Promise<RecheckSummary>;
export function startOidc(deps: AppDeps): void;   // no-op without OIDC; warms discovery (logs error, never throws); schedules the job
```

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; env as Task 4; `clock.advance(12 * 3_600_000)` makes a user due):

```ts
// recheck.test.ts
test('a still-admitted user is checked and keeps access', ...);   // advance 12h → { outcome: 'ok' }, idp_checked_at === clock.now()
test('a role change at the IdP updates idp_role', ...);           // admins → users → 'ok', idp_role 'member'
test('removal from the groups disables and revokes everything', async () => {
  // signInOidcUser (groups ['pinwall-users']) + createUserToken + an oauth_clients/oauth_grants row with one oauth_tokens row (as M2's Revoke now test)
  idp.setGroups(sub, ['other']); clock.advance(12 * 3_600_000);
  expect((await recheckUser(ctx.deps, user.id)).outcome).toBe('removed');
  // users: disabled_at === now, disabled_reason 'idp_removed', idp_refresh_token null, idp_role null;
  // sessions of the user: 0; api_tokens.revoked_at === now; oauth_grants.revoked_at === now; its oauth_tokens: 0
});
test('a disabled IdP account is removed', ...);                   // idp.disable(sub) → 'removed'
test('revoked IdP grants are removed', ...);                      // idp.revokeGrants(sub) → 'removed'
test('an unreachable IdP is transient and changes nothing', ...);
  // setReachable(false) → 'transient'; row unchanged (idp_checked_at, disabled_at null, same sealed token);
  // logger.warn called with an object holding user_id; no logged argument contains the refresh token
test('an IdP 5xx is transient', ...);                             // failTokenRequests({ status: 503, error: 'temporarily_unavailable' }) → 'transient'
test('a misconfigured client is transient, not removal', ...);    // failTokenRequests({ status: 401, error: 'invalid_client' }) → 'transient', not disabled
test('a rotated refresh token is saved', ...);                    // 'ok' → openRefreshToken(column) differs from before; a 2nd recheck → 'ok'
test('role_override keeps a user after group removal but not after IdP removal', ...);
  // override 'member' + setGroups(['other']) → 'ok'; then idp.disable → 'removed'
test('concurrent re-checks of one user share one refresh', ...); // Promise.all of 3 → all 'ok'; idp.tokenRequests('refresh_token') rose by 1
test('a user being re-checked elsewhere is left alone', ...);    // leases.acquire('idp-recheck:<id>', 'other', 60_000) → 'transient', no token request
test('a user without a refresh token is not sent to the IdP', ...);   // IdP with refreshTokens: false → 'no_refresh_token', no token request
test('owners, blocked and disabled users are skipped', ...);     // → 'skipped'
// job.test.ts
test('the job re-checks due users with live credentials only', ...);
  // A: session; B: no credentials (sessions deleted); D: only an API token; E: only an API token whose expires_at is set in the past;
  // F: only an unrevoked oauth_grants row; then clock.advance(11 * H), C signs in (session), clock.advance(1 * H) →
  // summary { checked: 3, ok: 3, removed: 0, transient: 0 }; idp_checked_at moved for A, D, F only (C is 1 h old, not picked)
test('the job picks users who become due before its next run', ...);   // advance(12h - 900_000 + 1) → checked 1
test('the job counts removals and transient failures', ...);     // one removed by setGroups, one with the IdP failing → { removed: 1, transient: 1 }
test('startOidc schedules the job every 15 minutes', ...);       // spy deps.scheduler.every → ('access-recheck', 900_000, fn); without OIDC → never called
test('startAuth starts the OIDC job', ...);                      // startAuth(deps) with OIDC env → the same every() call
test('startOidc survives an unreachable IdP', ...);              // setReachable(false) on a fresh ctx → no throw; logger.error called once
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/auth/oidc/recheck test/auth/oidc/job`. Expected: FAIL.
- [ ] **Step 3: Implement `recheckUser`.** The order is the algorithm:
  1. Return `runtime.inflight.get(userId)` when it exists. Otherwise store the new promise there, and delete it when it settles.
  2. Load the user. Return `skipped` for any of these: missing, not `kind 'oidc'`, `disabled_at` set, or `role_override === 'blocked'`.
  3. With no `idp_refresh_token`, return `no_refresh_token`.
  4. `deps.leases.acquire('idp-recheck:' + userId, runtime.holder, RECHECK_LEASE_TTL_MS)`. If not acquired, return `transient`. Release the lease in `finally`.
  5. `openRefreshToken`. When it returns null, set the column to null and return `no_refresh_token`.
  6. Call `refreshTokenGrant`. On error, `classifyOidcError === 'invalid_grant'` → `disableRemovedUser` → `removed`. Any other error: log warn `{ user_id, class }` `'idp re-check failed'` → `transient`.
  7. If the response carries a `refresh_token`, seal and store it now, before any further request.
  8. Build the claims: the new ID token's claims when present, overlaid with `fetchUserInfo(configuration, access_token, oidc_subject)` when there is a userinfo endpoint. A failure here, or no claims from either source, is `transient`.
  9. `applyIdentity` with `identityFromClaims({ ...claims, sub: oidc_subject }, rolesClaim)`.
  10. `effectiveRole(updated)` not admin/member → `disableRemovedUser` → `removed`; else `ok`.

  `disableRemovedUser` updates the row first, then calls `revokeAllCredentials`, then logs info `{ user_id }` `'oidc user removed'`.
- [ ] **Step 4: Implement the job.**
  - **Candidates:** `kind = 'oidc'`, `disabled_at` null, `role_override` null or not `'blocked'`, `idp_refresh_token` not null, and `idp_checked_at` null or `< now - recheckIntervalMs + RECHECK_JOB_PERIOD_MS`. The user must also have at least one live credential:
    - a session with `expires_at > now`;
    - an API token not revoked whose `expires_at` is null or `> now`;
    - an OAuth grant not revoked.
  - Order by `idp_checked_at` ascending, limit `RECHECK_BATCH_LIMIT`.
  - Run `recheckUser` with at most 4 at a time.
  - Log info with the summary when `checked > 0`.
  - `startOidc` calls `deps.scheduler.every(RECHECK_JOB_NAME, RECHECK_JOB_PERIOD_MS, () => runAccessRecheck(deps).then(() => {}))`.
- [ ] **Step 5: Run** `pnpm --filter @pinwall/server test`, plain and with the Postgres env. Expected: PASS.
- [ ] **Step 6: Commit** `feat(server): re-check OIDC users with the IdP and disable people removed there`.

### Task 6: Access gate in `resolveAuth` (model: opus)

**Files:**
- Create: `apps/server/src/auth/oidc/gate.ts`
- Modify: `apps/server/src/auth/resolve.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/auth/oidc/gate.test.ts`

**Interfaces:**
- Consumes: Task 5 `recheckUser`, `runAccessRecheck`; Task 2 `oidcRuntime`; M2 `resolveAuth` internals, `deleteSession`, `clearSessionCookie`, `unauthorized`, `createUserToken`.
- Produces (M6 calls `gateUser(deps, user, { inline: true })` when it refreshes an MCP token):

```ts
export const MAX_IDP_STALENESS_MS = 86_400_000;
export const INLINE_RECHECK_TIMEOUT_MS = 5_000;
export const INLINE_RETRY_BACKOFF_MS = 60_000;
export function isRecheckDue(user: UserRow, now: number, config: Config): boolean;
//   kind 'oidc' && (idp_checked_at === null || now - idp_checked_at >= recheckIntervalMs)
export function idpAccessCurrent(user: UserRow, now: number, config: Config): boolean;
//   owner → true; idp_checked_at null → false; with a refresh token → now - checked < MAX_IDP_STALENESS_MS; without → now - checked < recheckIntervalMs
export type GateResult = { ok: true; user: UserRow } | { ok: false };
export function gateUser(deps: AppDeps, user: UserRow, opts: { inline: boolean }): Promise<GateResult>;
```

  Changes to `resolveAuth`, both made before its `hasAccess` check, which then applies to `result.user`:
  - **Session branch:** `gateUser(deps, user, { inline: true })`. `{ ok: false }` → delete the session, clear the cookie, `auth` null.
  - **Bearer branch:** `gateUser(deps, user, { inline: false })`. `{ ok: false }` → `WWW-Authenticate: Bearer error="invalid_token"` and `unauthorized(t('oidc.recheckRequired'))`.

- [ ] **Step 1: Write the failing tests** (in `describe.each(dialects)`; `H = 3_600_000`; `me(cred)` is `GET /api/v1/me` with a cookie or a bearer):

```ts
test('due and current follow the interval and the 24-hour bound', () => {
  const cfg = ctx.deps.config; const t0 = clock.now();
  const u = (o: Partial<UserRow>) => ({ ...oidcRow, idp_checked_at: t0, idp_refresh_token: 'v1.x', ...o }) as UserRow;
  expect(isRecheckDue(u({}), t0 + 12 * H - 1, cfg)).toBe(false);
  expect(isRecheckDue(u({}), t0 + 12 * H, cfg)).toBe(true);
  expect(idpAccessCurrent(u({}), t0 + 24 * H - 1, cfg)).toBe(true);
  expect(idpAccessCurrent(u({}), t0 + 24 * H, cfg)).toBe(false);
  expect(idpAccessCurrent(u({ idp_refresh_token: null }), t0 + 12 * H - 1, cfg)).toBe(true);
  expect(idpAccessCurrent(u({ idp_refresh_token: null }), t0 + 12 * H, cfg)).toBe(false);
  expect(idpAccessCurrent(u({ idp_checked_at: null }), t0, cfg)).toBe(false);
  expect(idpAccessCurrent(ownerRow, t0 + 1000 * H, cfg)).toBe(true);
  expect(isRecheckDue(ownerRow, t0 + 1000 * H, cfg)).toBe(false);
});
test('a due browser session is re-checked inline before the request is answered', ...);
  // member session; setGroups(['other']); advance 12h → me(cookie) 401 with the cookie cleared; user disabled 'idp_removed'; refresh requests +1
test('a due session of a still-admitted user continues and is marked checked', ...);   // → 200; idp_checked_at === now
test('parallel requests from a due session trigger one refresh', ...);   // 5 parallel me(cookie) → all 200; refresh requests +1
test('bearer requests never call the IdP', ...);                // due user, API token → 200; refresh requests unchanged
test('an unreachable IdP keeps access until 24 hours after the last successful check', ...);
  // session + API token; setReachable(false); advance 12h → me(cookie) 200, me(token) 200; advance to 24h - 1 → both 200;
  // advance 1 → me(cookie) 401 and the sessions row deleted; me(token) 401 with www-authenticate containing 'invalid_token'
  // and message t('oidc.recheckRequired'); user not disabled
test('access returns without admin action when the IdP is reachable again', ...);   // continuing: setReachable(true); runAccessRecheck → ok 1; me(token) 200
test('an IdP outage does not slow every request', ...);
  // setReachable(false); advance 12h → me(cookie) 200 (refresh requests +1); me(cookie) again → no new refresh request;
  // advance(60_001) → me(cookie) → one more refresh request
test('a slow IdP is cut off at the inline timeout', ...);
  // oidcRuntime(ctx.deps).inlineRecheckTimeoutMs = 100; idp.setLatency(1_000); advance 12h →
  // me(cookie) 200 within 800 ms; await runtime.inflight.get(user.id) → idp_checked_at === now
test('without a refresh token, credentials last until the re-check is due', ...);
  // IdP refreshTokens: false; session + API token; advance 12h - 1 → both 200; advance 1 → cookie 401, token 401 invalid_token;
  // sign in again → new session 200 and the same API token 200 (not revoked)
test('owners are never gated', ...);                             // setupOwner; advance 25h → me(cookie) 200
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/auth/oidc/gate`. Expected: FAIL.
- [ ] **Step 3: Implement `gateUser`:**
  1. A non-`oidc` user → `{ ok: true, user }`.
  2. When `inline`, `isRecheckDue`, a refresh token is stored, and `inlineBackoffUntil.get(id) ?? 0 <= now`: race `recheckUser` against `runtime.inlineRecheckTimeoutMs`.
     - On timeout, keep the current row. Never abort the recheck: it may already hold a rotated token.
     - On `transient`, set `inlineBackoffUntil = now + INLINE_RETRY_BACKOFF_MS`.
     - Otherwise use `result.user` when present.
  3. Return `idpAccessCurrent(row, clock.now(), config) ? { ok: true, user: row } : { ok: false }`.

  Make the M2 `resolve.ts` edits described above. en.json: `"oidc.recheckRequired": "Your access could not be confirmed with your identity provider. Sign in to Pinwall again."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with the Postgres env. Expected: PASS, including M2's `resolve`, `me` and `tokens` suites.
- [ ] **Step 5: Commit** `feat(server): gate every credential on a current IdP check and re-check browser sessions inline`.

### Task 7: Milestone flow — acceptance 3 and 3b on the mock IdP (model: sonnet)

**Files:**
- Test: `apps/server/test/auth/oidc/flow.test.ts`

**Interfaces:**
- Consumes everything above, plus M2's `setupOwner`, `createUserToken`, `apiInit` and `sessionCookieFrom`. It produces nothing new.

- [ ] **Step 1: Write the flow** (in `describe.each(dialects)`; `H = 3_600_000`). Parts B and C each start their own IdP and context. Parts A and D–H share one IdP and one context, in order.
  - **Part A — Zitadel-like.** Start the IdP with `startTestIdp({ groupsClaim: 'urn:zitadel:iam:org:project:roles' })`. Env: `PINWALL_OIDC_ADMIN_GROUPS=pinwall-admin`, `PINWALL_OIDC_MEMBER_GROUPS=pinwall-member`.
    1. Ada has roles `{ 'pinwall-admin': { '1': 'org.example' } }` → `/me` role `admin`.
    2. Bob has `{ 'pinwall-member': {} }` → `member`.
    3. Eve has `{ other: {} }` → 403 no-access page showing her name and email, with the "Use a different account" link.
    4. Following that link with `selectAccount` as Bob2 (`pinwall-member`) → 302 to the original `return_to`, role `member`.
  - **Part B — Keycloak-like.** Start the IdP with `startTestIdp({ groupsClaim: 'realm_access' })` and env `PINWALL_OIDC_ROLES_CLAIM=realm_access.roles`. An account with `{ roles: ['pinwall-admin'] }` → `admin`; one with `{ roles: ['nobody'] }` → the no-access page.
  - **Part C — Google-like.** Start the IdP with `startTestIdp({ groupsClaim: null })`. Env: `PINWALL_ADMIN_EMAILS=boss@example.com`, `PINWALL_MEMBER_DOMAINS=example.com`, `PINWALL_MEMBER_EMAILS=friend@gmail.com`.
    - `boss@example.com` (verified) → `admin`.
    - `ann@example.com` → `member`.
    - `friend@gmail.com` → `member`.
    - `stranger@gmail.com` → the no-access page.
    - `ann2@example.com` with `email_verified: false` → the no-access page showing `t('oidc.noAccess.unverified')`.
  - **Part D — 3b by the job, no admin action.** Using Part A's IdP: Bob has a session, an API token and an OAuth grant row with one token row.
    1. `idp.setGroups(bob, ['x'])`, then `clock.advance(12 * H)`.
    2. `runAccessRecheck` → `removed: 1`.
    3. Bob's browser → 401; his API token → 401; his grant has `revoked_at` set and no token rows.
    4. Ada's `GET /api/v1/admin/users` shows Bob with `disabled_reason: 'idp_removed'`.
    5. Assert the elapsed time on `clock` is `≤ 24 * H`.
  - **Part E — 3b inline, the job never runs.** Carol is a member with a session. Remove her group and `clock.advance(12 * H)`. Her next `GET /api/v1/me` → 401.
  - **Part F — 3b during an IdP outage.** Dave is a member with a session and a token.
    1. `setReachable(false)`, then `clock.advance(24 * H)` → both 401, and Dave is not disabled.
    2. `setReachable(true)`, then `runAccessRecheck` → his token → 200.
  - **Part G — Revoke now.** Ada calls `POST /api/v1/admin/users/<Bob2 id>/revoke` → Bob2's session and token → 401 at once.
  - **Part H — re-admission.** `idp.setGroups(bob, ['pinwall-member'])`, then Bob signs in → 302. `disabled_at` is null and `/me` → 200.
- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/auth/oidc/flow`. Expected: PASS. Any failure is a defect in Tasks 1–6: fix it there.
- [ ] **Step 3: Run** `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm test:integration`. Expected: all pass, with the M3 suites run on SQLite and Postgres, not skipped.
- [ ] **Step 4: Commit** `test(server): cover OIDC acceptance 3 and 3b against the in-process IdP`.

---

## M3 done when

- `pnpm lint && pnpm typecheck && pnpm test` pass.
- `pnpm test:integration` passes, with the M3 suites run on both SQLite and Postgres.
- `flow.test.ts` passes against the in-process `oidc-provider`. It shows:
  - admin/member mapped by groups (object, nested and array claims) and by verified emails and domains;
  - the no-access page with "Use a different account" restarting at `prompt=select_account`;
  - a member removed at the IdP losing browser, API token and OAuth grant access within 24 h with no admin action, both by the job and inline;
  - an IdP outage failing closed at 24 h;
  - "Revoke now" taking effect at once.
- Manual checks against real Zitadel, Keycloak and Google are left to M9.
