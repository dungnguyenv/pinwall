import { act, render, renderHook } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, expect, test, vi } from 'vitest';
import { setViewport } from '../test/render.tsx';
import { PHONE_QUERY, useMediaQuery } from './media.ts';
import { browser, useGoTo } from './navigation.ts';
import { usePageTitle } from './page-title.ts';

afterEach(() => vi.restoreAllMocks());

let goTo: ReturnType<typeof useGoTo> = () => {};

/** Hands the test the `goTo` of a component inside the router. */
function GoToProbe() {
  goTo = useGoTo();
  return null;
}

test('useGoTo hands server routes to the browser and keeps app routes in the router', () => {
  const assign = vi.spyOn(browser, 'assign').mockImplementation(() => {});
  const router = createMemoryRouter([{ path: '*', element: <GoToProbe /> }], {
    initialEntries: ['/start'],
  });
  render(<RouterProvider router={router} />);

  act(() => goTo('/a/art_1/raw'));
  expect(assign).toHaveBeenCalledWith('/a/art_1/raw');
  expect(router.state.location.pathname).toBe('/start');

  act(() => goTo('/projects/p1?view=list', { replace: true }));
  expect(assign).toHaveBeenCalledTimes(1);
  expect(router.state.location).toMatchObject({ pathname: '/projects/p1', search: '?view=list' });
  expect(router.state.historyAction).toBe('REPLACE');
});

test('useMediaQuery follows the viewport', () => {
  setViewport(360);
  const { result } = renderHook(() => useMediaQuery(PHONE_QUERY));
  expect(result.current).toBe(true);
  setViewport(1280);
  expect(result.current).toBe(false);
  setViewport(767);
  expect(result.current).toBe(true);
});

test('usePageTitle names the page, and the app alone without a title', () => {
  const { rerender, unmount } = renderHook(({ title }) => usePageTitle(title), {
    initialProps: { title: 'Settings' as string | null },
  });
  expect(document.title).toBe('Settings · Pinwall');
  rerender({ title: null });
  expect(document.title).toBe('Pinwall');
  rerender({ title: 'Projects' });
  unmount();
  expect(document.title).toBe('Pinwall');
});
