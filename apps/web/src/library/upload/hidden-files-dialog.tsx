import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from '../../ui/index.ts';

/** What the person decided about the hidden files of a selection. */
export type HiddenChoice = 'skip' | 'include' | 'cancel';

/** How many paths the dialog lists before "and N more". */
const LISTED = 8;

/**
 * Asks about the hidden files (names starting with a dot) of a selection
 * before anything is sent, because a file manager does not show them and
 * `.env` or `.npmrc` can hold secrets. Skipping them is the default: it has
 * the focus, and closing the dialog sends nothing at all. `paths` is `null`
 * while nothing is being asked.
 */
export function HiddenFilesDialog({
  paths,
  onChoose,
}: {
  paths: string[] | null;
  onChoose(choice: HiddenChoice): void;
}) {
  const { t } = useTranslation();
  const skip = useRef<HTMLButtonElement>(null);
  // The dialog keeps its words while it fades out.
  const shown = useRef<string[]>([]);
  if (paths) shown.current = paths;
  const list = shown.current;
  const more = list.length - LISTED;

  return (
    <Dialog
      open={paths !== null}
      onOpenChange={(open) => {
        if (!open) onChoose('cancel');
      }}
      title={t('web.upload.hiddenTitle')}
      description={t('web.upload.hiddenBody', { count: list.length })}
      initialFocus={skip}
      footer={
        <>
          <Button variant="secondary" onClick={() => onChoose('include')}>
            {t('web.upload.hiddenInclude')}
          </Button>
          <Button ref={skip} onClick={() => onChoose('skip')}>
            {t('web.upload.hiddenSkip')}
          </Button>
        </>
      }
    >
      <ul
        aria-label={t('web.upload.hiddenList')}
        className="max-h-56 overflow-y-auto rounded-md bg-surface-muted px-3 py-2 text-sm"
      >
        {list.slice(0, LISTED).map((path) => (
          <li key={path} className="py-0.5 font-mono text-fg [overflow-wrap:anywhere]">
            {path}
          </li>
        ))}
        {more > 0 ? (
          <li className="py-0.5 text-fg-muted">{t('web.upload.hiddenMore', { count: more })}</li>
        ) : null}
      </ul>
    </Dialog>
  );
}
