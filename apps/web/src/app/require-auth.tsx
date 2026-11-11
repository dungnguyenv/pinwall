import { ShieldAlert } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router';
import { errorMessage } from '../api/client.ts';
import { useMe } from '../api/session.ts';
import { signInPath } from '../lib/return-to.ts';
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '../ui/index.ts';

/** The shell's outline while the session is checked: a sidebar on wide screens, then content. */
function SessionSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.common.loading')}>
      <div className="flex min-h-dvh bg-canvas">
        <div className="hidden w-(--sidebar-width) shrink-0 flex-col gap-2 border-border border-r bg-sidebar p-3 md:flex">
          <Skeleton className="mb-4 h-7 w-28" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-4/5" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-6 md:px-8">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="aspect-4/3 rounded-lg" />
            <Skeleton className="aspect-4/3 rounded-lg" />
            <Skeleton className="aspect-4/3 rounded-lg" />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}

/**
 * Renders `children` for a signed-in person. Without a session it sends them
 * to sign in with this page as `return_to`; that includes a session that ends
 * mid-use, because any 401 `unauthorized` sets the cached `me` to null.
 */
export function RequireAuth({ children }: { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const me = useMe();

  if (me.data) return <>{children}</>;
  if (me.data === null) {
    const here = location.pathname + location.search + location.hash;
    return <Navigate to={signInPath(here)} replace />;
  }
  if (me.isError) {
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas">
        <ErrorState message={errorMessage(me.error, t)} onRetry={() => void me.refetch()} />
      </main>
    );
  }
  return <SessionSkeleton />;
}

/** Renders `children` for admins; members are told the page is for admins. Use inside `RequireAuth`. */
export function RequireAdmin({ children }: { children: ReactNode }): ReactElement | null {
  const { t } = useTranslation();
  const { data: me } = useMe();
  if (!me) return null;
  if (me.role !== 'admin') return <EmptyState icon={<ShieldAlert />} title={t('auth.adminOnly')} />;
  return <>{children}</>;
}

/**
 * Renders `children` for the built-in owner account; IdP users go to
 * `fallback` instead. Use inside `RequireAuth`.
 */
export function RequireOwner({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: string;
}): ReactElement | null {
  const { data: me } = useMe();
  if (!me) return null;
  if (me.kind !== 'owner') return <Navigate to={fallback} replace />;
  return <>{children}</>;
}
