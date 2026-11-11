import { useTranslation } from 'react-i18next';
import { Dialog, Kbd } from '../../ui/index.ts';
import { REVIEW_SHORTCUTS } from './shortcuts.ts';

/** Every key of the review screen with what it does, from the same list the handler uses. */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('web.shortcuts.title')}
      description={t('web.shortcuts.frameNote')}
      size="sm"
    >
      <dl className="flex flex-col">
        {REVIEW_SHORTCUTS.map((s) => (
          <div
            key={s.action}
            className="flex items-center justify-between gap-4 border-border border-b py-2 last:border-b-0"
          >
            <dt className="min-w-0 text-base text-fg">{t(s.label)}</dt>
            <dd className="shrink-0">
              <Kbd keys={s.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
