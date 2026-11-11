import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { readPref, usePref, writePref } from './storage.ts';

const VIEWS = ['grid', 'list'] as const;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
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
