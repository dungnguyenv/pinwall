import { afterEach, expect, test, vi } from 'vitest';
import { t } from '../../src/lib/i18n.ts';

afterEach(() => {
  vi.doUnmock('@pinwall/shared/i18n/en.json');
  vi.resetModules();
});

test('t returns the English string and falls back to the key', () => {
  expect(t('app.name')).toBe('Pinwall');
  expect(t('missing.key')).toBe('missing.key');
  expect(t('constructor')).toBe('constructor');
});

test('t replaces {{name}} placeholders and leaves unknown ones visible', async () => {
  vi.resetModules();
  vi.doMock('@pinwall/shared/i18n/en.json', () => ({
    default: { 'greet.user': 'Hello {{ name }}, you have {{count}} new and {{other}}.' },
  }));
  const { t: mockedT } = await import('../../src/lib/i18n.ts');
  expect(mockedT('greet.user', { name: 'Linh', count: 3 })).toBe(
    'Hello Linh, you have 3 new and {{other}}.',
  );
  expect(mockedT('greet.user')).toBe('Hello {{ name }}, you have {{count}} new and {{other}}.');
});
