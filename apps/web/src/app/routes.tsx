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
const AllArtifactsPage = lazy(() =>
  import('../pages/all-artifacts-page.tsx').then((m) => ({ default: m.AllArtifactsPage })),
);
const ProjectPage = lazy(() =>
  import('../pages/project-page.tsx').then((m) => ({ default: m.ProjectPage })),
);
const SearchPage = lazy(() =>
  import('../pages/search-page.tsx').then((m) => ({ default: m.SearchPage })),
);
const ArtifactPage = lazy(() =>
  import('../pages/artifact/artifact-page.tsx').then((m) => ({ default: m.ArtifactPage })),
);
const NotFoundPage = lazy(() =>
  import('../pages/not-found-page.tsx').then((m) => ({ default: m.NotFoundPage })),
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
      children: [
        // A plain `/` rather than an index route, which would outrank any `/`
        // route placed before this tree.
        { path: '/', element: <AllArtifactsPage /> },
        { path: 'projects/:projectId', element: <ProjectPage /> },
        { path: 'search', element: <SearchPage /> },
        // The review screen (M8) replaces this page on all three.
        { path: 'a/:artifactId', element: <ArtifactPage /> },
        { path: 'a/:artifactId/v/:n', element: <ArtifactPage /> },
        { path: 'a/:artifactId/compare', element: <ArtifactPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ];
}
