import { useQuery } from '@tanstack/react-query';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { RouteObject } from 'react-router';
import { expect, test } from 'vitest';
import { api } from '../api/client.ts';
import { returnToFrom } from '../lib/return-to.ts';
import { fx } from '../test/fixtures.ts';
import { renderRoute } from '../test/render.tsx';
import { API, apiError, server } from '../test/server.ts';
import { RequireAdmin, RequireAuth, RequireOwner } from './require-auth.tsx';
import { buildRoutes } from './routes.tsx';

/** A signed-in page that loads something from the API. */
function Probe() {
  const probe = useQuery({
    queryKey: ['probe'],
    queryFn: async () => {
      await api('/probe');
      return true;
    },
  });
  return <p>{probe.isSuccess ? 'probe loaded' : 'probe loading'}</p>;
}

const routes = (): RouteObject[] => [
  {
    path: '/probe',
    element: (
      <RequireAuth>
        <Probe />
      </RequireAuth>
    ),
  },
  {
    path: '/admin-probe',
    element: (
      <RequireAuth>
        <RequireAdmin>
          <p>admin area</p>
        </RequireAdmin>
      </RequireAuth>
    ),
  },
  {
    path: '/owner-probe',
    element: (
      <RequireAuth>
        <RequireOwner fallback="/fallback">
          <p>owner area</p>
        </RequireOwner>
      </RequireAuth>
    ),
  },
  { path: '/fallback', element: <p>fallback page</p> },
  ...buildRoutes(),
];

test('a signed-out deep link goes to sign in with return_to', async () => {
  const { router } = renderRoute('/projects/p1?view=list', { me: null });
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  expect(router.state.location.search).toBe('?return_to=%2Fprojects%2Fp1%3Fview%3Dlist');
});

test('a 401 during use sends the user to sign in and back', async () => {
  server.use(http.get(`${API}/probe`, () => apiError(401, 'unauthorized', 'Sign in to continue.')));
  const { router } = renderRoute('/probe?tab=files#top', { routes: routes() });
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  const back = returnToFrom(new URLSearchParams(router.state.location.search));
  expect(back).toBe('/probe?tab=files#top');
});

test("a 401 during use forgets the person's cached data", async () => {
  server.use(http.get(`${API}/probe`, () => apiError(401, 'unauthorized', 'Sign in to continue.')));
  const { router, queryClient } = renderRoute('/probe', { routes: routes() });
  queryClient.setQueryData(['projects', { archived: false }], fx.page([]));
  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  expect(queryClient.getQueryData(['projects', { archived: false }])).toBeUndefined();
  expect(queryClient.getQueryData(['probe'])).toBeUndefined();
  expect(queryClient.getQueryData(['me'])).toBeNull();
});

test('the guard shows a loading skeleton until the session is known', async () => {
  server.use(http.get(`${API}/probe`, () => HttpResponse.json({})));
  renderRoute('/probe', { routes: routes() });
  expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  expect(await screen.findByText('probe loaded')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
});

test('a failed session check offers Retry instead of a sign-in loop', async () => {
  let fail = true;
  server.use(
    http.get(`${API}/me`, () =>
      fail
        ? new HttpResponse('<html>Bad gateway</html>', { status: 502 })
        : HttpResponse.json(fx.me()),
    ),
    http.get(`${API}/probe`, () => HttpResponse.json({})),
  );
  const { user, router } = renderRoute('/probe', { routes: routes() });
  expect(
    await screen.findByText('Pinwall is not responding right now. Try again in a moment.'),
  ).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/probe');

  fail = false;
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('probe loaded')).toBeInTheDocument();
});

test('admin pages tell members they are for admins only', async () => {
  renderRoute('/admin-probe', { me: fx.me({ role: 'member' }), routes: routes() });
  expect(await screen.findByText('Only admins can do this.')).toBeInTheDocument();
  expect(screen.queryByText('admin area')).not.toBeInTheDocument();
});

test('admin pages render for admins', async () => {
  renderRoute('/admin-probe', { me: fx.me({ role: 'admin' }), routes: routes() });
  expect(await screen.findByText('admin area')).toBeInTheDocument();
});

test('owner-only pages send IdP users to the fallback', async () => {
  const { router } = renderRoute('/owner-probe', {
    me: fx.me({ kind: 'oidc', credentials: null }),
    routes: routes(),
  });
  expect(await screen.findByText('fallback page')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/fallback');
  expect(router.state.historyAction).toBe('REPLACE');
});

test('owner-only pages render for the owner', async () => {
  const { router } = renderRoute('/owner-probe', {
    me: fx.me({ kind: 'owner' }),
    routes: routes(),
  });
  expect(await screen.findByText('owner area')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/owner-probe');
});

test('a second render in one test serves the new session', async () => {
  renderRoute('/admin-probe', { me: fx.me({ role: 'member' }), routes: routes() });
  expect(await screen.findByText('Only admins can do this.')).toBeInTheDocument();
  cleanup();
  renderRoute('/admin-probe', { me: fx.me({ role: 'admin' }), routes: routes() });
  expect(await screen.findByText('admin area')).toBeInTheDocument();
});
