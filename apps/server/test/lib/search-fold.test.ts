import { describe, expect, test } from 'vitest';
import { cutToUtf8Bytes, foldForSearch } from '../../src/lib/search-fold.ts';

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

test('Hangul keeps its syllables: only marks are dropped, nothing stays decomposed', () => {
  expect(foldForSearch('한국어 사진')).toBe('한국어 사진');
  expect(foldForSearch('한국어 사진'.normalize('NFD'))).toBe('한국어 사진');
  // Three bytes of UTF-8 per syllable, as in the input; jamo would take six to nine.
  expect(Buffer.byteLength(foldForSearch('사진'.repeat(1000)))).toBe(6000);
  // Vietnamese still loses its marks, NFC or NFD.
  expect(foldForSearch('chụp ảnh đẹp')).toBe('chup anh dep');
  expect(foldForSearch('chụp ảnh đẹp'.normalize('NFD'))).toBe('chup anh dep');
  expect(foldForSearch('đ Đ')).toBe('d d');
});

describe('cutToUtf8Bytes', () => {
  test('text that fits is kept whole', () => {
    expect(cutToUtf8Bytes('chup anh', 8)).toBe('chup anh');
    expect(cutToUtf8Bytes('사진', 6)).toBe('사진');
    expect(cutToUtf8Bytes('', 0)).toBe('');
  });

  test('longer text keeps the whole words that fit', () => {
    expect(cutToUtf8Bytes('chup anh dep', 8)).toBe('chup anh');
    expect(cutToUtf8Bytes('chup anh dep', 9)).toBe('chup anh');
    expect(cutToUtf8Bytes('chup anh dep', 10)).toBe('chup anh');
    expect(cutToUtf8Bytes('사진 한국어', 10)).toBe('사진');
    expect(cutToUtf8Bytes('사진 한국어', 15)).toBe('사진');
  });

  test('one word longer than the cap is cut between code points', () => {
    expect(cutToUtf8Bytes('사진한국어', 7)).toBe('사진');
    expect(cutToUtf8Bytes('😀😀', 5)).toBe('😀');
    expect(cutToUtf8Bytes('😀😀', 3)).toBe('');
  });

  test('the result never exceeds the cap', () => {
    const words = Array.from({ length: 5000 }, (_, i) => `단어${i}`).join(' ');
    for (const max of [1, 2, 3, 100, 1001, 4097, 20_000]) {
      expect(Buffer.byteLength(cutToUtf8Bytes(words, max))).toBeLessThanOrEqual(max);
    }
  });
});
