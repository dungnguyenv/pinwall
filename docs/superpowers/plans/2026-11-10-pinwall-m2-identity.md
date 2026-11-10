# Pinwall M2 — Owner Account, Sessions, API Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The built-in owner account (created once through a setup link printed in the log), owner sign-in by password and passkey, sliding cookie sessions with sign-out and a CSRF origin check, personal API tokens, `AuthContext` from a cookie or `Authorization: Bearer`, `GET /api/v1/me`, `GET /api/v1/config/public`, and admin user list, role override and **Revoke now** — all REST under `/api/v1`, described at `/api/v1/openapi.json`.

**Architecture:** Services live in `apps/server/src/auth/`; they take `AppDeps` and use Kysely. Routes live in `apps/server/src/api/` as `@hono/zod-openapi` routes on one `OpenAPIHono<AppEnv>` mounted at `/api/v1`, and they validate with DTO schemas from `@pinwall/shared`. Two middlewares run on `/api/v1/*`: `originCheck`, then `resolveAuth`, which turns a session cookie or a bearer token into `c.var.auth`. A bearer token goes to a list of `BearerResolver`s picked by token prefix: API tokens now, OAuth access tokens in M6. WebAuthn challenges and the setup token are kept in M1's `OneTimeStore`. Rate-limit counters are kept in M1's `RateLimiter`.

**Tech Stack:** Hono 4, `@hono/zod-openapi` 1.x (`createRoute`, `doc31`, route-level `middleware`), zod 4, `@simplewebauthn/server` 14.x, Kysely, `node:crypto`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-pinwall-design.md` (§3.2).

**Roadmap:** `docs/superpowers/plans/2026-11-10-pinwall-roadmap.md` holds the shared names, data model, routes and Security model. Its Global Constraints apply to every task.

**Depends on:** M1 (`docs/superpowers/plans/2026-11-10-pinwall-m1-foundation.md`). This plan uses M1's Interfaces. Where the merged M1 code differs in a name or signature, the code wins: change the import and keep the behavior.

## Global Constraints

The roadmap's Global Constraints apply, plus these for M2:
- **Public origin only.** Every absolute URL, cookie name and flag, WebAuthn RP ID and expected origin comes from `config.publicOrigin` or `config.publicHttps`. Never from the request's scheme, `Host` or `X-Forwarded-*`.
- **Session cookie, exactly as the roadmap says:** name `__Host-pinwall_session` on https, else `pinwall_session`; `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` on https; `Max-Age` = `PINWALL_SESSION_TTL` in seconds; value `newSecret()` (32 bytes).
- **Hashed secrets.** Session secrets, API tokens and the setup token are kept only as `hashSecret()` hashes, in the DB and in the `OneTimeStore`.
- **WebAuthn:** rpName `Pinwall`; RP ID = hostname of `PINWALL_PUBLIC_ORIGIN`; expected origin = `PINWALL_PUBLIC_ORIGIN`; attestation `none`; resident key and user verification `required`; algorithms `[-8, -7, -257]`. Never call `MetadataService.initialize()` or anything else that fetches FIDO metadata (no third-party requests).
- **API JSON:** snake_case, epoch-ms times, errors `{ "error": { "code", "message", "details"? } }`, lists `{ items, next_cursor }`. DTO zod schemas live in `packages/shared/src/api/`; shared and server resolve one zod 4 version (`pnpm why -r zod` lists one).
- **i18n.** Every message a person can read goes through `t()`. Each task adds its keys to `packages/shared/src/i18n/en.json`, using the exact copy the task gives.
- **Both databases.** Tests that touch the DB run inside `describe.each(dialects)`, so `pnpm test:integration` also covers Postgres.
- **No UI and no migration.** M1's `0001_initial` already has `users`, `password_credentials`, `passkeys`, `sessions`, `api_tokens`, `oauth_grants` and `oauth_tokens`.

## Review Focus

1. **Behind a TLS-terminating proxy** (roadmap item 2): https public origin, requests over http with an internal `Host`. Expected: cookie `__Host-pinwall_session` with `Secure`. → Task 3 `refreshed cookie is Secure and __Host- on an https origin although the request is http`; Task 4 `setup cookie is Secure and __Host- …`.
2. **Opened at an address other than `PINWALL_PUBLIC_ORIGIN`** (`127.0.0.1` vs `localhost`, a LAN IP, a second proxy hostname). Expected: POSTs get a 403 naming both origins and pointing at `PINWALL_PUBLIC_ORIGIN`. → Task 3 `origin mismatch names the expected origin`.
3. **Plain-http non-localhost origin** (`http://pinwall.lan:8080`) or an IP, where browsers refuse WebAuthn. Expected: `passkeys_available: false` in `config/public`, passkey endpoints give a 400 that says why, password setup still works. → Task 1 `passkeys need a secure, named origin`; Task 4 `setup by password works where passkeys are unavailable`.
4. **A rejected setup attempt** (short password, failed passkey ceremony, double-clicked submit). Expected: failures do not use up the link; only the request that creates the owner does, and exactly one owner exists. → Task 4 `a rejected setup attempt leaves the link usable`, `two concurrent setups create one owner`.
5. **A password typed in another Unicode form** (macOS NFD, Vietnamese diacritics, full-width digits). Expected: it signs in whatever its form; length counts after normalization. → Task 4 `normalizes to NFKC and counts code points`; Task 5 `password in another Unicode form still signs in`.

---

### Task 1: WebAuthn ceremonies, passkey storage, software authenticator (model: opus)

**Files:**
- Create: `apps/server/src/auth/{webauthn.ts,passkeys.ts}`, `apps/server/test/helpers/soft-authenticator.ts`
- Modify: `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/helpers/soft-authenticator.test.ts`, `apps/server/test/auth/webauthn.test.ts`

**Interfaces:**
- Consumes (M1): `AppDeps` (`config`, `db`, `oneTime`, `clock`), `Config`, `Database`, `PasskeyRow`, `newId`, `newSecret`, `AppError`, `badRequest`, `t`, `loadConfig`, `createTestContext`, `dialects`, `FixedClock`.
- Produces:

```ts
// auth/webauthn.ts
export const RP_NAME = 'Pinwall';
export const CEREMONY_TTL_MS = 300_000;
export const SUPPORTED_ALGORITHM_IDS = [-8, -7, -257];
export function relyingParty(config: Config): { rpID: string; origin: string };     // hostname of publicOrigin, publicOrigin
export function passkeysAvailable(config: Config): boolean;
export type RegistrationPurpose = 'setup' | 'add';
export interface PasskeyRegistration { userId: string; credentialId: string; publicKey: string; counter: number; transports: string[] }
export function beginRegistration(deps: AppDeps, p: { purpose: RegistrationPurpose; userId: string; userName: string;
  displayName: string; exclude: { credentialId: string; transports: string[] }[] }):
  Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }>;
export function finishRegistration(deps: AppDeps, p: { purpose: RegistrationPurpose; ceremonyId: string;
  response: RegistrationResponseJSON; userId?: string }): Promise<PasskeyRegistration>;
export function beginAuthentication(deps: AppDeps): Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }>;
export function finishAuthentication(deps: AppDeps, p: { ceremonyId: string; response: AuthenticationResponseJSON }):
  Promise<{ passkey: PasskeyRow; newCounter: number }>;                              // also records the use
// auth/passkeys.ts
export type Db = Kysely<Database> | Transaction<Database>;
export function insertPasskey(db: Db, p: PasskeyRegistration & { name: string; now: number }): Promise<PasskeyRow>;   // id newId('pky')
export function findPasskeyByCredentialId(db: Db, credentialId: string): Promise<PasskeyRow | undefined>;
export function listPasskeys(db: Db, userId: string): Promise<PasskeyRow[]>;        // oldest first
export function recordPasskeyUse(db: Db, id: string, counter: number, now: number): Promise<void>;
// test/helpers/soft-authenticator.ts
export class SoftAuthenticator {
  constructor(opts: { origin: string; uv?: boolean });                               // uv defaults to true
  readonly credentials: ReadonlyArray<{ id: string; userHandle: string; signCount: number }>;
  register(options: PublicKeyCredentialCreationOptionsJSON, o?: { origin?: string }): RegistrationResponseJSON;
  authenticate(options: PublicKeyCredentialRequestOptionsJSON, o?: { origin?: string; credentialId?: string }): AuthenticationResponseJSON;
}
```

- [ ] **Step 1: Write the failing helper tests** (`soft-authenticator.test.ts`). They check the helper against `@simplewebauthn/server` alone, with no Pinwall code involved.

```ts
test('produces a registration simplewebauthn accepts', async () => {
  const a = new SoftAuthenticator({ origin: 'http://localhost:8080' });
  const options = await generateRegistrationOptions({ rpName: 'T', rpID: 'localhost', userName: 'u', attestationType: 'none' });
  const v = await verifyRegistrationResponse({ response: a.register(options), expectedChallenge: options.challenge,
    expectedOrigin: 'http://localhost:8080', expectedRPID: 'localhost' });
  expect(v.verified).toBe(true);
  expect(v.registrationInfo?.fmt).toBe('none');
  expect(v.registrationInfo?.credential.id).toBe(a.credentials[0]?.id);
});
test('produces assertions that verify and count up', ...);  // two authentication rounds → newCounter 1, then 2
test('honours excludeCredentials', ...);                    // registering again with its own id excluded throws /InvalidStateError/
test('a tampered signature does not verify', ...);         // flip one signature byte → verified false or rejects
```

- [ ] **Step 2: Write the failing service tests** (`webauthn.test.ts`, inside `describe.each(dialects)`; `a` is a `SoftAuthenticator` on `http://localhost:8080` unless a test says otherwise):

```ts
test('registration round-trips through the soft authenticator', async () => {
  const { ceremonyId, options } = await beginRegistration(ctx.deps, { purpose: 'setup', userId: 'usr_0000000000000000000a',
    userName: 'Ada', displayName: 'Ada', exclude: [] });
  expect(options.rp).toEqual({ name: 'Pinwall', id: 'localhost' });
  expect(options.attestation).toBe('none');
  expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  const reg = await finishRegistration(ctx.deps, { purpose: 'setup', ceremonyId, response: a.register(options) });
  expect(reg).toMatchObject({ userId: 'usr_0000000000000000000a', credentialId: a.credentials[0]?.id, counter: 0 });
});
test('a ceremony can be finished once', ...);              // 2nd finish → AppError { code: 'invalid_credentials', status: 401 }
test('a ceremony expires after five minutes', ...);        // clock.advance(300_001) → invalid_credentials
test('a setup ceremony cannot finish an add', ...);        // → invalid_credentials
test('an add ceremony is bound to its user', ...);         // finish with another userId → invalid_credentials
test('registration from another origin is refused', ...);  // a.register(options, { origin: 'http://127.0.0.1:8080' }) → invalid_credentials
test('user verification is required', ...);                // SoftAuthenticator({ origin, uv: false }) → invalid_credentials
test('authentication verifies, returns the new counter and records use', ...);
  // insertPasskey(reg); options: rpId 'localhost', userVerification 'required', no allowCredentials →
  // newCounter 1; row counter 1, last_used_at === clock.now()
test('an assertion for an unknown credential is refused', ...);
test('an assertion whose user handle names another user is refused', ...);  // stored under another user_id → invalid_credentials
test('RP ID comes from the public origin', ...);           // https://pinwall.test:8443 → rp.id 'pinwall.test'; that origin verifies
test('passkeys need a secure, named origin', async () => {
  const cfg = (o: string) => loadConfig({ PINWALL_PUBLIC_ORIGIN: o, PINWALL_DATA_DIR: '/tmp/pw' });
  for (const o of ['http://localhost:8080', 'http://pinwall.localhost', 'https://pinwall.example'])
    expect(passkeysAvailable(cfg(o))).toBe(true);
  for (const o of ['http://pinwall.lan:8080', 'https://192.168.1.10', 'http://127.0.0.1:8080'])
    expect(passkeysAvailable(cfg(o))).toBe(false);
  // on http://pinwall.lan:8080, beginAuthentication rejects with bad_request and message t('auth.passkeysUnavailable')
});
```

- [ ] **Step 3: Run** `pnpm --filter @pinwall/server test test/helpers/soft-authenticator test/auth/webauthn`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement `SoftAuthenticator`** with `node:crypto` only; these byte layouts are the algorithm:
  - **Key and checks.** `generateKeyPairSync('ec', { namedCurve: 'P-256' })`; `x`/`y` from the JWK export. `register` throws unless `pubKeyCredParams` offers `-7`, and throws `Error('InvalidStateError')` if it holds an id in `excludeCredentials`.
  - **CBOR (private helper).** Major types: 0 non-negative int, 1 negative int (as `-1 - n`), 2 `Uint8Array`, 3 UTF-8 string, 5 `Map` (insertion order). Arguments < 24 sit in the initial byte, else follow in 1/2/4 bytes (`0x18`/`0x19`/`0x1a`). COSE key: `Map{1→2, 3→-7, -1→1, -2→x, -3→y}`.
  - **authData.** `sha256(rpId)` ‖ flags (UP `0x01`, UV `0x04` when `uv`, BE `0x08`, BS `0x10`, AT `0x40` on registration only) ‖ big-endian u32 sign count. Registration appends 16 zero bytes (AAGUID) ‖ u16 BE id length ‖ random 16-byte credential id ‖ COSE key.
  - **attestationObject / clientDataJSON / signature.** `Map{'fmt'→'none', 'attStmt'→Map{}, 'authData'→authData}`. `JSON.stringify({ type: 'webauthn.create' | 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false })`. `sign('sha256', concat(authData, sha256(clientDataJSON)), privateKey)` (Node's EC default is DER, as WebAuthn expects).
  - **Authenticate.** Increment the count first. Credential: `o.credentialId`, else the first held id in `allowCredentials`, else the first held. `userHandle` = the `options.user.id` seen at registration.
  - **JSON.** Binary fields base64url; `type: 'public-key'`, `clientExtensionResults: {}`, `authenticatorAttachment: 'platform'`; registration also sends `transports: ['internal']`.
- [ ] **Step 5: Implement the services.**
  - **Ceremonies.** One-time store key `webauthn:<ceremonyId>` (`ceremonyId = newSecret()`, TTL `CEREMONY_TTL_MS`), value `{ type: 'registration', purpose, challenge, userId } | { type: 'authentication', challenge }`. Each `finish*` takes it before verifying, so it finishes once.
  - **Options.** WebAuthn `userID` = `new TextEncoder().encode(userId)`. Registration uses the Global Constraints values, `timeout: CEREMONY_TTL_MS` and `excludeCredentials`. Authentication is `{ rpID, userVerification: 'required', timeout }` with no `allowCredentials` (discoverable passkeys).
  - **Verify and store.** `requireUserVerification: true`, `supportedAlgorithmIDs`; store `publicKey` as base64url text and `transports` as JSON.
  - **Errors.** Every failure — missing ceremony, wrong type or purpose, user mismatch, unknown credential, a `userHandle` that does not decode to the passkey's `user_id`, a library throw, `verified: false` — is `new AppError('invalid_credentials', 401, t('auth.passkeyFailed'))`.
  - **Availability.** Both `begin*` throw `badRequest(t('auth.passkeysUnavailable'))` when `!passkeysAvailable(config)`: false when the bracket-stripped hostname passes `isIP`, else `publicHttps || hostname === 'localhost' || hostname.endsWith('.localhost')`.
  - **en.json:**
    - `"auth.passkeyFailed": "This passkey could not be verified. Try again."`
    - `"auth.passkeysUnavailable": "Passkeys need Pinwall to run on https or on localhost. Use a password, or set PINWALL_PUBLIC_ORIGIN to an https address."`
- [ ] **Step 6: Run** the Step 3 command, then again with `PINWALL_TEST_POSTGRES_URL` set. Expected: PASS on both dialects.
- [ ] **Step 7: Commit** `feat(server): add WebAuthn ceremonies, passkey storage and a software authenticator for tests`.

### Task 2: API foundation — shared DTO base, OpenAPI router, public config (model: sonnet)

**Files:**
- Create: `packages/shared/src/api/{common.ts,config.ts,index.ts}`, `apps/server/src/api/{router.ts,config.ts}`, `apps/server/src/lib/cursor.ts`, `apps/server/src/auth/users.ts`
- Modify: `packages/shared/src/index.ts` (re-export `./api/index.ts`), `packages/shared/package.json` (`zod` with the server's range `^4.6.7`), `apps/server/src/app.ts`, `apps/server/src/http/errors.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/{config,openapi,router}.test.ts`, `apps/server/test/lib/cursor.test.ts`

**Interfaces:**
- Consumes: M1 `AppEnv`, `errorHandler`, `AppError`, `badRequest`, `unauthorized`, `payloadTooLarge`, `rateLimited`, `publicUrl`, `t`. Task 1 `passkeysAvailable`.
- Produces in shared `api/common.ts` (each schema also exports its same-named `z.infer` type): `ErrorBody`; `Timestamp = z.number().int()`; `Label = z.string().trim().min(1).max(100)` (user, passkey and token names); `page<T extends z.ZodType>(item: T)` → `z.object({ items: z.array(item), next_cursor: z.string().nullable() })`.
- Produces in shared `api/config.ts`: `PublicConfig = { setup_required: boolean, oidc: { enabled: boolean, display_name: string | null }, isolation: 'single-domain' | 'content-domain', passkeys_available: boolean, limits: { max_upload_bytes, max_inline_bytes, max_file_bytes, max_version_bytes, max_files, max_expansion_ratio } }`.
- Produces in `api/router.ts`: `createApiRouter(): OpenAPIHono<AppEnv>` (bare, with the `defaultHook`); `jsonBodyLimit: MiddlewareHandler` (65_536 bytes); `buildApiRouter(): OpenAPIHono<AppEnv>`, which calls every `registerXRoutes(api)` and serves `GET /openapi.json`. Each resource module exports `registerXRoutes(api: OpenAPIHono<AppEnv>): void`; later tasks and milestones add theirs to `buildApiRouter`.
- Route conventions for every later task: `createRoute` with `tags` and `summary`; `{param}` paths; JSON bodies `required: true` with schemas from `@pinwall/shared`, behind `jsonBodyLimit`; guards in `createRoute({ middleware: [...] })`; authenticated routes declare `security: [{ session: [] }, { bearer: [] }]`.
- Produces in `auth/users.ts`: `ownerExists(db: Kysely<Database>): Promise<boolean>`; `getOwner(db: Kysely<Database>): Promise<UserRow | undefined>`.
- Produces in `lib/cursor.ts`: `encodeCursor(v: Record<string, string | number>): string` (base64url JSON); `decodeCursor<T>(s: string, schema: z.ZodType<T>): T`, which throws `badRequest(t('error.cursor'))`.
- `app.ts` adds `app.route('/api/v1', buildApiRouter())`, after the health routes and before the SPA fallback.

- [ ] **Step 1: Write failing tests.**

```ts
test('public config before setup', async () => {
  const r = await ctx.request('/api/v1/config/public');
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ setup_required: true, oidc: { enabled: false, display_name: null },
    isolation: 'single-domain', passkeys_available: true,
    limits: { max_upload_bytes: 95_000_000, max_inline_bytes: 2_000_000, max_file_bytes: 50_000_000,
      max_version_bytes: 500_000_000, max_files: 10_000, max_expansion_ratio: 100 } });
});
test('public config reflects OIDC, isolation and an existing owner', ...);
  // env PINWALL_PUBLIC_ORIGIN=https://pinwall.test, PINWALL_ISOLATION=content-domain, PINWALL_CONTENT_ORIGIN=https://pw-content.test,
  // PINWALL_OIDC_ISSUER=https://idp.test, PINWALL_OIDC_CLIENT_ID=c, PINWALL_OIDC_DISPLAY_NAME=Zitadel; insert an owner row →
  // setup_required false, oidc { enabled: true, display_name: 'Zitadel' }, isolation 'content-domain'
test('openapi document uses the public origin', async () => {
  // PINWALL_PUBLIC_ORIGIN=https://pinwall.test; request with host: internal:8080, x-forwarded-host: evil.example
  expect(doc.openapi).toBe('3.1.0');
  expect(doc.info.title).toBe('Pinwall API');
  expect(doc.servers).toEqual([{ url: 'https://pinwall.test/api/v1' }]);
  expect(Object.keys(doc.paths)).toContain('/config/public');
});
// router.test.ts: test-only routes on createApiRouter(), mounted on a bare Hono<AppEnv> that injects ctx.deps and uses errorHandler
test('validation failures are bad_request with issues', ...);   // POST /echo { n: 'x' } against { n: z.number() } → 400 { error: { code: 'bad_request',
  //   message: t('error.validation'), details: { issues: [{ path: 'n', message: expect.any(String) }] } } }
test('malformed JSON is bad_request', ...);                    // body '{', JSON content-type → 400 bad_request
test('oversized JSON is payload_too_large', ...);              // 70_000 bytes through jsonBodyLimit → 413 payload_too_large
test('rate_limited errors carry Retry-After', ...);            // throw rateLimited(30) → 429, retry-after '30'
test('headers set before an error survive', ...);              // c.header('www-authenticate', 'Bearer') then throw unauthorized → header on the 401
test('cursor round-trips and rejects garbage', ...);           // decodeCursor(encodeCursor({ c: 5, i: 'usr_x' }), schema) round-trips; 'zz' → bad_request
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api test/lib/cursor`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`defaultHook`:** throw `badRequest(t('error.validation'), { issues: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) })`.
  - **`jsonBodyLimit`:** `bodyLimit({ maxSize: 65_536, onError })`, where `onError` throws `payloadTooLarge(t('error.tooLarge'))`.
  - **OpenAPI document:** `api.doc31('/openapi.json', c => ({ openapi: '3.1.0', info: { title: 'Pinwall API', version: '1' }, servers: [{ url: publicUrl(c.var.deps.config, '/api/v1') }] }))`. Security schemes: `bearer` (`http`/`bearer`) and `session` (`apiKey`, cookie `pinwall_session`; the description names the `__Host-` variant).
  - **`http/errors.ts`** (only what M1 lacks): a Hono `HTTPException` maps to `AppError` by status (400 → `bad_request`, 413 → `payload_too_large`, others by status); `rate_limited` gets `Retry-After` from `details.retry_after_seconds`; responses are built through `c.json`/`c.html` so headers set before the throw survive.
  - **en.json:**
    - `"error.validation": "Some fields are missing or invalid."`
    - `"error.tooLarge": "The request body is too large."`
    - `"error.cursor": "This page link is no longer valid. Start from the first page."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test` and `pnpm why -r zod`. Expected: PASS; one zod version.
- [ ] **Step 5: Commit** `feat(server): add OpenAPI router, shared DTO base and public config endpoint`.

### Task 3: Sessions, auth resolution, CSRF origin check, `/me`, sign-out (model: opus)

**Files:**
- Create: `apps/server/src/auth/{roles.ts,sessions.ts,session-cookie.ts,resolve.ts,resolvers.ts,guards.ts,rate-limits.ts}`, `apps/server/src/http/origin-check.ts`, `apps/server/src/api/{me.ts,auth.ts}`, `packages/shared/src/api/auth.ts`, `apps/server/test/helpers/auth.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/api/router.ts`, `apps/server/src/auth/users.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/me.test.ts`, `apps/server/test/auth/{resolve,origin-check}.test.ts`

**Interfaces:**
- Consumes:
  - M1: `AppEnv`, `AuthContext` (`{ user: UserRow; via: 'session' | 'api_token' | 'oauth'; sessionId?: string }`), `UserRow`, `SessionRow`, `Config`, `clientIp`, `newId`, `newSecret`, `hashSecret`, `unauthorized`, `forbidden`, `rateLimited`, `AppError`, `FixedClock`, `createTestContext`;
  - Task 2: `buildApiRouter`, `Timestamp`.
- Produces:

```ts
// auth/roles.ts
export type Role = 'admin' | 'member';
export function effectiveRole(u: Pick<UserRow, 'kind' | 'idp_role' | 'role_override'>): Role | 'blocked' | null; // override ?? (owner ? 'admin' : idp_role)
export function hasAccess(u: UserRow): boolean;               // admin|member and disabled_at null
// auth/sessions.ts
export type AuthMethod = 'password' | 'passkey';              // M3 adds 'oidc'
export const SESSION_TOUCH_INTERVAL_MS = 300_000;
export function createSession(deps: AppDeps, userId: string, method: AuthMethod, meta: { ip: string; userAgent: string | null }):
  Promise<{ secret: string; idHash: string; expiresAt: number }>;
export function resolveSession(deps: AppDeps, secret: string): Promise<{ session: SessionRow; user: UserRow; refreshed: boolean } | null>;
export function deleteSession(deps: AppDeps, idHash: string): Promise<void>;
export function deleteUserSessions(deps: AppDeps, userId: string, opts?: { exceptIdHash?: string }): Promise<number>;
export function purgeExpiredSessions(deps: AppDeps): Promise<number>;
// auth/session-cookie.ts
export function sessionCookieName(config: Config): '__Host-pinwall_session' | 'pinwall_session';
export function readSessionCookie(c: Context<AppEnv>): string | undefined;
export function setSessionCookie(c: Context<AppEnv>, secret: string): void;
export function clearSessionCookie(c: Context<AppEnv>): void;
export function startSession(c: Context<AppEnv>, user: UserRow, method: AuthMethod): Promise<void>;  // drops the presented session, creates one, sets the cookie
// auth/resolve.ts
export interface BearerResolver { name: string; matches(token: string): boolean; resolve(deps: AppDeps, token: string): Promise<AuthContext | null> }
export function resolveAuth(opts: { bearer: readonly BearerResolver[]; cookies: boolean }): MiddlewareHandler<AppEnv>;
// auth/resolvers.ts — extension point: Task 6 appends apiTokenResolver, M6 the OAuth access-token resolver
export const bearerResolvers: BearerResolver[];
// auth/guards.ts
export const requireAuth: MiddlewareHandler<AppEnv>;          // 401 unauthorized t('auth.signInRequired')
export const requireAdmin: MiddlewareHandler<AppEnv>;         // + 403 forbidden t('auth.adminOnly')
export const requireSession: MiddlewareHandler<AppEnv>;       // + 403 forbidden t('auth.sessionRequired') unless via === 'session'
export const requireOwner: MiddlewareHandler<AppEnv>;         // + 403 forbidden t('auth.ownerOnly') unless kind === 'owner'
export function authOf(c: Context<AppEnv>): AuthContext;      // after a guard
// auth/rate-limits.ts
export interface RateRule { name: string; limit: number; windowMs: number }
export const RATE_RULES: { setup: RateRule; password: RateRule; passwordGlobal: RateRule; passkey: RateRule };
//   setup 10 / 900_000 ms · password 10 / 900_000 · passwordGlobal 'password-global' 100 / 3_600_000 · passkey 30 / 900_000
export function enforceRateLimit(c: Context<AppEnv>, rule: RateRule, key?: string): void;
//   key defaults to clientIp(c, config.trustProxy); consumes `${rule.name}:${key}`; throws rateLimited(Math.ceil(retryAfterMs / 1000))
// http/origin-check.ts
export function originCheck(config: Config): MiddlewareHandler<AppEnv>;
// auth/users.ts (adds)
export function toMe(deps: AppDeps, auth: AuthContext): Promise<Me>;
// shared api/auth.ts
export const Me;  // { id, kind: 'owner'|'oidc', name, email|null, email_verified, avatar_url|null, role: 'admin'|'member',
                  //   via: 'session'|'api_token'|'oauth', credentials: { password: boolean, passkeys: number } | null (owner only), created_at }
// test/helpers/auth.ts — TestContext = Awaited<ReturnType<typeof createTestContext>>
export function apiInit(ctx: TestContext, o?: { method?: string; body?: unknown; cookie?: string; bearer?: string;
  origin?: string | null; headers?: Record<string, string> }): RequestInit;   // non-GET gets origin = public origin unless given; null omits it
export function sessionCookieFrom(res: Response): string | null;               // "name=value" of a non-empty session Set-Cookie
export function createSignedInUser(ctx: TestContext, o?: { kind?: 'owner' | 'oidc'; idpRole?: Role | null;
  roleOverride?: Role | 'blocked' | null; name?: string; method?: AuthMethod }): Promise<{ user: UserRow; cookie: string }>;
```

  Routes and mounting:
  - `GET /me`: `requireAuth`, returns 200 `Me`.
  - `POST /auth/sign-out`: no guard. Deletes the session when `via === 'session'`, always clears the cookie, returns 204.
  - `app.ts` adds `app.use('/api/v1/*', originCheck(config), resolveAuth({ bearer: bearerResolvers, cookies: true }))` in front of the API router.
  - Later milestones: M4 mounts `resolveAuth` on `/a/*`; M6 mounts `resolveAuth({ bearer: bearerResolvers, cookies: false })` on `/mcp`; M3 adds its IdP re-check where `resolveSession` refreshes.

- [ ] **Step 1: Write failing tests** (all in `describe.each(dialects)`, with `clock = new FixedClock(Date.UTC(2026, 10, 10))`). `me.test.ts`:

```ts
test('a session cookie resolves to the user', ...);   // owner → 200 { kind: 'owner', role: 'admin', via: 'session', credentials: { password: false, passkeys: 0 } }
test('no credentials is 401 unauthorized', ...);
test('an oidc member has role member and no credentials block', ...);   // role 'member', credentials null
test('the session slides', ...);                      // +29 d → 200 with Set-Cookie; +29 d → 200; +30 d +1 ms → 401, sessions table empty
test('requests within five minutes do not re-set the cookie', ...);     // +60_000 → no set-cookie
test('refreshed cookie is Secure and __Host- on an https origin although the request is http', async () => {
  // PINWALL_PUBLIC_ORIGIN=https://pinwall.test; createSignedInUser; clock.advance(300_000)
  const r = await ctx.app.request('http://internal:8080/api/v1/me', apiInit(ctx, { cookie }));
  const sc = r.headers.getSetCookie()[0] ?? '';
  expect(sc).toMatch(/^__Host-pinwall_session=[A-Za-z0-9_-]{43};/);
  for (const part of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${30 * 86_400}`]) expect(sc).toContain(part);
});
test('a plain-http origin uses pinwall_session without Secure', ...);
test('sign-out deletes the session and clears the cookie', ...);   // 204, Max-Age=0; old cookie → GET /me 401; sessions count 0
test('sign-out without a session is 204', ...);
test("a blocked user's session ends at once", ...);   // role_override 'blocked' → 401, cookie cleared, session row deleted
test("a disabled user's session ends at once", ...);  // disabled_at set → the same
test('purgeExpiredSessions removes only expired sessions', ...);
```

  `resolve.test.ts` uses a bare `Hono<AppEnv>` that injects `ctx.deps`, mounts `resolveAuth({ bearer: [stub], cookies })`, and serves `GET`/`POST /who` returning `{ via, user_id }`. The stub is `{ name: 'stub', matches: t => t.startsWith('st_'), resolve: async (_d, t) => t === 'st_good' ? { user, via: 'oauth' } : null }`.

```ts
test('a matching resolver authenticates with its via', ...);   // Bearer st_good → { via: 'oauth' }
test('an invalid bearer is refused even with a valid session cookie', ...);   // st_bad + cookie → 401, www-authenticate has 'invalid_token'
test('a bearer no resolver claims is refused', ...);           // Bearer xyz → 401
test('a malformed Authorization header is refused', ...);      // 'Basic abc', 'Bearer', 'Bearer a b' → 401, 'invalid_request'
test('the scheme is case-insensitive', ...);                   // 'bearer st_good' → 200
test('a bearer for a user without access is access_denied', ...);   // stub user role_override 'blocked' → 403 access_denied
test('cookies are ignored when the middleware is bearer-only', ...);   // cookies: false + cookie → auth null
```

  `origin-check.test.ts` sends `POST /api/v1/auth/sign-out` with a session cookie through the real app, unless a test says otherwise:

```ts
test('cross-origin POST with a session cookie is refused', ...);   // origin https://evil.example → 403 forbidden; GET /me still 200
test('missing or null Origin is refused', ...);                     // apiInit origin null, and origin 'null' → 403
test('Sec-Fetch-Site other than same-origin is refused', ...);      // same-site, cross-site, none → 403
test('same-origin POST passes', ...);                               // right Origin + same-origin → 204
test('safe methods are not checked', ...);                          // GET /me, evil Origin → 200
test('bearer requests skip the check', ...);                        // bare app + originCheck + stub: POST, Bearer st_good, evil Origin → 200
test('origin mismatch names the expected origin', async () => {
  const r = await ctx.request('/api/v1/auth/sign-out', apiInit(ctx, { method: 'POST', cookie, origin: 'http://127.0.0.1:8080' }));
  const { error } = await r.json();
  expect(error.details).toEqual({ origin: 'http://127.0.0.1:8080', expected_origin: 'http://localhost:8080' });
  expect(error.message).toContain('http://localhost:8080');
  expect(error.message).toContain('PINWALL_PUBLIC_ORIGIN');
});
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/me test/auth/resolve test/auth/origin-check`. Expected: FAIL.
- [ ] **Step 3: Implement.** The decision order below is the algorithm.
  - **`resolveAuth` with an `authorization` header** (cookies are then never read): (1) it must match `/^Bearer (\S+)$/i`, else set `WWW-Authenticate: Bearer error="invalid_request"` and throw `unauthorized(t('auth.invalidToken'))`; (2) the first resolver whose `matches` accepts the token resolves it — no match or a null result sets `error="invalid_token"` and throws the same 401; (3) a user failing `hasAccess` → `new AppError('access_denied', 403, t('auth.accessDenied'))`.
  - **`resolveAuth` with `cookies` on and a session cookie:** `resolveSession` null → clear the cookie, `auth` null; user without access → delete the session, clear the cookie, `auth` null; `refreshed` → set the cookie again; otherwise `auth = { user, via: 'session', sessionId: idHash }`.
  - **Sessions.** `createSession` stores `id_hash = hashSecret(secret)`, the client IP and the user agent cut to 512 chars. `resolveSession` deletes an expired row; when `now - last_seen_at >= SESSION_TOUCH_INTERVAL_MS` it sets `last_seen_at = now`, `expires_at = now + ttl.sessionMs` and `users.last_seen_at`.
  - **`originCheck`** checks methods other than GET/HEAD/OPTIONS on requests without an `authorization` header: `Origin` must equal `config.publicOrigin` and `Sec-Fetch-Site` must be absent or `same-origin`, else `forbidden(t('auth.crossOrigin', { origin: header ?? '(none)', expected }), { origin: header ?? null, expected_origin: expected })`.
  - **en.json:**
    - `"auth.signInRequired": "Sign in to continue."`
    - `"auth.invalidToken": "The bearer token is invalid, expired or revoked."`
    - `"auth.accessDenied": "Your account does not have access to this Pinwall."`
    - `"auth.adminOnly": "Only admins can do this."`
    - `"auth.sessionRequired": "This needs a browser session; API and OAuth tokens cannot do it."`
    - `"auth.ownerOnly": "Only the built-in owner account can do this."`
    - `"auth.crossOrigin": "Request refused: it came from {{origin}}, but this Pinwall runs at {{expected}}. Open Pinwall at {{expected}}, or set PINWALL_PUBLIC_ORIGIN to the address you use."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`, plain and with the Postgres env. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add sessions, cookie and bearer auth resolution, CSRF origin check, /me and sign-out`.

### Task 4: Setup link and owner setup (model: opus)

**Files:**
- Create: `apps/server/src/auth/{password.ts,setup.ts,startup.ts}`, `apps/server/src/api/setup.ts`, `packages/shared/src/api/{setup.ts,passkeys.ts}`
- Modify: `apps/server/src/main.ts` (`serve` calls `startAuth(deps)` once listening), `apps/server/src/api/router.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`, `apps/server/test/helpers/auth.ts`
- Test: `apps/server/test/api/setup.test.ts`, `apps/server/test/auth/password.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `beginRegistration`, `finishRegistration`, `insertPasskey`, `Db`, `passkeysAvailable`, `SoftAuthenticator`;
  - Task 2: `ownerExists`, `jsonBodyLimit`, `Label`;
  - Task 3: `startSession`, `toMe`, `enforceRateLimit`, `RATE_RULES.setup`, `purgeExpiredSessions`, `apiInit`, `sessionCookieFrom`;
  - M1: `hashPassword`, `verifyPassword`, `hashSecret`, `newSecret`, `newId`, `publicUrl`, `Scheduler`.
- Produces:

```ts
// auth/password.ts — the two constants are also exported from @pinwall/shared for the SPA
export const PASSWORD_MIN_LENGTH = 12; export const PASSWORD_MAX_LENGTH = 256;
export function normalizePassword(pw: string): string;      // pw.normalize('NFKC')
export function checkNewPassword(pw: string): string;       // normalized; code-point length; badRequest(t('auth.passwordTooShort'|…TooLong), { field: 'password' })
export function storePasswordHash(db: Db, userId: string, hash: string, now: number): Promise<void>;   // upsert password_credentials
export function checkPassword(db: Db, userId: string, pw: string): Promise<boolean>;   // normalizes; false without a password
// auth/setup.ts
export const SETUP_LINK_TTL_MS = 86_400_000;
export function announceSetupLink(deps: AppDeps): Promise<string | null>;      // the URL, or null when an owner exists
export function checkSetupToken(deps: AppDeps, token: string): Promise<void>;   // AppError setup_done 409 | forbidden 403
export function beginSetupPasskey(deps: AppDeps, token: string, name: string): Promise<{ ceremonyId: string; options: PublicKeyCredentialCreationOptionsJSON }>;
export interface SetupInput { token: string; name: string; email: string | null; password: string | null;
  passkey: { ceremonyId: string; response: RegistrationResponseJSON; name: string | null } | null }
export function completeSetup(deps: AppDeps, input: SetupInput): Promise<UserRow>;
// auth/startup.ts
export function startAuth(deps: AppDeps): Promise<void>;   // announceSetupLink + scheduler.every('auth-cleanup', 3_600_000, purgeExpiredSessions)
// shared api/passkeys.ts
export const CeremonyOptions;               // { ceremony_id: string, options: z.looseObject({ challenge: z.string() }) }
export const PasskeyRegistrationResponse;   // z.looseObject({ id, rawId, type: z.literal('public-key'),
                                            //   response: z.looseObject({ clientDataJSON, attestationObject }), clientExtensionResults: z.record(…).default({}) })
export const PasskeyAuthenticationResponse; // same shape; response { clientDataJSON, authenticatorData, signature, userHandle? }
// shared api/setup.ts
export const SetupTokenRequest;             // { token: z.string().min(1).max(200) }
export const SetupPasskeyOptionsRequest;    // { token, name: Label }
export const SetupRequest;                  // { token, name: Label, email?: z.email().max(254).nullable(), password?: z.string().min(1).max(1024),
                                            //   passkey?: { ceremony_id: z.string().min(1).max(200), response: PasskeyRegistrationResponse, name?: Label } }
// test/helpers/auth.ts (adds) — runs the real HTTP flow
export function setupOwner(ctx: TestContext, o?: { name?: string; password?: string; passkey?: SoftAuthenticator }): Promise<{ me: Me; cookie: string }>;
```

  Routes. Each uses `jsonBodyLimit` and calls `enforceRateLimit(c, RATE_RULES.setup)` first:
  - `POST /auth/setup/check` → 204.
  - `POST /auth/setup/passkey/options` → 200 `CeremonyOptions`.
  - `POST /auth/setup` → 201 `Me`, plus a session: method `passkey` if a passkey was given, else `password`.

- [ ] **Step 1: Write failing tests.** `password.test.ts`:

```ts
test('normalizes to NFKC and counts code points', () => {
  expect(normalizePassword('ｐａｓｓ１２３')).toBe('pass123');
  expect(normalizePassword('Mật'.normalize('NFD'))).toBe('Mật'.normalize('NFC'));
  expect(() => checkNewPassword('a'.repeat(11))).toThrow(expect.objectContaining({ code: 'bad_request' }));
  expect(checkNewPassword('😀'.repeat(12))).toBe('😀'.repeat(12));
  expect(() => checkNewPassword('a'.repeat(257))).toThrow();
});
```

  `setup.test.ts` (in `describe.each(dialects)`):

```ts
test('announce prints a one-time setup link while no owner exists', async () => {
  const warn = vi.spyOn(ctx.deps.logger, 'warn');
  const url = await announceSetupLink(ctx.deps);
  expect(url).toMatch(/^http:\/\/localhost:8080\/setup\?token=[A-Za-z0-9_-]{43}$/);
  expect(warn).toHaveBeenCalledWith({ setup_url: url }, expect.stringContaining(url!));
});
test('a new announcement replaces the previous link', ...);   // check(old) → 403 forbidden, t('auth.setup.invalidLink'); check(new) → 204
test('the link expires after 24 hours', ...);                 // +86_400_001 → 403
test('setup with a password creates the owner and signs in', ...);
  // { token, name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' } → 201 { kind: 'owner', role: 'admin', name: 'Ada',
  //   email: 'ada@example.com', email_verified: false, via: 'session', credentials: { password: true, passkeys: 0 } };
  //   its cookie → GET /me 200; one users row; hash starts with 'scrypt$'
test('setup with a passkey', ...);   // passkey/options { token, name } → a.register → setup { passkey: { ceremony_id, response, name: 'Laptop' } }
  // → 201, credentials { password: false, passkeys: 1 }; passkeys row name 'Laptop', user_id === body.id
test('setup needs a password or a passkey', ...);             // → 400 bad_request, t('auth.setup.needCredential')
test('the link works once', ...);                             // 2nd setup → 409 setup_done; check → 409; announce → null, no warn
test('a rejected setup attempt leaves the link usable', ...); // 'short' → 400 t('auth.passwordTooShort', { min: 12 });
  // a passkey response made for origin http://evil.example → 401 invalid_credentials; then a password setup → 201
test('two concurrent setups create one owner', ...);          // Promise.all → statuses sorted [201, 409]; one users row
test('a wrong token is forbidden', ...);                      // → 403 forbidden
test('setup by password works where passkeys are unavailable', ...);   // http://pinwall.lan:8080: passkey/options 400 t('auth.passkeysUnavailable'); password → 201
test('setup cookie is Secure and __Host- on an https origin although the request is http', ...);
  // https://pinwall.test, request URL http://internal:8080/api/v1/auth/setup → '__Host-pinwall_session=' with Secure, HttpOnly, SameSite=Lax, Path=/
test('setup is rate limited per IP', ...);                    // 10 wrong-token checks → 403; the 11th → 429 with a numeric Retry-After
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/setup test/auth/password`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Store keys:** `setup:current` → `{ hash }` and `setup:<hash>` → `{ created_at }`, both with `SETUP_LINK_TTL_MS`.
  - **`announceSetupLink`:** null if an owner exists; else delete the `setup:<hash>` that `setup:current` points to, mint `newSecret()`, store both keys, and `deps.logger.warn({ setup_url }, t('log.setupLink', { url }))` with `url = publicUrl(config, '/setup?token=' + token)`.
  - **`checkSetupToken`:** an owner exists → `new AppError('setup_done', 409, t('auth.setup.done'))`; else a null `peek('setup:' + hashSecret(token))` → `forbidden(t('auth.setup.invalidLink'))`. **`beginSetupPasskey`:** `checkSetupToken`, then `beginRegistration` with purpose `'setup'` and a fresh `newId('usr')`.
  - **`completeSetup`, in this order (the Review Focus 4 guarantee):**
    1. Neither credential → `badRequest(t('auth.setup.needCredential'))`.
    2. `checkNewPassword` + `hashPassword`, before any transaction.
    3. `checkSetupToken`.
    4. `finishRegistration({ purpose: 'setup' })`; its `userId` is the owner's id (else `newId('usr')`).
    5. `take('setup:' + hash)`; null means a concurrent request won → `setup_done` 409.
    6. One transaction: insert the user (`kind 'owner'`, `email_verified 0`, created/last seen now), the password hash, the passkey (`name ?? 'Passkey 1'`); then delete `setup:current`.
  - **en.json:**
    - `"log.setupLink": "Pinwall has no owner account yet. Open this link within 24 hours to create it: {{url}}"`
    - `"auth.setup.invalidLink": "This setup link is invalid or has expired. Restart Pinwall to print a new one in the log."`
    - `"auth.setup.done": "Setup is already complete. Sign in instead."`
    - `"auth.setup.needCredential": "Choose a password, a passkey, or both."`
    - `"auth.passwordTooShort": "Use at least {{min}} characters."`
    - `"auth.passwordTooLong": "Use at most {{max}} characters."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`. Expected: PASS.
- [ ] **Step 5: Smoke run.**
  1. Start `PINWALL_DATA_DIR=$(mktemp -d) pnpm --filter @pinwall/server exec tsx src/main.ts serve` in the background. Expected: after `listening`, a warn line containing `/setup?token=`.
  2. Run `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'origin: http://localhost:8080' -H 'content-type: application/json' -d '{"token":"<token>"}' localhost:8080/api/v1/auth/setup/check`. Expected: `204`.
  3. Restart with the same data dir. Expected: a new token in the log; the old one now gets `403`.
- [ ] **Step 6: Commit** `feat(server): add one-time setup link and owner account setup by password or passkey`.

### Task 5: Owner sign-in by password and passkey (model: opus)

**Files:**
- Create: `apps/server/src/auth/owner-sign-in.ts`
- Modify: `apps/server/src/api/auth.ts`, `packages/shared/src/api/auth.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/sign-in.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `beginAuthentication`, `finishAuthentication`, `SoftAuthenticator`;
  - Task 2: `getOwner`, `jsonBodyLimit`;
  - Task 3: `startSession`, `toMe`, `hasAccess`, `enforceRateLimit`, `RATE_RULES`, `apiInit`, `sessionCookieFrom`;
  - Task 4: `checkPassword`, `setupOwner`, `CeremonyOptions`, `PasskeyAuthenticationResponse`.
- Produces:

```ts
export function signInWithPassword(deps: AppDeps, password: string): Promise<UserRow>;
  // AppError setup_required 409 t('auth.setup.required') | invalid_credentials 401 t('auth.wrongPassword') | access_denied 403
export function beginPasskeySignIn(deps: AppDeps): Promise<{ ceremonyId: string; options: PublicKeyCredentialRequestOptionsJSON }>;  // setup_required 409 without owner
export function signInWithPasskey(deps: AppDeps, ceremonyId: string, response: AuthenticationResponseJSON): Promise<UserRow>;     // invalid_credentials | access_denied
// shared: PasswordSignInRequest { password: z.string().min(1).max(1024) }; PasskeySignInRequest { ceremony_id, response: PasskeyAuthenticationResponse }
```

  Routes:
  - `POST /auth/password/sign-in` → 200 `Me` plus a session. Rate limits: `RATE_RULES.password` per IP, then `RATE_RULES.passwordGlobal` with key `'all'`.
  - `POST /auth/passkey/options` → 200 `CeremonyOptions`. Rate limit: `RATE_RULES.passkey`.
  - `POST /auth/passkey/sign-in` → 200 `Me` plus a session. Rate limit: `RATE_RULES.passkey`.

- [ ] **Step 1: Write failing tests** (in `describe.each(dialects)`; `signIn(pw)` = `ctx.request('/api/v1/auth/password/sign-in', apiInit(ctx, { body: { password: pw } }))`):

```ts
test('password sign-in returns the owner and a session', ...);  // setupOwner({ password }); signIn → 200 Me via 'session' + cookie
test('a wrong password is invalid_credentials and sets no cookie', ...);
test('sign-in before setup is setup_required', ...);            // signIn and passkey/options → 409 setup_required
test('a passkey-only owner cannot sign in by password', ...);   // → 401
test('sign-in replaces the session presented with the request', ...);   // with cookie A → A's row gone, new cookie differs
test('passkey sign-in', ...);   // setupOwner({ passkey: a }); options lack allowCredentials; a.authenticate → 200; row counter 1, last_used_at now
test('a replayed passkey assertion is refused', ...);           // the same body twice → 2nd 401 invalid_credentials
test('an unknown passkey is refused', ...);                     // authenticator registered only via simplewebauthn's own options → 401
test('a blocked owner cannot sign in', ...);                    // role_override 'blocked' → 403 access_denied by password and by passkey
test('password in another Unicode form still signs in', async () => {
  const pw = 'Mật khẩu của tôi ２０２６';
  await setupOwner(ctx, { password: pw.normalize('NFD') });
  for (const v of [pw.normalize('NFC'), 'Mật khẩu của tôi 2026']) expect((await signIn(v)).status).toBe(200);
});
test('password sign-in is rate limited per IP', ...);   // PINWALL_TRUST_PROXY=true; 10 wrong from x-forwarded-for 203.0.113.7 → 401;
  // the 11th → 429 rate_limited with 1 <= Number(retry-after) <= 900; one from 203.0.113.8 → 401
test('password sign-in also has a global limit', ...);  // 100 × rateLimiter.consume('password-global:all', 100, 3_600_000), then the right password → 429
test('passkey endpoints are rate limited per IP', ...);  // 30 × passkey/options → 200, the 31st → 429
test('a missing password is bad_request with issues', ...);   // {} → 400, details.issues[0].path 'password'
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/sign-in`. Expected: FAIL.
- [ ] **Step 3: Implement the services and routes.**
  - Look the owner up with `getOwner`.
  - Run the access check only after the credential has been verified, so a wrong password never learns whether the account is blocked.
  - On success, call `startSession(c, user, 'password' | 'passkey')` and return `toMe`.
  - en.json:
    - `"auth.wrongPassword": "Wrong password."`
    - `"auth.setup.required": "Pinwall is not set up yet. Open the setup link printed in the server log."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add owner sign-in by password and passkey with rate limits`.

### Task 6: Personal API tokens (model: opus)

**Files:**
- Create: `apps/server/src/auth/api-tokens.ts`, `apps/server/src/api/tokens.ts`, `packages/shared/src/api/tokens.ts`
- Modify: `apps/server/src/auth/resolvers.ts` (append `apiTokenResolver`), `apps/server/src/api/router.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`, `apps/server/test/helpers/auth.ts`
- Test: `apps/server/test/api/tokens.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `page`, `Label`, `Timestamp`, `jsonBodyLimit`;
  - Task 3: `BearerResolver`, `bearerResolvers`, `requireSession`, `authOf`, `createSignedInUser`, `apiInit`;
  - M1: `newId('tok')`, `newSecret`, `hashSecret`, `ApiTokenRow`.
- Produces:

```ts
export const API_TOKEN_PREFIX = 'pw_'; export const MAX_ACTIVE_TOKENS = 100; export const TOKEN_TOUCH_INTERVAL_MS = 60_000;
export function createApiToken(deps: AppDeps, userId: string, p: { name: string; expiresInDays: number | null }):
  Promise<{ row: ApiTokenRow; secret: string }>;           // secret 'pw_' + newSecret(); prefix = secret.slice(0, 11)
export function listApiTokens(deps: AppDeps, userId: string): Promise<ApiTokenRow[]>;           // not revoked, newest first
export function revokeApiToken(deps: AppDeps, userId: string, tokenId: string): Promise<void>;  // notFound unless the user's and active
export const apiTokenResolver: BearerResolver;             // matches t.startsWith('pw_') → { user, via: 'api_token' }
// shared: ApiToken { id, name, prefix, created_at, last_used_at|null, expires_at|null }; ApiTokenList = page(ApiToken);
//   CreateApiTokenRequest { name: Label, expires_in_days?: z.number().int().min(1).max(3650).nullable() }; CreatedApiToken { token: ApiToken, secret }
// test/helpers/auth.ts (adds)
export function createUserToken(ctx: TestContext, userId: string, o?: { name?: string; expiresInDays?: number | null }): Promise<string>;
```

  Routes, all guarded by `requireSession`, so tokens cannot manage tokens:
  - `GET /me/tokens` → 200 `ApiTokenList` (`next_cursor: null`).
  - `POST /me/tokens` → 201 `CreatedApiToken`.
  - `DELETE /me/tokens/{id}` → 204.

- [ ] **Step 1: Write failing tests** (in `describe.each(dialects)`):

```ts
test('creates a token and shows the secret once', ...);
  // POST { name: 'ci' } → 201 { token: { name: 'ci', prefix: secret.slice(0, 11), expires_at: null, last_used_at: null },
  //   secret: /^pw_[A-Za-z0-9_-]{43}$/ }; GET list → items[0] has no 'secret' and no 'token_hash' key
test('a token authenticates /me', ...);       // 200 via 'api_token'; token_hash === hashSecret(secret); no column holds the secret
test('last use is recorded', ...);            // +120_000, GET /me with it → listed last_used_at === clock.now()
test('an expired token is refused', ...);     // expires_in_days 1 → expires_at = now + 86_400_000; +86_400_000 → 401 'invalid_token'
test('a revoked token is refused and leaves the list', ...);
test("another user's token cannot be revoked", ...);   // 404 not_found; the token still works
test('tokens cannot manage tokens', ...);     // POST /me/tokens with a bearer → 403 t('auth.sessionRequired')
test('expiry outside 1..3650 days is bad_request', ...);   // 0 and 3651 → 400
test('at most 100 active tokens', ...);       // 100 via createApiToken, the 101st via the API → 409 conflict t('auth.tokenLimit', { max: 100 })
test('a token of a user without access is access_denied', ...);   // role_override 'blocked' → 403 access_denied
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/tokens`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Resolver:** look up by `token_hash`; refuse when revoked or `expires_at <= now`; when `last_used_at` is null or older than `TOKEN_TOUCH_INTERVAL_MS`, update it and `users.last_seen_at`. `expires_at = now + days * 86_400_000`. Only tokens neither revoked nor expired count toward the limit.
  - **en.json:** `"auth.tokenLimit": "You have reached the limit of {{max}} API tokens. Revoke one first."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): add personal API tokens and bearer token authentication`.

### Task 7: Owner profile, password and passkey management (model: opus)

**Files:**
- Create: `apps/server/src/auth/account.ts`, `apps/server/src/api/account.ts`, `packages/shared/src/api/account.ts`
- Modify: `apps/server/src/api/router.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/account.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `beginRegistration`, `finishRegistration`, `insertPasskey`, `listPasskeys`, `SoftAuthenticator`;
  - Task 3: `requireAuth`, `requireSession`, `requireOwner`, `authOf`, `deleteUserSessions`, `toMe`, `enforceRateLimit`, `RATE_RULES.password`;
  - Task 4: `checkNewPassword`, `checkPassword`, `storePasswordHash`, `setupOwner`, `CeremonyOptions`, `PasskeyRegistrationResponse`;
  - Task 6: `createUserToken`.
- Produces:

```ts
export function updateProfile(deps: AppDeps, userId: string, p: { name?: string; email?: string | null }): Promise<UserRow>;
export function changePassword(deps: AppDeps, auth: AuthContext, p: { current: string | null; next: string }): Promise<void>;  // ends other sessions
export function removePassword(deps: AppDeps, userId: string): Promise<void>;
export function renamePasskey(deps: AppDeps, userId: string, passkeyId: string, name: string): Promise<PasskeyRow>;
export function deletePasskey(deps: AppDeps, userId: string, passkeyId: string): Promise<void>;
export function lockUser(trx: Transaction<Database>, dialect: 'sqlite' | 'postgres', userId: string): Promise<void>;
  // postgres: SELECT id FROM users WHERE id = ? FOR UPDATE; sqlite: no-op (a single writer)
// shared: UpdateProfileRequest { name?: Label, email?: z.email().max(254).nullable() }; ChangePasswordRequest { current_password?, new_password } (1..1024);
//   Passkey { id, name, transports: string[], created_at, last_used_at|null }; PasskeyList = page(Passkey);
//   AddPasskeyRequest { ceremony_id, response: PasskeyRegistrationResponse, name?: Label }; RenamePasskeyRequest { name: Label }
```

  Routes:

  | Route | Guards | Success |
  | --- | --- | --- |
  | `PATCH /me` | auth, owner | 200 `Me` |
  | `PUT /me/password` | session, owner | 204 |
  | `DELETE /me/password` | session, owner | 204 |
  | `GET /me/passkeys` | auth, owner | 200 `PasskeyList` (`next_cursor: null`) |
  | `POST /me/passkeys/options` | session, owner | 200 `CeremonyOptions` (purpose `add`, existing passkeys excluded) |
  | `POST /me/passkeys` | session, owner | 201 `Passkey` (default name `Passkey <count + 1>`) |
  | `PATCH /me/passkeys/{id}` | session, owner | 200 `Passkey` |
  | `DELETE /me/passkeys/{id}` | session, owner | 204 |

- [ ] **Step 1: Write failing tests** (in `describe.each(dialects)`):

```ts
test('the owner updates name and email', ...);          // PATCH /me { name: 'Ada L.', email: null } → 200 with both changed
test('account routes are owner-only', ...);             // oidc member: PATCH /me, GET /me/passkeys → 403 t('auth.ownerOnly')
test('credential changes need a browser session', ...); // owner token: PUT /me/password, POST /me/passkeys/options → 403 t('auth.sessionRequired')
test('changing the password ends other sessions and keeps this one', ...);
  // S1, S2; PUT via S1 → 204; S2 → 401; S1 → 200; old password → 401 at sign-in; new → 200
test('a wrong current password is refused', ...);       // → 401 invalid_credentials
test('a passkey-only owner adds a password without a current one', ...);   // → 204; Me credentials.password true
test('the new password policy applies', ...);           // 'short' → 400
test('add, list, rename and delete passkeys', ...);     // add 'Phone' → 201; list 2 oldest first; rename 'Work phone' → 200; delete → 204; list 1
test('the add ceremony excludes registered passkeys', ...);   // excludeCredentials ids === stored credential ids
test('the last credential cannot be removed', ...);
  // password + 1 passkey: delete passkey → 204, then DELETE /me/password → 409 conflict t('auth.lastCredential');
  // passkey-only with 2: delete one → 204, delete the other → 409
test('an unknown passkey id is not_found', ...);        // PATCH and DELETE → 404
```

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/account`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Removing a credential** (`removePassword`, `deletePasskey`): one transaction — `lockUser`, count passkeys plus 1 if a password exists, refuse with `conflict(t('auth.lastCredential'))` when the removal would leave 0. The lock keeps two concurrent removals from both passing the count on Postgres.
  - **`changePassword`:** with an existing password, `current` is required (the route applies `RATE_RULES.password`; a mismatch is 401 `invalid_credentials` `t('auth.wrongPassword')`). After storing the new hash, `deleteUserSessions(…, { exceptIdHash: auth.sessionId })`. A duplicate `credential_id` is a `conflict`.
  - **en.json.** `"auth.lastCredential": "You cannot remove your last way to sign in. Add a passkey or a password first."`
- [ ] **Step 4: Run** `pnpm --filter @pinwall/server test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): let the owner manage profile, password and passkeys`.

### Task 8: Admin users, role override, Revoke now, milestone flow (model: sonnet)

**Files:**
- Create: `apps/server/src/auth/{revoke.ts,admin-users.ts}`, `apps/server/src/api/admin-users.ts`, `packages/shared/src/api/admin.ts`
- Modify: `apps/server/src/api/router.ts`, `packages/shared/src/api/index.ts`, `packages/shared/src/i18n/en.json`
- Test: `apps/server/test/api/admin-users.test.ts`, `apps/server/test/api/identity-flow.test.ts`

**Interfaces:**
- Consumes:
  - Task 1: `SoftAuthenticator`;
  - Task 2: `encodeCursor`, `decodeCursor`, `page`;
  - Task 3: `requireAdmin`, `authOf`, `effectiveRole`, `Role`, `createSignedInUser`, `apiInit`;
  - Task 4: `setupOwner`;
  - Task 6: `createUserToken`.
- Produces:

```ts
// auth/revoke.ts — M3's access re-check also calls this
export interface RevokeResult { sessions: number; apiTokens: number; oauthGrants: number }
export function revokeAllCredentials(deps: AppDeps, userId: string): Promise<RevokeResult>;
  // one transaction: delete sessions; api_tokens.revoked_at = now where null; oauth_grants.revoked_at = now where null,
  // and delete every oauth_tokens row of the user's grants
// auth/admin-users.ts
export function listUsers(deps: AppDeps, p: { limit: number; cursor: string | null }): Promise<{ items: UserRow[]; nextCursor: string | null }>;
  // created_at, id ascending; cursor { c: created_at, i: id }
export function setRoleOverride(deps: AppDeps, actor: UserRow, userId: string, role: Role | 'blocked' | null): Promise<UserRow>;
  // forbidden t('auth.ownRole') when actor.id === userId; notFound
// shared: AdminUser { id, kind, name, email, email_verified, avatar_url, idp_role|null, role_override|null,
//   effective_role: 'admin'|'member'|'blocked'|null, disabled_at, disabled_reason, created_at, last_seen_at }; AdminUserList = page(AdminUser);
//   SetRoleRequest { role_override: z.enum(['admin','member','blocked']).nullable() }; RevokeResult { sessions, api_tokens, oauth_grants }
```

  Routes are guarded by `requireAdmin` and accept any credential type:
  - `GET /admin/users?limit=&cursor=` (limit 1–200, default 50) → 200 `AdminUserList`.
  - `PUT /admin/users/{id}/role` → 200 `AdminUser`.
  - `POST /admin/users/{id}/revoke` → 200 `RevokeResult`, or 404 for an unknown user. Revoking yourself is allowed; it signs you out everywhere.

  Both changes log at info: `{ actor_id, user_id, role_override }` with `'role override changed'`, and `{ actor_id, user_id, sessions, api_tokens, oauth_grants }` with `'credentials revoked'`.

- [ ] **Step 1: Write failing tests.** `admin-users.test.ts` (in `describe.each(dialects)`):

```ts
test('admins list users with their effective role', ...);   // owner, oidc member, oidc without role → ['admin', 'member', null]
test('the list pages with a cursor', ...);                  // limit=2 → next_cursor; page 2 has 1 item, next_cursor null; garbage cursor → 400
test('members cannot use admin routes', ...);               // → 403 t('auth.adminOnly')
test('set a role override and clear it', ...);              // member → 'admin' → effective 'admin'; null → 'member'
test('blocking takes effect at once', ...);                 // PUT 'blocked' → the member's session 401 (cookie cleared), token 403 access_denied
test('admins cannot change their own role', ...);           // → 403 t('auth.ownRole')
test('an unknown user is not_found', ...);
test('Revoke now ends every credential', ...);
  // member: 2 sessions, 2 tokens, and an inserted oauth_clients + oauth_grants row with 2 oauth_tokens rows →
  // { sessions: 2, api_tokens: 2, oauth_grants: 1 }; sessions and tokens → 401; grant revoked_at === now; its oauth_tokens gone;
  // a second revoke → all zeros
test('Revoke now works with an admin API token from any origin', ...);   // Bearer + origin https://evil.example → 200
```

  `identity-flow.test.ts` walks the roadmap's M2 "done when" in one flow. It uses `PINWALL_PUBLIC_ORIGIN=https://pinwall.test` and sends every request to `http://internal:8080`:
  1. Announce the link and set up by password → 201. The same link again → 409 `setup_done`.
  2. Sign out, then sign in by password → 200, with Set-Cookie `__Host-pinwall_session=…` carrying `Secure`.
  3. Add a passkey from a `SoftAuthenticator` on `https://pinwall.test`. Sign out, then sign in by passkey → 200.
  4. Create an API token. `GET /me` with it → `via: 'api_token'`.
  5. `POST /auth/sign-out` with the cookie and origin `https://evil.example` → 403, and the session still works.
  6. `GET /api/v1/openapi.json` lists every M2 path:
     - `/config/public`, `/me`, `/me/password`, `/me/passkeys`, `/me/passkeys/options`, `/me/passkeys/{id}`, `/me/tokens`, `/me/tokens/{id}`;
     - `/auth/setup`, `/auth/setup/check`, `/auth/setup/passkey/options`, `/auth/password/sign-in`, `/auth/passkey/options`, `/auth/passkey/sign-in`, `/auth/sign-out`;
     - `/admin/users`, `/admin/users/{id}/role`, `/admin/users/{id}/revoke`.
  7. The owner revokes their own credentials with `POST /admin/users/<own id>/revoke` → `sessions >= 1` and `api_tokens >= 1`. Afterwards the session and the token both get 401.

- [ ] **Step 2: Run** `pnpm --filter @pinwall/server test test/api/admin-users test/api/identity-flow`. Expected: FAIL.
- [ ] **Step 3: Implement** the services and routes. en.json: `"auth.ownRole": "You cannot change your own role."`
- [ ] **Step 4: Run** `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm test:integration`. Expected: all pass, with the Postgres suites run, not skipped.
- [ ] **Step 5: Commit** `feat(server): add admin user list, role override and Revoke now`.

---

## M2 done when

- `pnpm lint && pnpm typecheck && pnpm test` pass.
- `pnpm test:integration` passes, with the M2 suites run on both SQLite and Postgres.
- `identity-flow.test.ts` passes, which shows that:
  - the setup link works once;
  - the owner signs in by password and by a software passkey;
  - a token authenticates `/api/v1/me`;
  - a cross-origin POST with a session cookie is refused;
  - cookies carry `Secure` on an https origin even though requests arrive over http;
  - Revoke now ends every credential.
- The Task 4 smoke run prints the setup link.
