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

test('t picks the plural form for count, as i18next does, and falls back to the key', async () => {
  vi.resetModules();
  vi.doMock('@pinwall/shared/i18n/en.json', () => ({
    default: {
      'file.lines_one': '{{count}} line',
      'file.lines_other': '{{count}} lines',
      'file.size': '{{count}} bytes',
    },
  }));
  const { t: mockedT } = await import('../../src/lib/i18n.ts');
  expect(mockedT('file.lines', { count: 1 })).toBe('1 line');
  expect(mockedT('file.lines', { count: 0 })).toBe('0 lines');
  expect(mockedT('file.lines', { count: 2 })).toBe('2 lines');
  // Without forms, or without a number to choose by, the key itself is used.
  expect(mockedT('file.size', { count: 1 })).toBe('1 bytes');
  expect(mockedT('file.lines', { count: '1' })).toBe('file.lines');
  expect(mockedT('file.lines')).toBe('file.lines');
});
