import { TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactSummary, CreatedShareLink, VersionSummary } from '../../api/dto.ts';
import { Button, CopyField, Dialog } from '../../ui/index.ts';
import { ShareForm } from './share-form.tsx';
import { LinkStatusText, LinkTitle, ShareLinkList } from './share-link-list.tsx';

/**
 * Makes share links for an artifact and lists the ones it has. Two steps. The
 * form asks what the link shows, who can open it, when it ends and whether
 * people may comment; the list of existing links sits under it. The result
 * step shows the link's URL, the only time anything does: it lives in this
 * component's state alone, never in a query or mutation cache, and is dropped
 * as soon as the dialog has closed. Until then only Done closes the dialog.
 *
 * `shown` is the version on screen, which the link can be fixed to; null when
 * it is not known, which leaves only the latest version to choose.
 */
export function ShareDialog({
  open,
  onOpenChange,
  artifact,
  shown,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  artifact: ArtifactSummary;
  shown: VersionSummary | null;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const urlBox = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreatedShareLink | null>(null);

  // Each opening starts from a blank form.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setCreated(null);
  }

  // With the URL on screen, focus it selected, so copying is one keystroke away.
  // Selecting scrolls a long URL to its end; show the start.
  useEffect(() => {
    const field = created ? urlBox.current?.querySelector('input') : null;
    if (!field) return;
    field.focus();
    field.scrollLeft = 0;
  }, [created]);

  // While the request runs, closing would leave a link nobody holds the URL of; once the
  // URL shows, closing drops it for good. Both wait for the button made for it: Done.
  const locked = pending || created !== null;
  const now = Date.now();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!locked}
      title={created ? t('web.share.createdTitle') : t('web.share.title', { name: artifact.name })}
      description={created ? undefined : t('web.share.hint')}
      // The dialog has finished closing: only now may the URL go, or its text
      // would blank out while the dialog fades.
      onCloseAutoFocus={() => setCreated(null)}
      footer={
        created ? (
          <Button onClick={() => onOpenChange(false)}>{t('web.share.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
              {t('web.common.cancel')}
            </Button>
            <Button type="submit" form={formId} loading={pending}>
              {t('web.share.create')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-4">
          <p className="flex items-start gap-2.5 rounded-lg bg-warning-soft px-3.5 py-3 text-fg text-sm">
            <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-warning" />
            <span>{t('web.share.urlOnce')}</span>
          </p>
          <div ref={urlBox}>
            <CopyField label={t('web.share.link')} value={created.url} mono />
          </div>
          <div className="flex flex-col gap-1">
            <LinkTitle link={created.link} now={now} />
            <p className="text-fg-muted text-sm">
              <LinkStatusText link={created.link} now={now} />
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-7">
          <ShareForm
            artifactId={artifact.id}
            shown={shown}
            formId={formId}
            onPending={setPending}
            onCreated={setCreated}
          />
          <ShareLinkList artifact={artifact} />
        </div>
      )}
    </Dialog>
  );
}
