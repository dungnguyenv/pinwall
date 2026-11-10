import { expect, test } from 'vitest';
import en from '../src/i18n/en.json';

test('en.json has app.name', () => {
  expect(en['app.name']).toBe('Pinwall');
});
