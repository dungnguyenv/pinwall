import { CeremonyOptions, CreatedApiToken, Me, Passkey, RevokeResult } from '@pinwall/shared';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { afterEach, describe, expect, test } from 'vitest';
import { announceSetupLink } from '../../src/auth/setup.ts';
import { t } from '../../src/lib/i18n.ts';
import { apiInit, sessionCookieFrom } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { SoftAuthenticator } from '../helpers/soft-authenticator.ts';

const PASSWORD = 'correct horse battery staple';
const PUBLIC_ORIGIN = 'https://pinwall.test';
/** Where requests arrive: a TLS-terminating proxy forwards them over plain http. */
const INTERNAL = 'http://internal:8080';

const M2_PATHS = [
  '/config/public',
  '/me',
  '/me/password',
  '/me/passkeys',
  '/me/passkeys/options',
  '/me/passkeys/{id}',
  '/me/tokens',
  '/me/tokens/{id}',
  '/auth/setup',
  '/auth/setup/check',
  '/auth/setup/passkey/options',
  '/auth/password/sign-in',
  '/auth/passkey/options',
  '/auth/passkey/sign-in',
  '/auth/sign-out',
  '/admin/users',
  '/admin/users/{id}/role',
  '/admin/users/{id}/revoke',
];

describe.each(dialects)('M2 identity flow on %s', (dialect) => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  const send = (path: string, init: RequestInit) => ctx.request(`${INTERNAL}/api/v1${path}`, init);
  const errorOf = async (r: Response) => ((await r.json()) as { error: unknown }).error;

  test('the owner sets up, signs in two ways, uses a token and revokes everything', async () => {
    ctx = await createTestContext({ dialect, env: { PINWALL_PUBLIC_ORIGIN: PUBLIC_ORIGIN } });

    // 1. The setup link works once.
    const link = await announceSetupLink(ctx.deps);
    const token = new URL(link ?? '').searchParams.get('token') ?? '';
    expect(token).not.toBe('');
    const setup = { token, name: 'Ada', password: PASSWORD };
    const created = await send('/auth/setup', apiInit(ctx, { body: setup }));
    expect(created.status).toBe(201);
    const owner = Me.parse(await created.json());
    expect(owner).toMatchObject({ kind: 'owner', name: 'Ada', role: 'admin', via: 'session' });
    const setupCookie = sessionCookieFrom(created);
    expect(setupCookie).toMatch(/^__Host-pinwall_session=/);

    const again = await send('/auth/setup', apiInit(ctx, { body: setup }));
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toEqual({ code: 'setup_done', message: t('auth.setup.done') });

    // 2. Sign out, sign in by password: the cookie is Secure although the request is http.
    const out = await send(
      '/auth/sign-out',
      apiInit(ctx, { method: 'POST', cookie: setupCookie ?? '' }),
    );
    expect(out.status).toBe(204);
    expect((await send('/me', apiInit(ctx, { cookie: setupCookie ?? '' }))).status).toBe(401);

    const password = await send(
      '/auth/password/sign-in',
      apiInit(ctx, { body: { password: PASSWORD } }),
    );
    expect(password.status).toBe(200);
    const setCookie = password.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/^__Host-pinwall_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    const cookie = sessionCookieFrom(password) ?? '';
    expect(Me.parse(await (await send('/me', apiInit(ctx, { cookie }))).json()).id).toBe(owner.id);

    // 3. Add a passkey from a software authenticator, sign out, sign in with it.
    const authenticator = new SoftAuthenticator({ origin: PUBLIC_ORIGIN });
    const begin = await send('/me/passkeys/options', apiInit(ctx, { method: 'POST', cookie }));
    expect(begin.status).toBe(200);
    const creation = CeremonyOptions.parse(await begin.json());
    const registered = await send(
      '/me/passkeys',
      apiInit(ctx, {
        cookie,
        body: {
          ceremony_id: creation.ceremony_id,
          response: authenticator.register(
            creation.options as unknown as PublicKeyCredentialCreationOptionsJSON,
          ),
        },
      }),
    );
    expect(registered.status).toBe(201);
    Passkey.parse(await registered.json());

    await send('/auth/sign-out', apiInit(ctx, { method: 'POST', cookie }));
    expect((await send('/me', apiInit(ctx, { cookie }))).status).toBe(401);

    const request = await send('/auth/passkey/options', apiInit(ctx, { method: 'POST' }));
    expect(request.status).toBe(200);
    const assertion = CeremonyOptions.parse(await request.json());
    const options = assertion.options as unknown as PublicKeyCredentialRequestOptionsJSON;
    expect(options.rpId).toBe('pinwall.test');
    const passkey = await send(
      '/auth/passkey/sign-in',
      apiInit(ctx, {
        body: { ceremony_id: assertion.ceremony_id, response: authenticator.authenticate(options) },
      }),
    );
    expect(passkey.status).toBe(200);
    expect(passkey.headers.getSetCookie().join('\n')).toContain('Secure');
    const passkeyCookie = sessionCookieFrom(passkey) ?? '';
    expect(passkeyCookie).toMatch(/^__Host-pinwall_session=/);

    // 4. An API token authenticates /me.
    const minted = await send(
      '/me/tokens',
      apiInit(ctx, { cookie: passkeyCookie, body: { name: 'ci' } }),
    );
    expect(minted.status).toBe(201);
    const { secret } = CreatedApiToken.parse(await minted.json());
    const viaToken = await send('/me', apiInit(ctx, { bearer: secret }));
    expect(viaToken.status).toBe(200);
    expect(Me.parse(await viaToken.json())).toMatchObject({ id: owner.id, via: 'api_token' });

    // 5. A cross-origin POST with the session cookie is refused, and the session survives.
    const cross = await send(
      '/auth/sign-out',
      apiInit(ctx, { method: 'POST', cookie: passkeyCookie, origin: 'https://evil.example' }),
    );
    expect(cross.status).toBe(403);
    expect(await errorOf(cross)).toMatchObject({
      code: 'forbidden',
      details: { origin: 'https://evil.example', expected_origin: PUBLIC_ORIGIN },
    });
    expect((await send('/me', apiInit(ctx, { cookie: passkeyCookie }))).status).toBe(200);

    // 6. The OpenAPI document lists every M2 path.
    const doc = await send('/openapi.json', apiInit(ctx));
    expect(doc.status).toBe(200);
    const { paths } = (await doc.json()) as { paths: Record<string, unknown> };
    for (const path of M2_PATHS) expect(Object.keys(paths), path).toContain(path);

    // 7. Revoke now ends the owner's own credentials.
    const revoked = await send(
      `/admin/users/${owner.id}/revoke`,
      apiInit(ctx, { method: 'POST', cookie: passkeyCookie }),
    );
    expect(revoked.status).toBe(200);
    const result = RevokeResult.parse(await revoked.json());
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.api_tokens).toBeGreaterThanOrEqual(1);
    expect((await send('/me', apiInit(ctx, { cookie: passkeyCookie }))).status).toBe(401);
    expect((await send('/me', apiInit(ctx, { bearer: secret }))).status).toBe(401);
  });
});
