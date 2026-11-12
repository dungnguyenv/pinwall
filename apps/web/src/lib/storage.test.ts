import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { readPref, readText, usePref, writePref, writeText } from './storage.ts';

const VIEWS = ['grid', 'list'] as const;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function blockStorage() {
  const blocked = () => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
}

test('storage helpers survive a throwing localStorage', () => {
  blockStorage();
  expect(readPref('pinwall.view', VIEWS, 'grid')).toBe('grid');
  expect(() => writePref('pinwall.view', 'list')).not.toThrow();

  // The hook keeps the choice in memory for as long as the page is open.
  const { result } = renderHook(() => usePref('pinwall.view', VIEWS, 'grid'));
  expect(result.current[0]).toBe('grid');
  act(() => result.current[1]('list'));
  expect(result.current[0]).toBe('list');
});

test('readPref ignores values outside allowed', () => {
  localStorage.setItem('pinwall.view', 'carousel');
  expect(readPref('pinwall.view', VIEWS, 'grid')).toBe('grid');
  writePref('pinwall.view', 'list');
  expect(readPref('pinwall.view', VIEWS, 'grid')).toBe('list');
});

test('usePref remembers the choice, and a null key keeps it in memory only', () => {
  const stored = renderHook(() => usePref('pinwall.view', VIEWS, 'grid'));
  act(() => stored.result.current[1]('list'));
  expect(localStorage.getItem('pinwall.view')).toBe('list');
  expect(renderHook(() => usePref('pinwall.view', VIEWS, 'grid')).result.current[0]).toBe('list');

  localStorage.clear();
  const memory = renderHook(() => usePref(null, VIEWS, 'grid'));
  act(() => memory.result.current[1]('list'));
  expect(memory.result.current[0]).toBe('list');
  expect(localStorage.length).toBe(0);
});

test('usePref reads the new key when the key changes', () => {
  localStorage.setItem('pinwall.view.a', 'list');
  const { result, rerender } = renderHook(({ key }) => usePref(key, VIEWS, 'grid'), {
    initialProps: { key: 'pinwall.view.b' as string | null },
  });
  expect(result.current[0]).toBe('grid');
  rerender({ key: 'pinwall.view.a' });
  expect(result.current[0]).toBe('list');
});

test('text storage reads and writes local and session storage apart', () => {
  expect(readText('pinwall:note')).toBeNull();
  writeText('pinwall:note', 'kept');
  writeText('pinwall:note', 'tab only', { session: true });
  expect(localStorage.getItem('pinwall:note')).toBe('kept');
  expect(sessionStorage.getItem('pinwall:note')).toBe('tab only');
  expect(readText('pinwall:note')).toBe('kept');
  expect(readText('pinwall:note', { session: true })).toBe('tab only');

  // null removes, and only from the storage asked for.
  writeText('pinwall:note', null, { session: true });
  expect(readText('pinwall:note', { session: true })).toBeNull();
  expect(readText('pinwall:note')).toBe('kept');
  writeText('pinwall:note', null);
  expect(readText('pinwall:note')).toBeNull();
});

test('readText treats a value longer than max as not there', () => {
  localStorage.setItem('pinwall:note', 'abcdef');
  expect(readText('pinwall:note', { max: 6 })).toBe('abcdef');
  expect(readText('pinwall:note', { max: 5 })).toBeNull();
  expect(readText('pinwall:note')).toBe('abcdef');
});

test('text storage survives a throwing storage', () => {
  localStorage.setItem('pinwall:note', 'kept');
  blockStorage();
  expect(readText('pinwall:note')).toBeNull();
  expect(readText('pinwall:note', { session: true })).toBeNull();
  expect(() => writeText('pinwall:note', 'x')).not.toThrow();
  expect(() => writeText('pinwall:note', 'x', { session: true })).not.toThrow();

  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError');
  });
  expect(() => writeText('pinwall:note', null)).not.toThrow();
});

test('text storage survives a storage that cannot even be reached', () => {
  const blocked = () => {
    throw new DOMException('Blocked', 'SecurityError');
  };
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(blocked);
  expect(readText('pinwall:note', { session: true })).toBeNull();
  expect(() => writeText('pinwall:note', 'x', { session: true })).not.toThrow();
});
