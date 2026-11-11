import { lazy, type ReactNode, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { AuthPageFallback } from '../pages/auth/auth-layout.tsx';
import { RequireAuth } from './require-auth.tsx';
import { AppShell } from './shell/app-shell.tsx';

/*
 * Pages load on first use, each in its own chunk, so the first download holds
 * only the shell. AppShell shows a quiet skeleton while a page's chunk loads;
 * the sign-in and setup pages, outside the shell, show their own.
 */
const PlaceholderPage = lazy(() =>
  import('../pages/placeholder-page.tsx').then((m) => ({ default: m.PlaceholderPage })),
);
const SignInPage = lazy(() =>
  import('../pages/auth/sign-in-page.tsx').then((m) => ({ default: m.SignInPage })),
);
const SetupPage = lazy(() =>
  import('../pages/auth/setup-page.tsx').then((m) => ({ default: m.SetupPage })),
);

function AuthRoute({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return <Suspense fallback={<AuthPageFallback wide={wide} />}>{children}</Suspense>;
}

/**
 * The app's route tree. Pages open to everyone sit at the top level; every
 * other page is a child of the `RequireAuth` shell layout, so a signed-out
 * visit to any of them, known or not, goes to sign in and comes back.
 */
export function buildRoutes(): RouteObject[] {
  return [
    {
      path: '/signin',
      element: (
        <AuthRoute>
          <SignInPage />
        </AuthRoute>
      ),
    },
    {
      path: '/setup',
      element: (
        <AuthRoute wide>
          <SetupPage />
        </AuthRoute>
      ),
    },
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
