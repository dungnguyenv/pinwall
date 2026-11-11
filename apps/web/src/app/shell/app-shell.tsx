import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui';
import {
  type MouseEvent,
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, ScrollRestoration, useLocation } from 'react-router';
import { useMe } from '../../api/session.ts';
import { PHONE_QUERY, useMediaQuery } from '../../lib/media.ts';
import { cn, LoadingRegion, Skeleton } from '../../ui/index.ts';
import { MobileTopBar } from './mobile-top-bar.tsx';
import { NewProjectDialog } from './new-project-dialog.tsx';
import { HeadingFocusContext } from './page-header.tsx';
import { SearchDialog, useSearchShortcut } from './search-dialog.tsx';
import { type ShellActions, ShellActionsContext } from './shell-actions.ts';
import { Sidebar } from './sidebar.tsx';
import { SidebarModeContext, useSidebarModeState } from './sidebar-mode.ts';

const MAIN_ID = 'main';

/**
 * Moves focus to the start of the page: its heading when it has a focusable
 * one, else the main region. Leaves focus alone if it is already in the page.
 */
function focusPageStart(): void {
  const main = document.getElementById(MAIN_ID);
  if (!main || main.contains(document.activeElement)) return;
  const heading = main.querySelector<HTMLElement>('h1[tabindex]');
  (heading ?? main).focus({ preventScroll: true });
}

/**
 * Shown while a page's code loads. It appears only after a short pause, so a
 * quick load shows nothing at all instead of a flash.
 */
function PageSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="animate-fade-in [animation-delay:250ms]">
      <LoadingRegion label={t('web.common.loading')}>
        <div className="mx-auto w-full max-w-(--content-library) px-4 pt-6 md:px-8 md:pt-10">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-3 h-4 w-40" />
        </div>
      </LoadingRegion>
    </div>
  );
}

/** What runs once the drawer has closed: put focus on the page, or open a dialog. */
type AfterDrawer = 'page' | (() => void) | null;

/**
 * The signed-in layout. From 768 px the sidebar sits on the left, as the full
 * column or the rail; below that a top bar opens it as a drawer. The page
 * scrolls with the window while the sidebar stays put. After each navigation
 * the new page's heading takes focus, and a skip link jumps to the content.
 */
export function AppShell() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { data: me } = useMe();
  const phone = useMediaQuery(PHONE_QUERY);

  // The drawer belongs to the page it was opened on: navigating closes it.
  const [drawerPath, setDrawerPath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const openDrawer = useCallback(() => setDrawerPath(pathname), [pathname]);
  const sidebar = useSidebarModeState(me?.id ?? null, pathname, openDrawer);
  // Only phones and the review screen use it; widening the window closes it.
  const drawerOpen = drawerPath === pathname && (phone || sidebar.forcedRail);

  const afterDrawer = useRef<AfterDrawer>(null);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const shownPath = useRef(pathname);
  const pendingHeading = useRef<string | null>(null);
  const drawerOpenedOn = useRef<string | null>(null);

  // Layout effects run before any page's effects, so a PageHeader already on
  // screen sees the new request in the same commit.
  useLayoutEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    pendingHeading.current = pathname;
  }, [pathname]);

  const closeDrawerThen = useCallback((then: AfterDrawer) => {
    afterDrawer.current = then;
    setDrawerPath(null);
  }, []);

  // An action picked in the drawer waits for it to close, so focus can go
  // back to the button that opened the drawer before the dialog takes it.
  const actions = useMemo<ShellActions>(() => {
    const afterTheDrawer = (open: () => void) => () => {
      if (drawerOpen) closeDrawerThen(open);
      else open();
    };
    return {
      openSearch: afterTheDrawer(() => setSearchOpen(true)),
      openNewProject: afterTheDrawer(() => setNewProjectOpen(true)),
      openDrawer,
    };
  }, [drawerOpen, closeDrawerThen, openDrawer]);

  useSearchShortcut(actions.openSearch);

  const skipToContent = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document.getElementById(MAIN_ID)?.focus();
  };

  const variant = sidebar.mode === 'open' ? 'full' : 'rail';

  return (
    <SidebarModeContext.Provider value={sidebar}>
      <ShellActionsContext.Provider value={actions}>
        <HeadingFocusContext.Provider value={pendingHeading}>
          <a
            href={`#${MAIN_ID}`}
            onClick={skipToContent}
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:font-medium focus:text-primary-fg focus:shadow-popover"
          >
            {t('web.shell.skipToContent')}
          </a>

          <div className="flex min-h-dvh bg-canvas">
            {phone ? null : (
              <div
                className={cn(
                  'sticky top-0 h-dvh shrink-0 border-border border-r bg-sidebar',
                  variant === 'full' ? 'w-(--sidebar-width)' : 'w-(--rail-width)',
                )}
              >
                <Sidebar variant={variant} />
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              {phone ? <MobileTopBar /> : null}
              <main
                id={MAIN_ID}
                tabIndex={-1}
                className="flex min-w-0 flex-1 flex-col outline-none"
              >
                <Suspense fallback={<PageSkeleton />}>
                  <Outlet />
                </Suspense>
              </main>
            </div>
          </div>

          <RadixDialog.Root
            open={drawerOpen}
            onOpenChange={(open) => (open ? openDrawer() : setDrawerPath(null))}
          >
            <RadixDialog.Portal>
              <RadixDialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
              <RadixDialog.Content
                aria-describedby={undefined}
                className="fixed inset-y-0 left-0 z-50 flex w-(--sidebar-width) max-w-[85vw] flex-col border-border border-r bg-sidebar pb-[env(safe-area-inset-bottom)] shadow-dialog outline-none data-[state=closed]:animate-drawer-out data-[state=open]:animate-drawer-in"
                onOpenAutoFocus={() => {
                  drawerOpener.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  drawerOpenedOn.current = pathname;
                }}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  const then = afterDrawer.current;
                  const opener = drawerOpener.current;
                  const navigated = drawerOpenedOn.current !== shownPath.current;
                  afterDrawer.current = null;
                  drawerOpener.current = null;
                  drawerOpenedOn.current = null;
                  if (then === 'page' || navigated) {
                    focusPageStart();
                    return;
                  }
                  if (opener?.isConnected) opener.focus({ preventScroll: true });
                  then?.();
                }}
              >
                <VisuallyHidden.Root asChild>
                  <RadixDialog.Title>{t('web.sidebar.menu')}</RadixDialog.Title>
                </VisuallyHidden.Root>
                <Sidebar variant="drawer" onNavigate={() => closeDrawerThen('page')} />
              </RadixDialog.Content>
            </RadixDialog.Portal>
          </RadixDialog.Root>

          <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
          <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} />
          <ScrollRestoration />
        </HeadingFocusContext.Provider>
      </ShellActionsContext.Provider>
    </SidebarModeContext.Provider>
  );
}
