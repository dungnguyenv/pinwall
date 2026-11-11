import { Outlet, type RouteObject } from 'react-router';
import { Logo } from '../ui/index.ts';
import { RequireAuth } from './require-auth.tsx';

// Placeholders until their pages exist: sign-in (Task 5) and the shell (Task 4).
function SignInPlaceholder() {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas">
      <h1>
        <Logo size="lg" />
      </h1>
    </main>
  );
}

function SignedInPlaceholder() {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas">
      <Logo size="lg" />
    </main>
  );
}

/**
 * The app's route tree. Pages open to everyone sit at the top level; every
 * other page is a child of the `RequireAuth` layout, so a signed-out visit to
 * any of them, known or not, goes to sign in and comes back.
 */
export function buildRoutes(): RouteObject[] {
  return [
    { path: '/signin', element: <SignInPlaceholder /> },
    {
      element: (
        <RequireAuth>
          <Outlet />
        </RequireAuth>
      ),
      children: [{ path: '*', element: <SignedInPlaceholder /> }],
    },
  ];
}
