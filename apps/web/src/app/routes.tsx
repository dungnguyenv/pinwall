import { lazy } from 'react';
import type { RouteObject } from 'react-router';
import { Logo } from '../ui/index.ts';
import { RequireAuth } from './require-auth.tsx';
import { AppShell } from './shell/app-shell.tsx';

/*
 * Pages load on first use, each in its own chunk, so the first download holds
 * only the shell. AppShell shows a quiet skeleton while a page's chunk loads.
 */
const PlaceholderPage = lazy(() =>
  import('../pages/placeholder-page.tsx').then((m) => ({ default: m.PlaceholderPage })),
);

// A placeholder until the sign-in page exists (Task 5).
function SignInPlaceholder() {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas">
      <h1>
        <Logo size="lg" />
      </h1>
    </main>
  );
}

/**
 * The app's route tree. Pages open to everyone sit at the top level; every
 * other page is a child of the `RequireAuth` shell layout, so a signed-out
 * visit to any of them, known or not, goes to sign in and comes back.
 */
export function buildRoutes(): RouteObject[] {
  return [
    { path: '/signin', element: <SignInPlaceholder /> },
    {
      element: (
        <RequireAuth>
          <AppShell />
        </RequireAuth>
      ),
      children: [{ path: '*', element: <PlaceholderPage /> }],
    },
  ];
}
