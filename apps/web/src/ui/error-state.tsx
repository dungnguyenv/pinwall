import { CircleAlert, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './button.tsx';

/** What a list shows when loading failed: what happened, and a way to try again. */
export function ErrorState({
  title,
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-sm flex-col items-center px-4 py-12 text-center"
    >
      <div
        aria-hidden="true"
        className="mb-4 grid size-12 place-items-center rounded-xl bg-danger-soft text-danger [&_svg]:size-5"
      >
        <CircleAlert />
      </div>
      <p className="font-semibold text-fg text-md">{title ?? t('web.common.error')}</p>
      <p className="mt-1 text-base text-fg-muted">{message}</p>
      {onRetry ? (
        <Button variant="secondary" className="mt-5" leadingIcon={<RotateCw />} onClick={onRetry}>
          {t('web.common.retry')}
        </Button>
      ) : null}
    </div>
  );
}
