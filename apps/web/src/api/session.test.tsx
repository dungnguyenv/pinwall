import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { expect, test, vi } from 'vitest';
import { RequireAuth } from '../app/require-auth.tsx';
import { buildRoutes } from '../app/routes.tsx';
import { fx } from '../test/fixtures.ts';
import { renderRoute } from '../test/render.tsx';
import { API, apiError, server } from '../test/server.ts';
import { qk } from './keys.ts';
import { getMe, getPublicConfig, useSignOut } from './session.ts';

test('getMe reads the signed-in user, and null when signed out', async () => {
  server.use(http.get(`${API}/me`, () => HttpResponse.json(fx.me({ name: 'Ada' }))));
  await expect(getMe()).resolves.toMatchObject({ name: 'Ada' });

  server.use(http.get(`${API}/me`, () => apiError(401, 'unauthorized', 'Sign in to continue.')));
  await expect(getMe()).resolves.toBeNull();
});

test('getMe passes other failures on', async () => {
  server.use(http.get(`${API}/me`, () => apiError(403, 'access_denied', 'No access.')));
  await expect(getMe()).rejects.toMatchObject({ status: 403, code: 'access_denied' });
});

test('getPublicConfig parses the public configuration', async () => {
  server.use(
    http.get(`${API}/config/public`, () =>
      HttpResponse.json({ ...fx.config({ setup_required: true }), extra: 'ignored' }),
    ),
  );
  const config = await getPublicConfig();
  expect(config.setup_required).toBe(true);
  expect(config).not.toHaveProperty('extra');
});

function SignOutButton() {
  const signOut = useSignOut();
  return (
    <button type="button" onClick={() => signOut.mutate()}>
      sign out
    </button>
  );
}

test('signing out forgets every cached query and opens sign in', async () => {
  const signedOut = vi.fn();
  server.use(
    http.post(`${API}/auth/sign-out`, () => {
      signedOut();
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { user, router, queryClient } = renderRoute('/home', {
    routes: [
      {
        path: '/home',
        element: (
          <RequireAuth>
            <SignOutButton />
          </RequireAuth>
        ),
      },
      ...buildRoutes(),
    ],
  });
  const button = await screen.findByRole('button', { name: 'sign out' });
  queryClient.setQueryData(['projects'], ['cached']);
  await user.click(button);

  await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
  expect(router.state.location.search).toBe('');
  expect(signedOut).toHaveBeenCalledOnce();
  expect(queryClient.getQueryData(['projects'])).toBeUndefined();
  expect(queryClient.getQueryData(qk.me)).toBeUndefined();
});
