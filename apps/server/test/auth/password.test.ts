import {
  PASSWORD_MAX_LENGTH as SHARED_MAX,
  PASSWORD_MIN_LENGTH as SHARED_MIN,
} from '@pinwall/shared';
import { afterEach, describe, expect, test } from 'vitest';
import {
  checkNewPassword,
  checkPassword,
  normalizePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  storePasswordHash,
} from '../../src/auth/password.ts';
import { hashPassword } from '../../src/lib/crypto.ts';
import { t } from '../../src/lib/i18n.ts';
import { newId } from '../../src/lib/ids.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

test('normalizes to NFKC and counts code points', () => {
  expect(normalizePassword('ｐａｓｓ１２３')).toBe('pass123');
  expect(normalizePassword('Mật'.normalize('NFD'))).toBe('Mật'.normalize('NFC'));
  expect(() => checkNewPassword('a'.repeat(11))).toThrow(
    expect.objectContaining({ code: 'bad_request' }),
  );
  expect(checkNewPassword('😀'.repeat(12))).toBe('😀'.repeat(12));
  expect(() => checkNewPassword('a'.repeat(257))).toThrow();
});

test('the length limits are shared with the web app', () => {
  expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 256]);
  expect([SHARED_MIN, SHARED_MAX]).toEqual([12, 256]);
});

test('a rejected new password names the field and the limit', () => {
  expect(() => checkNewPassword('short')).toThrow(
    expect.objectContaining({
      status: 400,
      message: t('auth.passwordTooShort', { min: 12 }),
      details: { field: 'password' },
    }),
  );
  expect(() => checkNewPassword('a'.repeat(257))).toThrow(
    expect.objectContaining({
      status: 400,
      message: t('auth.passwordTooLong', { max: 256 }),
      details: { field: 'password' },
    }),
  );
  expect(checkNewPassword('a'.repeat(256))).toBe('a'.repeat(256));
});

test('length counts after normalization', () => {
  // Eleven full-width digits and one combining sequence: 12 code points once normalized.
  const pw = `${'１'.repeat(11)}${'ệ'.normalize('NFD')}`;
  expect([...pw]).toHaveLength(14);
  expect(checkNewPassword(pw)).toBe(`${'1'.repeat(11)}ệ`);
});

describe.each(dialects)('stored passwords on %s', (dialect) => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  async function owner(c: TestContext): Promise<string> {
    const id = newId('usr');
    await c.deps.db.db
      .insertInto('users')
      .values({ id, kind: 'owner', email_verified: 0, created_at: 1 })
      .execute();
    return id;
  }

  test('checkPassword is false without a password and true for the stored one', async () => {
    ctx = await createTestContext({ dialect });
    const { db } = ctx.deps.db;
    const id = await owner(ctx);
    expect(await checkPassword(db, id, 'correct horse battery')).toBe(false);

    await storePasswordHash(db, id, await hashPassword('correct horse battery'), 10);
    expect(await checkPassword(db, id, 'correct horse battery')).toBe(true);
    expect(await checkPassword(db, id, 'correct horse battery!')).toBe(false);
  });

  test('checkPassword normalizes the attempt', async () => {
    ctx = await createTestContext({ dialect });
    const { db } = ctx.deps.db;
    const id = await owner(ctx);
    await storePasswordHash(db, id, await hashPassword(checkNewPassword('Mật khẩu ２０２６')), 10);
    expect(await checkPassword(db, id, 'Mật khẩu 2026'.normalize('NFD'))).toBe(true);
  });

  test('storePasswordHash replaces an existing hash', async () => {
    ctx = await createTestContext({ dialect });
    const { db } = ctx.deps.db;
    const id = await owner(ctx);
    await storePasswordHash(db, id, await hashPassword('first password!'), 10);
    await storePasswordHash(db, id, await hashPassword('second password!'), 20);
    const rows = await db.selectFrom('password_credentials').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: id, updated_at: 20 });
    expect(await checkPassword(db, id, 'first password!')).toBe(false);
    expect(await checkPassword(db, id, 'second password!')).toBe(true);
  });
});
