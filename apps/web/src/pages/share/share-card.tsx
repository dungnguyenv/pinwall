import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn, PinMark } from '../../ui/index.ts';

/**
 * The page around a share link's password and its notices, for people who
 * may never have seen Pinwall: one note centered on the canvas, held to it by
 * the Pinwall pin at its top edge, its title, a line of explanation, then
 * whatever it asks for. A quiet line under it says where the link comes from.
 * `loose`: the link no longer works, and the pin is drawn faded. On phones
 * the note's frame drops away and the pin sits above the title.
 */
export function ShareCard({
  title,
  description,
  loose = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  loose?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-dvh flex-col items-center bg-canvas px-4 pt-16 pb-10 sm:justify-center sm:py-12">
      <div className="w-full max-w-100">
        <div className="relative sm:rounded-xl sm:border sm:border-border sm:bg-surface sm:px-8 sm:pt-12 sm:pb-9 sm:shadow-card">
          <div
            aria-hidden="true"
            className="mb-6 flex justify-center sm:absolute sm:inset-x-0 sm:-top-4 sm:mb-0"
          >
            <PinMark size={32} className={cn(loose && 'text-fg-subtle')} />
          </div>
          <h1 className="text-balance text-center font-semibold text-2xl text-fg tracking-tight wrap-anywhere">
            {title}
          </h1>
          {description ? (
            <p className="mt-2 text-pretty text-center text-base text-fg-muted">{description}</p>
          ) : null}
          {children ? <div className="mt-8">{children}</div> : null}
        </div>
        <p className="mt-6 text-center text-fg-muted text-sm">
          {t('web.share.viewer.via', { app: t('app.name') })}
        </p>
      </div>
    </main>
  );
}
