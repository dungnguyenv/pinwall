import { CircleAlert, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './button.tsx';
import { cn } from './cn.ts';

/**
 * What a list shows when loading failed: what happened, and a way to try again.
 * `compact` fits it into a narrow column such as the sidebar.
 */
export function ErrorState({
  title,
  message,
  onRetry,
  compact = false,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn(
        'mx-auto flex max-w-sm flex-col items-center text-center',
        compact ? 'px-2 py-4' : 'px-4 py-12',
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'grid place-items-center bg-danger-soft text-danger',
          compact
            ? 'mb-2 size-8 rounded-lg [&_svg]:size-4'
            : 'mb-4 size-12 rounded-xl [&_svg]:size-5',
        )}
      >
        <CircleAlert />
      </div>
      <p className={cn('font-semibold text-fg', compact ? 'text-base' : 'text-md')}>
        {title ?? t('web.common.error')}
      </p>
      <p className={cn('mt-1 text-fg-muted', compact ? 'text-sm' : 'text-base')}>{message}</p>
      {onRetry ? (
        <Button
          variant="secondary"
          size={compact ? 'sm' : 'md'}
          className={compact ? 'mt-3' : 'mt-5'}
          leadingIcon={<RotateCw />}
          onClick={onRetry}
        >
          {t('web.common.retry')}
        </Button>
      ) : null}
    </div>
  );
}
