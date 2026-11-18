import { describe, expect, test } from 'vitest';
import { t } from '../../src/lib/i18n.ts';
import { findLines, splitLines, windowLines } from '../../src/mcp/text-window.ts';

describe('splitLines', () => {
  test('CRLF and a BOM count lines as an editor does', () => {
    expect(splitLines('﻿a\r\nb\r\nc')).toEqual(['a', 'b', 'c']);
  });

  test('a lone CR and a lone LF end a line too', () => {
    expect(splitLines('a\rb\nc\r\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  test('a final line break does not make another line, but a blank line does', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('\n')).toEqual(['']);
  });

  test('an empty text has no lines', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('﻿')).toEqual([]);
  });

  test('only a leading BOM is dropped', () => {
    expect(splitLines('a\n﻿b')).toEqual(['a', '﻿b']);
  });
});

describe('windowLines', () => {
  test('lines are numbered from the offset, six wide', () => {
    const { body, next } = windowLines(['a', 'b', 'c', 'd'], 2, 2);
    expect(body).toBe('     2| b\n     3| c');
    expect(next).toBe(4);
  });

  test('the window that reaches the last line has no next', () => {
    const r = windowLines(['a', 'b', 'c'], 2, 10);
    expect(r.body).toBe('     2| b\n     3| c');
    expect(r.next).toBeNull();
  });

  test('a line number wider than six characters pushes the text right', () => {
    const lines = Array.from({ length: 1_000_000 }, () => 'x');
    expect(windowLines(lines, 1_000_000, 1).body).toBe('1000000| x');
  });

  test('a long line is cut with a marker', () => {
    const { body } = windowLines(['x'.repeat(80_000)], 1, 300);
    expect(body).toMatch(/^ {5}1\| x{2000}… \[\+78000 characters\]$/);
    expect(body).toContain(t('mcp.read.cut', { count: 78_000 }));
  });

  test('a line of 2,000 characters is whole', () => {
    expect(windowLines(['x'.repeat(2000)], 1, 1).body).toBe(`     1| ${'x'.repeat(2000)}`);
  });

  test('a cut never splits a surrogate pair', () => {
    const { body } = windowLines([`${'x'.repeat(1999)}😀tail`], 1, 1);
    expect(body).toMatch(/^ {5}1\| x{1999}… \[\+\d+ characters\]$/);
    expect(body).not.toMatch(/[\uD800-\uDBFF]/);
  });

  test('the window stops at 60,000 characters and names the next line', () => {
    const lines = Array.from({ length: 2000 }, () => 'y'.repeat(100));
    const { body, next } = windowLines(lines, 1, 2000);
    expect(next).toBeGreaterThan(500);
    expect(next).toBeLessThan(600);
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body.split('\n')).toHaveLength((next ?? 0) - 1);
  });

  test('the window shows one line even when it alone is over the limit', () => {
    const r = windowLines(['y'.repeat(100), 'z'], 1, 10, 20);
    expect(r.body.split('\n')).toHaveLength(1);
    expect(r.next).toBe(2);
  });

  test('control characters other than the tab are dropped from a line', () => {
    const { body } = windowLines(['a\u001b[2Jb\u0007\tc\u0000d'], 1, 1);
    expect(body).toBe('     1| a[2Jb\tcd');
  });

  test('U+2028 and U+2029 in a line are shown as a space, as flatten treats them', () => {
    const { body } = windowLines(['a\u2028b\u2029c'], 1, 1);
    expect(body).toBe('     1| a b c');
    // Nothing else changes: the line is still one line, of the same length.
    expect(body.split('\n')).toHaveLength(1);
  });

  test('a window past the last line is empty', () => {
    expect(windowLines(['a'], 5, 10)).toEqual({ body: '', next: null });
  });
});

describe('findLines', () => {
  test('find matches NFD text with an NFC needle, with 3 lines of context', () => {
    const lines = ['a', 'b', 'c', 'Bảng giá'.normalize('NFD'), 'd', 'e', 'f', 'g'];
    const r = findLines(lines, 'bảng giá'.normalize('NFC'));
    expect(r.matches).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.body.split('\n')).toHaveLength(7);
    // The line is shown as stored.
    expect(r.body).toContain(`     4| ${'Bảng giá'.normalize('NFD')}`);
  });

  test('find matches NFC text with an NFD needle', () => {
    const r = findLines(['x', 'Bảng giá'.normalize('NFC')], 'BẢNG GIÁ'.normalize('NFD'));
    expect(r.matches).toBe(1);
  });

  test('overlapping windows are merged and groups are separated by --', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    lines[9] = 'needle one';
    lines[11] = 'needle two';
    lines[24] = 'needle three';
    const r = findLines(lines, 'needle');
    expect(r.matches).toBe(3);
    const rows = r.body.split('\n');
    // Lines 7 to 15 (one merged group), then 22 to 28.
    expect(rows.slice(0, 9).map((row) => Number(row.slice(0, 6)))).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(rows[9]).toBe('--');
    expect(rows.slice(10).map((row) => Number(row.slice(0, 6)))).toEqual([
      22, 23, 24, 25, 26, 27, 28,
    ]);
  });

  test('groups that touch are one group', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
    lines[0] = 'hit';
    lines[7] = 'hit'; // its window starts at line 5, right after the first one ends at line 4
    expect(findLines(lines, 'hit').body).not.toContain('--');
  });

  test('context at the edges stops at the first and last line', () => {
    const r = findLines(['hit', 'b'], 'hit', 3);
    expect(r.body.split('\n')).toHaveLength(2);
  });

  test('at most 30 matches are shown, and the rest is said to exist', () => {
    const lines = Array.from({ length: 100 }, (_, i) => (i % 10 === 0 ? 'hit' : `x${i}`));
    const r = findLines(lines, 'hit', 0);
    expect(r.matches).toBe(10);
    expect(r.truncated).toBe(false);

    const many = Array.from({ length: 100 }, () => 'hit');
    const capped = findLines(many, 'hit', 0);
    expect(capped.matches).toBe(30);
    expect(capped.truncated).toBe(true);
    expect(capped.body.split('\n')).toHaveLength(30);
  });

  test('the body stops at the character limit and says it was cut', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `hit ${'y'.repeat(100)} ${i}`);
    const r = findLines(lines, 'hit', 0, 30, 1000);
    expect(r.body.length).toBeLessThanOrEqual(1000);
    expect(r.truncated).toBe(true);
    expect(r.matches).toBeLessThan(30);
    expect(r.matches).toBeGreaterThan(0);
  });

  test('find compares the line as it is shown: U+2028 and U+2029 are spaces', () => {
    const r = findLines(['one\u2028two', 'x', 'three\u2029four'], 'one two', 0);
    expect(r).toEqual({ body: '     1| one two', matches: 1, truncated: false });
    expect(findLines(['three\u2029four'], 'e four', 0).body).toBe('     1| three four');
    // A needle that has one finds the same lines.
    expect(findLines(['one two', 'one\u2028two'], 'one\u2028two', 0).matches).toBe(2);
    // The separator is not a character of the line that a needle could match.
    expect(findLines(['a\u2028b'], 'a\u2028', 0).matches).toBe(1);
    expect(findLines(['ab'], 'a b', 0).matches).toBe(0);
  });

  test('no match is an empty body', () => {
    expect(findLines(['a', 'b'], 'zzz')).toEqual({ body: '', matches: 0, truncated: false });
  });

  test('a long line is cut as in a range, and control characters are dropped', () => {
    const r = findLines([`needle\u001b${'x'.repeat(5000)}`], 'needle');
    expect(r.body).toMatch(/^ {5}1\| needlex+… \[\+\d+ characters\]$/);
    expect(r.body).not.toContain('\u001b');
  });
});
