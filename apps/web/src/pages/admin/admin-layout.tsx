import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { PageHeader } from '../../app/shell/page-header.tsx';
import { LoadingRegion, Skeleton } from '../../ui/index.ts';

// NavLink marks the current page with aria-current; the bar under the link
// follows it, as the active tab's does elsewhere in the app.
const LINK =
  'relative inline-flex h-10 items-center rounded-sm font-medium text-base text-fg-muted transition-colors hover:text-fg aria-[current=page]:text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-fg after:opacity-0 after:transition-opacity aria-[current=page]:after:opacity-100';

function AdminLink({ to, children }: { to: string; children: string }) {
  return (
    <li>
      <NavLink to={to} className={LINK}>
        {children}
      </NavLink>
    </li>
  );
}

/** What an admin page shows while its code loads, so the links stay put. */
function PageSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.common.loading')}>
      <Skeleton className="h-40 w-full rounded-lg" />
    </LoadingRegion>
  );
}

/**
 * The frame of every page under `/admin`: a heading and the links between
 * its two pages. Only admins reach it (`RequireAdmin` wraps it in the routes),
 * so nothing below it loads for anyone else.
 */
export function AdminLayout() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-full max-w-(--content-library) px-4 pb-16 md:px-8">
      <PageHeader title={t('web.admin.title')} description={t('web.admin.description')} />
      <nav aria-label={t('web.admin.nav')} className="mb-6 border-border border-b">
        <ul className="flex items-center gap-5 overflow-x-auto [scrollbar-width:none]">
          <AdminLink to="/admin/users">{t('web.admin.users')}</AdminLink>
          <AdminLink to="/admin/config">{t('web.admin.configuration')}</AdminLink>
        </ul>
      </nav>
      <Suspense fallback={<PageSkeleton />}>
        <Outlet />
      </Suspense>
    </div>
  );
}
