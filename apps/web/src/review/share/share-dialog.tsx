import { useQueryClient } from '@tanstack/react-query';
import { Eye, Lock, TriangleAlert } from 'lucide-react';
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactSummary, CreatedShareLink, VersionSummary } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { useMe } from '../../api/session.ts';
import { mayExpose, useArtifactRights } from '../../api/spaces.ts';
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
 * Two people get an explanation where the form would be, and nothing else
 * changes: one whom the server's policy does not let make share links yet (an
 * admin has to approve them; the server may also say so mid-way, when approval
 * was taken away while the dialog was open), and a viewer of the project. Their
 * links still list, and revoke where their rights allow it.
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
  const queryClient = useQueryClient();
  const me = useMe().data;
  const rights = useArtifactRights(artifact);
  const formId = useId();
  const urlBox = useRef<HTMLDivElement>(null);
  const explanation = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreatedShareLink | null>(null);
  // The server refused a link for lack of approval, which the person's own record does not show yet.
  const [refused, setRefused] = useState(false);

  // Each opening starts from a blank form.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCreated(null);
      setRefused(false);
    }
  }

  // Approval comes before the role, as on the server. Without a `me` the 1.0 rule applies.
  const notApproved = refused || (me != null && !mayExpose(me));
  const viewer = !notApproved && !rights.createShareLinks;
  const explained = notApproved || viewer;

  // The form was the focus when it went; the words that replace it take over.
  useEffect(() => {
    if (refused) explanation.current?.focus();
  }, [refused]);

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
      description={created || explained ? undefined : t('web.share.hint')}
      // The dialog has finished closing: only now may the URL go, or its text
      // would blank out while the dialog fades.
      onCloseAutoFocus={() => setCreated(null)}
      footer={
        created ? (
          <Button onClick={() => onOpenChange(false)}>{t('web.share.done')}</Button>
        ) : explained ? (
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('web.common.close')}
          </Button>
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
          {notApproved ? (
            <Callout ref={explanation} icon={<Lock />} title={t('web.share.notApproved.title')}>
              <p>{t('spaces.exposure.shareLink')}</p>
              <p>{t('web.share.notApproved.suspended')}</p>
            </Callout>
          ) : viewer ? (
            <Callout icon={<Eye />} title={t('web.share.viewerRole.title')}>
              <p>{t('spaces.role.createShareLink')}</p>
            </Callout>
          ) : (
            <ShareForm
              artifactId={artifact.id}
              shown={shown}
              formId={formId}
              onPending={setPending}
              onCreated={setCreated}
              onRefused={() => {
                setRefused(true);
                // The person's record is wrong now; the rest of the app reads it afresh.
                void queryClient.invalidateQueries({ queryKey: qk.me });
              }}
            />
          )}
          <ShareLinkList artifact={artifact} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * Why there is no form: a title and the reason in the server's own words. Takes
 * focus with `ref` when it replaces a form the person was using.
 */
function Callout({
  ref,
  icon,
  title,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="flex items-start gap-2.5 rounded-lg bg-surface-muted px-3.5 py-3"
    >
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-fg-muted [&_svg]:size-4">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5 text-fg-muted text-sm">
        <p className="font-medium text-base text-fg">{title}</p>
        {children}
      </div>
    </div>
  );
}
