import { Menu, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { IconButton, Logo } from '../../ui/index.ts';
import { useShellActions } from './shell-actions.ts';

/** The phone's top bar: the menu that opens the sidebar drawer, the logo, and search. */
export function MobileTopBar() {
  const { t } = useTranslation();
  const { openDrawer, openSearch } = useShellActions();
  return (
    <header className="sticky top-0 z-30 flex h-(--topbar-height) shrink-0 items-center gap-1 border-border border-b bg-canvas px-2">
      <IconButton
        label={t('web.sidebar.openMenu')}
        icon={<Menu />}
        tooltipSide="bottom"
        onClick={openDrawer}
      />
      <Link to="/" className="rounded-md px-1.5 py-1">
        <Logo size="sm" />
      </Link>
      <div className="flex-1" />
      <IconButton
        label={t('web.sidebar.search')}
        icon={<Search />}
        tooltipSide="bottom"
        onClick={openSearch}
      />
    </header>
  );
}
