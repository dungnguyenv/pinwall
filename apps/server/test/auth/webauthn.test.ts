import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findPasskeyByCredentialId, insertPasskey, listPasskeys } from '../../src/auth/passkeys.ts';
import {
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
  type PasskeyRegistration,
  passkeysAvailable,
  SUPPORTED_ALGORITHM_IDS,
} from '../../src/auth/webauthn.ts';
import { loadConfig } from '../../src/config/load.ts';
import type { AppDeps } from '../../src/deps.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { AppError } from '../../src/lib/errors.ts';
import { t } from '../../src/lib/i18n.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { SoftAuthenticator } from '../helpers/soft-authenticator.ts';

const T = 1_762_000_000_000;
const ORIGIN = 'http://localhost:8080';
const ADA = 'usr_0000000000000000000a';
const BOB = 'usr_0000000000000000000b';

async function insertUser(deps: AppDeps, id: string): Promise<void> {
  await deps.db.db
    .insertInto('users')
    .values({ id, kind: 'owner', email_verified: 0, created_at: deps.clock.now() })
    .execute();
}

/** Every passkey failure looks the same to the caller. */
async function expectPasskeyFailure(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({
    code: 'invalid_credentials',
    status: 401,
    message: t('auth.passkeyFailed'),
  });
}

describe.each(dialects)('WebAuthn ceremonies on %s', (dialect) => {
  let ctx: TestContext;
  let clock: FixedClock;
  let a: SoftAuthenticator;

  beforeEach(async () => {
    clock = new FixedClock(T);
    ctx = await createTestContext({ dialect, clock });
    a = new SoftAuthenticator({ origin: ORIGIN });
  });
  afterEach(() => ctx.close());

  function beginSetup(deps: AppDeps = ctx.deps, userId = ADA) {
    return beginRegistration(deps, {
      purpose: 'setup',
      userId,
      userName: 'Ada',
      displayName: 'Ada',
      exclude: [],
    });
  }

  /** Registers a passkey through the service and stores it, as setup would. */
  async function storedPasskey(userId = ADA): Promise<PasskeyRegistration> {
    const { ceremonyId, options } = await beginSetup(ctx.deps, userId);
    const reg = await finishRegistration(ctx.deps, {
      purpose: 'setup',
      ceremonyId,
      response: a.register(options),
    });
    await insertUser(ctx.deps, userId);
    await insertPasskey(ctx.deps.db.db, { ...reg, name: 'Laptop', now: clock.now() });
    return reg;
  }

  test('registration round-trips through the soft authenticator', async () => {
    const { ceremonyId, options } = await beginSetup();
    expect(options.rp).toEqual({ name: 'Pinwall', id: 'localhost' });
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-8, -7, -257]);
    expect(options.timeout).toBe(300_000);
    expect(Buffer.from(options.user.id, 'base64url').toString('utf8')).toBe(ADA);
    expect(options.user).toMatchObject({ name: 'Ada', displayName: 'Ada' });

    const reg = await finishRegistration(ctx.deps, {
      purpose: 'setup',
      ceremonyId,
      response: a.register(options),
    });
    expect(reg).toMatchObject({ userId: ADA, credentialId: a.credentials[0]?.id, counter: 0 });
    expect(reg.transports).toEqual(['internal']);
    expect(reg.publicKey).toMatch(/^[\w-]+$/);
  });

  test('registration excludes the passkeys the user already has', async () => {
    const exclude = [{ credentialId: 'Y3JlZC0x', transports: ['internal', 'hybrid'] }];
    const { options } = await beginRegistration(ctx.deps, {
      purpose: 'add',
      userId: ADA,
      userName: 'Ada',
      displayName: 'Ada',
      exclude,
    });
    expect(options.excludeCredentials).toEqual([
      { id: 'Y3JlZC0x', transports: ['internal', 'hybrid'], type: 'public-key' },
    ]);
  });

  test('a ceremony can be finished once', async () => {
    const { ceremonyId, options } = await beginSetup();
    const response = a.register(options);
    await finishRegistration(ctx.deps, { purpose: 'setup', ceremonyId, response });
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, { purpose: 'setup', ceremonyId, response }),
    );
  });

  test('a ceremony expires after five minutes', async () => {
    const { ceremonyId, options } = await beginSetup();
    clock.advance(300_001);
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, { purpose: 'setup', ceremonyId, response: a.register(options) }),
    );
  });

  test('an unknown ceremony is refused', async () => {
    const { options } = await beginSetup();
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, {
        purpose: 'setup',
        ceremonyId: 'not-a-ceremony',
        response: a.register(options),
      }),
    );
  });

  test('a setup ceremony cannot finish an add', async () => {
    const { ceremonyId, options } = await beginSetup();
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, {
        purpose: 'add',
        ceremonyId,
        userId: ADA,
        response: a.register(options),
      }),
    );
  });

  test('a registration ceremony cannot finish an authentication, nor the reverse', async () => {
    await storedPasskey();
    const registration = await beginSetup(ctx.deps, BOB);
    const authentication = await beginAuthentication(ctx.deps);
    // Each response is valid for the other ceremony's challenge: only the ceremony type differs.
    await expectPasskeyFailure(
      finishAuthentication(ctx.deps, {
        ceremonyId: registration.ceremonyId,
        response: a.authenticate({ challenge: registration.options.challenge, rpId: 'localhost' }),
      }),
    );
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, {
        purpose: 'setup',
        ceremonyId: authentication.ceremonyId,
        response: a.register({
          ...registration.options,
          challenge: authentication.options.challenge,
        }),
      }),
    );
  });

  test('an add ceremony is bound to its user', async () => {
    const add = () =>
      beginRegistration(ctx.deps, {
        purpose: 'add',
        userId: ADA,
        userName: 'Ada',
        displayName: 'Ada',
        exclude: [],
      });

    const other = await add();
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, {
        purpose: 'add',
        ceremonyId: other.ceremonyId,
        userId: BOB,
        response: a.register(other.options),
      }),
    );

    const missing = await add();
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, {
        purpose: 'add',
        ceremonyId: missing.ceremonyId,
        response: a.register(missing.options),
      }),
    );

    const own = await add();
    const reg = await finishRegistration(ctx.deps, {
      purpose: 'add',
      ceremonyId: own.ceremonyId,
      userId: ADA,
      response: a.register(own.options),
    });
    expect(reg.userId).toBe(ADA);
  });

  test('registration from another origin is refused', async () => {
    const { ceremonyId, options } = await beginSetup();
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, {
        purpose: 'setup',
        ceremonyId,
        response: a.register(options, { origin: 'http://127.0.0.1:8080' }),
      }),
    );
  });

  test('a tampered registration is refused', async () => {
    const { ceremonyId, options } = await beginSetup();
    const response = a.register(options);
    response.response.attestationObject = 'AAAA';
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, { purpose: 'setup', ceremonyId, response }),
    );
  });

  test('user verification is required', async () => {
    const noUv = new SoftAuthenticator({ origin: ORIGIN, uv: false });
    const { ceremonyId, options } = await beginSetup();
    const response = noUv.register(options);
    await expectPasskeyFailure(
      finishRegistration(ctx.deps, { purpose: 'setup', ceremonyId, response }),
    );

    // A passkey that was stored anyway still cannot sign in without user verification.
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: options.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: 'localhost',
      requireUserVerification: false,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
    if (!v.verified) throw new Error('expected the lenient check to pass');
    await insertUser(ctx.deps, ADA);
    await insertPasskey(ctx.deps.db.db, {
      userId: ADA,
      credentialId: v.registrationInfo.credential.id,
      publicKey: Buffer.from(v.registrationInfo.credential.publicKey).toString('base64url'),
      counter: 0,
      transports: [],
      name: 'Key',
      now: clock.now(),
    });
    const auth = await beginAuthentication(ctx.deps);
    await expectPasskeyFailure(
      finishAuthentication(ctx.deps, {
        ceremonyId: auth.ceremonyId,
        response: noUv.authenticate(auth.options),
      }),
    );
  });

  test('authentication verifies, returns the new counter and records use', async () => {
    const reg = await storedPasskey();
    clock.advance(60_000);

    const { ceremonyId, options } = await beginAuthentication(ctx.deps);
    expect(options.rpId).toBe('localhost');
    expect(options.userVerification).toBe('required');
    expect(options.timeout).toBe(300_000);
    expect(options.allowCredentials).toBeUndefined();

    const result = await finishAuthentication(ctx.deps, {
      ceremonyId,
      response: a.authenticate(options),
    });
    expect(result.newCounter).toBe(1);
    expect(result.passkey).toMatchObject({
      user_id: ADA,
      credential_id: reg.credentialId,
      counter: 1,
      last_used_at: clock.now(),
    });

    const row = await findPasskeyByCredentialId(ctx.deps.db.db, reg.credentialId);
    expect(row?.counter).toBe(1);
    expect(row?.last_used_at).toBe(clock.now());

    const again = await beginAuthentication(ctx.deps);
    const second = await finishAuthentication(ctx.deps, {
      ceremonyId: again.ceremonyId,
      response: a.authenticate(again.options),
    });
    expect(second.newCounter).toBe(2);
  });

  test('an authentication ceremony can be finished once', async () => {
    await storedPasskey();
    const { ceremonyId, options } = await beginAuthentication(ctx.deps);
    const response = a.authenticate(options);
    await finishAuthentication(ctx.deps, { ceremonyId, response });
    await expectPasskeyFailure(finishAuthentication(ctx.deps, { ceremonyId, response }));
  });

  test('an assertion for an unknown credential is refused', async () => {
    const { options: regOptions } = await beginSetup();
    a.register(regOptions);
    const { ceremonyId, options } = await beginAuthentication(ctx.deps);
    await expectPasskeyFailure(
      finishAuthentication(ctx.deps, { ceremonyId, response: a.authenticate(options) }),
    );
  });

  test('an assertion whose user handle names another user is refused', async () => {
    const { ceremonyId: regId, options: regOptions } = await beginSetup();
    const reg = await finishRegistration(ctx.deps, {
      purpose: 'setup',
      ceremonyId: regId,
      response: a.register(regOptions),
    });
    await insertUser(ctx.deps, BOB);
    await insertPasskey(ctx.deps.db.db, {
      ...reg,
      userId: BOB,
      name: 'Laptop',
      now: clock.now(),
    });

    const { ceremonyId, options } = await beginAuthentication(ctx.deps);
    await expectPasskeyFailure(
      finishAuthentication(ctx.deps, { ceremonyId, response: a.authenticate(options) }),
    );
    const row = await findPasskeyByCredentialId(ctx.deps.db.db, reg.credentialId);
    expect(row).toMatchObject({ counter: 0, last_used_at: null });
  });

  test('an assertion from another origin is refused', async () => {
    await storedPasskey();
    const { ceremonyId, options } = await beginAuthentication(ctx.deps);
    await expectPasskeyFailure(
      finishAuthentication(ctx.deps, {
        ceremonyId,
        response: a.authenticate(options, { origin: 'http://127.0.0.1:8080' }),
      }),
    );
  });

  test('RP ID comes from the public origin', async () => {
    const origin = 'https://pinwall.test:8443';
    const secure = await createTestContext({
      dialect,
      clock,
      env: { PINWALL_PUBLIC_ORIGIN: origin },
    });
    try {
      const b = new SoftAuthenticator({ origin });
      const { ceremonyId, options } = await beginSetup(secure.deps);
      expect(options.rp).toEqual({ name: 'Pinwall', id: 'pinwall.test' });
      const reg = await finishRegistration(secure.deps, {
        purpose: 'setup',
        ceremonyId,
        response: b.register(options),
      });
      await insertUser(secure.deps, ADA);
      await insertPasskey(secure.deps.db.db, { ...reg, name: 'Laptop', now: clock.now() });

      const auth = await beginAuthentication(secure.deps);
      expect(auth.options.rpId).toBe('pinwall.test');
      const result = await finishAuthentication(secure.deps, {
        ceremonyId: auth.ceremonyId,
        response: b.authenticate(auth.options),
      });
      expect(result.newCounter).toBe(1);
    } finally {
      await secure.close();
    }
  });

  test('passkeys need a secure, named origin', async () => {
    const cfg = (o: string) =>
      loadConfig({ PINWALL_PUBLIC_ORIGIN: o, PINWALL_DATA_DIR: '/tmp/pw' });
    for (const o of [
      'http://localhost:8080',
      'http://pinwall.localhost',
      'https://pinwall.example',
    ])
      expect(passkeysAvailable(cfg(o))).toBe(true);
    for (const o of [
      'http://pinwall.lan:8080',
      'https://192.168.1.10',
      'http://127.0.0.1:8080',
      'https://[::1]:8443',
    ])
      expect(passkeysAvailable(cfg(o))).toBe(false);

    const lan = { ...ctx.deps, config: cfg('http://pinwall.lan:8080') };
    const unavailable = {
      code: 'bad_request',
      status: 400,
      message: t('auth.passkeysUnavailable'),
    };
    await expect(beginAuthentication(lan)).rejects.toMatchObject(unavailable);
    await expect(beginSetup(lan)).rejects.toMatchObject(unavailable);
  });

  test('passkeys are stored and listed oldest first', async () => {
    await insertUser(ctx.deps, ADA);
    await insertUser(ctx.deps, BOB);
    const base = { userId: ADA, publicKey: 'cGs', counter: 0, transports: ['usb', 'nfc'] };
    const first = await insertPasskey(ctx.deps.db.db, {
      ...base,
      credentialId: 'Y3JlZC0x',
      name: 'First',
      now: T + 2,
    });
    expect(first).toMatchObject({
      user_id: ADA,
      credential_id: 'Y3JlZC0x',
      transports: '["usb","nfc"]',
      name: 'First',
      created_at: T + 2,
      last_used_at: null,
    });
    expect(first.id).toMatch(/^pky_[0-9a-z]{20}$/);
    await insertPasskey(ctx.deps.db.db, {
      ...base,
      credentialId: 'Y3JlZC0y',
      name: 'Second',
      now: T + 5,
    });
    await insertPasskey(ctx.deps.db.db, {
      ...base,
      credentialId: 'Y3JlZC0z',
      name: 'Zero',
      now: T,
    });
    await insertPasskey(ctx.deps.db.db, {
      ...base,
      userId: BOB,
      credentialId: 'Y3JlZC00',
      name: 'Bob',
      now: T + 1,
    });

    const list = await listPasskeys(ctx.deps.db.db, ADA);
    expect(list.map((p) => p.name)).toEqual(['Zero', 'First', 'Second']);
    expect(await findPasskeyByCredentialId(ctx.deps.db.db, 'Y3JlZC0x')).toEqual(first);
    expect(await findPasskeyByCredentialId(ctx.deps.db.db, 'bm9uZQ')).toBeUndefined();
  });
});
