import { expect, test } from 'vitest';
import i18n from '../i18n.ts';
import { passwordLength, passwordProblem } from './password.ts';

const t = i18n.t;

test('length counts code points after NFKC, like the server', () => {
  // Full-width letters and digits from an IME are the ASCII password.
  expect(passwordLength('ｐａｓｓ１２３')).toBe(7);
  // macOS types decomposed Vietnamese; it is not a longer password for that.
  const composed = 'Mật khẩu'.normalize('NFC');
  const decomposed = 'Mật khẩu'.normalize('NFD');
  expect(decomposed).not.toBe(composed);
  expect(passwordLength(decomposed)).toBe(passwordLength(composed));
  // An emoji is one character, not two UTF-16 units.
  expect(passwordLength('😀')).toBe(1);
});

test('problems follow the server rules: 12 to 256 characters', () => {
  expect(passwordProblem('a'.repeat(11), t)).toBe(t('auth.passwordTooShort', { min: 12 }));
  expect(passwordProblem('a'.repeat(11), t)).toBe('Use at least 12 characters.');
  expect(passwordProblem('a'.repeat(12), t)).toBeNull();
  expect(passwordProblem('a'.repeat(256), t)).toBeNull();
  expect(passwordProblem('a'.repeat(257), t)).toBe(t('auth.passwordTooLong', { max: 256 }));
  expect(passwordProblem('😀'.repeat(12), t)).toBeNull();
  expect(passwordProblem('', t)).toBe(t('auth.passwordTooShort', { min: 12 }));
});
