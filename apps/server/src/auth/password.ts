import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@pinwall/shared';
import { verifyPassword } from '../lib/crypto.ts';
import { badRequest } from '../lib/errors.ts';
import { t } from '../lib/i18n.ts';
import type { Db } from './passkeys.ts';

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

/**
 * The form a password is hashed and checked in. NFKC makes the decomposed text macOS types,
 * precomposed Vietnamese and full-width digits from an IME all the same password.
 */
export function normalizePassword(pw: string): string {
  return pw.normalize('NFKC');
}

/**
 * A password someone is choosing, normalized and ready to hash. Its length is counted in code
 * points after normalization, so an emoji is one character and NFD input is not longer.
 */
export function checkNewPassword(pw: string): string {
  const normalized = normalizePassword(pw);
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_LENGTH) {
    throw badRequest(t('auth.passwordTooShort', { min: PASSWORD_MIN_LENGTH }), {
      field: 'password',
    });
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw badRequest(t('auth.passwordTooLong', { max: PASSWORD_MAX_LENGTH }), {
      field: 'password',
    });
  }
  return normalized;
}

/** Sets the user's password hash, replacing the one they had. */
export async function storePasswordHash(
  db: Db,
  userId: string,
  hash: string,
  now: number,
): Promise<void> {
  await db
    .insertInto('password_credentials')
    .values({ user_id: userId, hash, updated_at: now })
    .onConflict((oc) => oc.column('user_id').doUpdateSet({ hash, updated_at: now }))
    .execute();
}

/** Whether `pw`, in any Unicode form, is the user's password. False when they have none. */
export async function checkPassword(db: Db, userId: string, pw: string): Promise<boolean> {
  const row = await db
    .selectFrom('password_credentials')
    .select('hash')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return false;
  return verifyPassword(normalizePassword(pw), row.hash);
}
