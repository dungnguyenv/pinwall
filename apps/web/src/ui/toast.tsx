import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Toaster as SonnerToaster } from 'sonner';
import { Spinner } from './spinner.tsx';

export { toast } from 'sonner';

/*
 * Toasts are unstyled sonner toasts dressed in Pinwall tokens: a surface card
 * with a hairline and the popover shadow, the status shown by a colored icon
 * rather than a colored card. sonner keeps the stacking, swipe and timing.
 */
const TOAST_CLASSES = {
  toast:
    'flex w-(--width) items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-base text-fg shadow-popover',
  icon: 'mt-0.5 inline-flex shrink-0 [&_svg]:size-4',
  content: 'flex min-w-0 flex-1 flex-col gap-0.5',
  title: 'font-medium',
  description: 'text-fg-muted text-sm',
  actionButton:
    'ml-auto h-7 shrink-0 cursor-pointer self-center rounded-full bg-primary px-3 font-medium text-primary-fg text-sm transition-colors hover:bg-primary/85',
  cancelButton:
    'h-7 shrink-0 cursor-pointer self-center rounded-full px-3 font-medium text-fg-muted text-sm transition-colors hover:bg-surface-muted hover:text-fg',
};

export function Toaster() {
  const { t } = useTranslation();
  return (
    <SonnerToaster
      theme="system"
      position="bottom-right"
      offset={16}
      mobileOffset={12}
      gap={8}
      containerAriaLabel={t('web.common.notifications')}
      icons={{
        success: <CircleCheck className="text-success" />,
        error: <CircleAlert className="text-danger" />,
        warning: <TriangleAlert className="text-warning" />,
        info: <Info className="text-accent-text" />,
        loading: <Spinner className="text-fg-muted" />,
      }}
      toastOptions={{ unstyled: true, classNames: TOAST_CLASSES }}
    />
  );
}
