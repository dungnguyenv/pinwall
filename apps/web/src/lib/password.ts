import type { TFunction } from 'i18next';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../api/dto.ts';

/**
 * A password's length as the server counts it: code points after NFKC, so
 * full-width digits, decomposed accents and emoji count as people see them.
 */
export function passwordLength(pw: string): number {
  return [...pw.normalize('NFKC')].length;
}

/** Why the server would refuse `pw` as a new password, in its own words; `null` when it would not. */
export function passwordProblem(pw: string, t: TFunction): string | null {
  const length = passwordLength(pw);
  if (length < PASSWORD_MIN_LENGTH) return t('auth.passwordTooShort', { min: PASSWORD_MIN_LENGTH });
  if (length > PASSWORD_MAX_LENGTH) return t('auth.passwordTooLong', { max: PASSWORD_MAX_LENGTH });
  return null;
}
