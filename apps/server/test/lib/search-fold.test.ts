import { expect, test } from 'vitest';
import { foldForSearch } from '../../src/lib/search-fold.ts';

test('folds Vietnamese in NFC and NFD', () => {
  expect(foldForSearch('Chụp ảnh Điện thoại')).toBe('chup anh dien thoai');
  expect(foldForSearch('Chụp ảnh'.normalize('NFD'))).toBe('chup anh');
  expect(foldForSearch('  Đà   Nẵng\n')).toBe('da nang');
});

test('folds other Latin accents and keeps plain text', () => {
  expect(foldForSearch('Crème Brûlée')).toBe('creme brulee');
  expect(foldForSearch('already plain')).toBe('already plain');
  expect(foldForSearch('')).toBe('');
});
