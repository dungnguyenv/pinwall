import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, LoadingRegion, Logo, Skeleton } from '../../ui/index.ts';

/**
 * The page around every sign-in and setup screen: the logo, then one card
 * centered on the canvas. On phones the card's frame drops away and its
 * content sits on the canvas with the usual 16 px gutter.
 */
function Frame({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-canvas px-4 pt-14 pb-12 sm:justify-center sm:py-12">
      <div className={cn('w-full', wide ? 'max-w-120' : 'max-w-100')}>
        {/* The h1 below names the product; the logo is its picture. */}
        <div aria-hidden="true" className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="sm:rounded-xl sm:border sm:border-border sm:bg-surface sm:px-8 sm:py-9 sm:shadow-card">
          {children}
        </div>
      </div>
    </main>
  );
}

/** A sign-in or setup screen: its title, an optional line under it, then the content. */
export function AuthLayout({
  title,
  description,
  wide,
  children,
}: {
  title: string;
  description?: string;
  /** The setup form's width (480 px) instead of sign-in's (400 px). */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Frame wide={wide}>
      <h1 className="text-balance text-center font-semibold text-2xl text-fg tracking-tight wrap-anywhere">
        {title}
      </h1>
      {description ? (
        <p className="mt-2 text-balance text-center text-base text-fg-muted">{description}</p>
      ) : null}
      <div className="mt-8">{children}</div>
    </Frame>
  );
}

/** The card's content while what it needs loads. It fades in late, so a quick load shows nothing. */
export function AuthSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="animate-fade-in [animation-delay:250ms]">
      <LoadingRegion label={t('web.common.loading')}>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-11 w-full rounded-full" />
          <Skeleton className="mt-4 h-4 w-20" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-11 w-full rounded-full" />
        </div>
      </LoadingRegion>
    </div>
  );
}

/** Stands in for a sign-in or setup page while its code loads. */
export function AuthPageFallback({ wide }: { wide?: boolean }) {
  return (
    <Frame wide={wide}>
      <Skeleton className="mx-auto h-8 w-52 animate-fade-in [animation-delay:250ms]" />
      <div className="mt-8">
        <AuthSkeleton />
      </div>
    </Frame>
  );
}

/**
 * A screen with nothing to fill in: why, and the one thing to do next.
 * `danger` announces itself, since it says something went wrong.
 */
export function AuthNotice({
  icon,
  tone = 'neutral',
  action,
  children,
}: {
  icon: ReactNode;
  tone?: 'neutral' | 'danger';
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className="flex flex-col items-center text-center"
    >
      <div
        aria-hidden="true"
        className={cn(
          'mb-4 grid size-11 place-items-center rounded-xl [&_svg]:size-5',
          tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-surface-muted text-fg-muted',
        )}
      >
        {icon}
      </div>
      <p className="text-pretty text-fg text-md">{children}</p>
      {action ? <div className="mt-6 w-full">{action}</div> : null}
    </div>
  );
}

/** A form's own failure, such as a refused request, said where the person is looking. */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-danger text-sm"
    >
      <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** "or", between two ways to do the same thing. */
export function OrDivider() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 text-fg-muted text-sm">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      {t('web.auth.or')}
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}
