import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * The pathname whose page heading should take focus once it renders. AppShell
 * sets it on every navigation; the matching PageHeader takes it, whether it
 * was already on screen or arrives later with a lazily loaded page.
 */
export const HeadingFocusContext = createContext<{ current: string | null } | null>(null);

/** An open dialog. Radix keeps one on screen as `closed` while it animates out, no longer holding focus. */
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/**
 * Uses up the heading focus request for `pathname`, if there is one, and says
 * whether the heading should take focus now. It should not when focus is in
 * a dialog, opened while the page's code loaded: the dialog would pull focus
 * straight back with its text selected, so the next key typed would replace
 * what had been typed.
 */
export function claimHeadingFocus(
  pending: { current: string | null } | null,
  pathname: string,
): boolean {
  if (pending === null || pending.current !== pathname) return false;
  pending.current = null;
  return !document.activeElement?.closest(OPEN_DIALOG);
}

/**
 * The top of a page: its title, an optional line under it, actions on the
 * right, and anything else (tabs, a box) below. The title is the page's h1;
 * keyboard and screen reader users land on it after each navigation.
 */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const pending = useContext(HeadingFocusContext);
  const { pathname } = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Without scrolling, so a restored scroll position on Back stays put.
    if (claimHeadingFocus(pending, pathname)) heading.current?.focus({ preventScroll: true });
  }, [pending, pathname]);

  return (
    <header className="flex flex-col gap-5 pt-6 pb-6 md:pt-10">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1
            ref={heading}
            tabIndex={-1}
            className="break-words font-semibold text-2xl text-fg tracking-tight outline-none"
          >
            {title}
          </h1>
          {description ? <div className="mt-1 text-base text-fg-muted">{description}</div> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </header>
  );
}
