import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { useMe } from '../../api/session.ts';
import { PageHeader } from '../../app/shell/page-header.tsx';
import { LoadingRegion, Skeleton } from '../../ui/index.ts';

// NavLink marks the current page with aria-current, which the styles follow.
// Each rule belongs to one size, so the two layouts never fight: pills above
// the page on phones, a vertical list beside it from 768 px.
const PILL =
  'max-md:h-9 max-md:rounded-full max-md:border max-md:border-border-strong max-md:px-3.5 max-md:font-medium max-md:hover:bg-surface-muted max-md:aria-[current=page]:border-primary max-md:aria-[current=page]:bg-primary max-md:aria-[current=page]:text-primary-fg max-md:aria-[current=page]:hover:bg-primary';
const LIST_ROW =
  'md:h-8 md:w-full md:rounded-md md:px-2.5 md:hover:bg-selected/70 md:aria-[current=page]:bg-selected md:aria-[current=page]:font-medium';
const LINK = `flex items-center whitespace-nowrap text-base text-fg transition-colors ${PILL} ${LIST_ROW}`;

function SettingsLink({ to, children }: { to: string; children: string }) {
  return (
    <li>
      <NavLink to={to} className={LINK}>
        {children}
      </NavLink>
    </li>
  );
}

/** What a settings page shows while its code loads, so the links stay put. */
function PageSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.common.loading')}>
      <Skeleton className="h-40 w-full rounded-lg" />
    </LoadingRegion>
  );
}

/**
 * The frame of every page under `/settings`: a heading and the links between
 * its pages. Security belongs to the owner account, so single sign-on users
 * do not see it; their sign-in lives at their identity provider.
 */
export function SettingsLayout() {
  const { t } = useTranslation();
  const { data: me } = useMe();

  return (
    <div className="mx-auto w-full max-w-(--content-library) px-4 pb-16 md:px-8">
      <PageHeader title={t('web.settings.title')} />
      <div className="flex flex-col gap-6 md:flex-row md:gap-12">
        <nav aria-label={t('web.settings.nav')} className="md:w-44 md:shrink-0">
          <ul className="flex flex-wrap gap-2 md:flex-col md:gap-0.5">
            <SettingsLink to="/settings/profile">{t('web.settings.profile')}</SettingsLink>
            {me?.kind === 'owner' ? (
              <SettingsLink to="/settings/security">{t('web.settings.security')}</SettingsLink>
            ) : null}
            <SettingsLink to="/settings/tokens">{t('web.settings.tokens')}</SettingsLink>
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-6 md:max-w-(--content-form)">
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
