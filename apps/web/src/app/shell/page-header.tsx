import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * The pathname whose page heading should take focus once it renders. AppShell
 * sets it on every navigation; the matching PageHeader takes it, whether it
 * was already on screen or arrives later with a lazily loaded page.
 */
export const HeadingFocusContext = createContext<{ current: string | null } | null>(null);

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
    if (!pending || pending.current !== pathname) return;
    pending.current = null;
    // Without scrolling, so a restored scroll position on Back stays put.
    heading.current?.focus({ preventScroll: true });
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
