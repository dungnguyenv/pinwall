import { useTranslation } from 'react-i18next';

/**
 * Says that a newer version was published while the reviewer was writing,
 * and switches to it on request. The live region is always there, so a
 * screen reader hears the message as it arrives.
 */
export function LiveBanner({ pending, onSwitch }: { pending: number | null; onSwitch(): void }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex max-w-full justify-center">
      {pending === null ? null : (
        <div className="pointer-events-auto mb-2 flex max-w-full animate-pop-in items-center gap-3 rounded-full bg-primary py-1 pr-1 pl-4 text-primary-fg text-sm shadow-popover">
          <span className="min-w-0 truncate font-medium">
            {t('web.review.live.published', { number: pending })}
          </span>
          <button
            type="button"
            onClick={onSwitch}
            className="h-7 shrink-0 cursor-pointer rounded-full bg-primary-fg px-3 font-medium text-primary text-sm transition-opacity hover:opacity-85 focus-visible:outline-offset-2"
          >
            {t('web.review.live.switch')}
          </button>
        </div>
      )}
    </div>
  );
}
