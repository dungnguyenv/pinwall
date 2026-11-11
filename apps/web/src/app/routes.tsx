import { lazy, type ReactNode, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { AuthPageFallback } from '../pages/auth/auth-layout.tsx';
import { RequireAdmin, RequireAuth, RequireOwner } from './require-auth.tsx';
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
const ReviewPage = lazy(() =>
  import('../review/viewer/review-page.tsx').then((m) => ({ default: m.ReviewPage })),
);
const NotFoundPage = lazy(() =>
  import('../pages/not-found-page.tsx').then((m) => ({ default: m.NotFoundPage })),
);
const SettingsLayout = lazy(() =>
  import('../pages/settings/settings-layout.tsx').then((m) => ({ default: m.SettingsLayout })),
);
const ProfilePage = lazy(() =>
  import('../pages/settings/profile-page.tsx').then((m) => ({ default: m.ProfilePage })),
);
const SecurityPage = lazy(() =>
  import('../pages/settings/security-page.tsx').then((m) => ({ default: m.SecurityPage })),
);
const TokensPage = lazy(() =>
  import('../pages/settings/tokens-page.tsx').then((m) => ({ default: m.TokensPage })),
);
const SignInPage = lazy(() =>
  import('../pages/auth/sign-in-page.tsx').then((m) => ({ default: m.SignInPage })),
);
const SetupPage = lazy(() =>
  import('../pages/auth/setup-page.tsx').then((m) => ({ default: m.SetupPage })),
);
const ConnectPage = lazy(() =>
  import('../pages/connect/connect-page.tsx').then((m) => ({ default: m.ConnectPage })),
);
const AdminLayout = lazy(() =>
  import('../pages/admin/admin-layout.tsx').then((m) => ({ default: m.AdminLayout })),
);
const UsersPage = lazy(() =>
  import('../pages/admin/users-page.tsx').then((m) => ({ default: m.UsersPage })),
);
const ConfigPage = lazy(() =>
  import('../pages/admin/config-page.tsx').then((m) => ({ default: m.ConfigPage })),
);
const ConsentPage = lazy(() =>
  import('../pages/oauth/consent-page.tsx').then((m) => ({ default: m.ConsentPage })),
);

function AuthRoute({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return <Suspense fallback={<AuthPageFallback wide={wide} />}>{children}</Suspense>;
}

/**
 * The app's route tree. Pages open to everyone sit at the top level; every
 * other page is a child of the `RequireAuth` shell layout, so a signed-out
 * visit to any of them, known or not, goes to sign in and comes back. The
 * OAuth consent page also needs a session, but stands alone without the shell.
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
      path: '/oauth/consent',
      element: (
        <RequireAuth skeleton={<AuthPageFallback wide />}>
          <AuthRoute wide>
            <ConsentPage />
          </AuthRoute>
        </RequireAuth>
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
        { path: 'a/:artifactId', element: <ReviewPage /> },
        { path: 'a/:artifactId/v/:n', element: <ReviewPage /> },
        // Until compare arrives (M8b), its address opens the review of the current version.
        { path: 'a/:artifactId/compare', element: <ReviewPage /> },
        {
          path: 'settings',
          element: <SettingsLayout />,
          children: [
            { index: true, element: <Navigate to="profile" replace /> },
            { path: 'profile', element: <ProfilePage /> },
            // Single sign-on users have no password or passkeys to manage.
            {
              path: 'security',
              element: (
                <RequireOwner fallback="/settings/profile">
                  <SecurityPage />
                </RequireOwner>
              ),
            },
            { path: 'tokens', element: <TokensPage /> },
          ],
        },
        { path: 'connect', element: <ConnectPage /> },
        // Admins only; the guard sits above the layout, so no admin page loads or fetches for others.
        {
          path: 'admin',
          element: (
            <RequireAdmin>
              <AdminLayout />
            </RequireAdmin>
          ),
          children: [
            { index: true, element: <Navigate to="users" replace /> },
            { path: 'users', element: <UsersPage /> },
            { path: 'config', element: <ConfigPage /> },
          ],
        },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ];
}
