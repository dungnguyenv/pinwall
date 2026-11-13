import { Ban, Link2Off, PowerOff, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminDeleteVersion, useEndVersionGrants, useSetUserRole } from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import type { AdminLookup } from '../../api/dto.ts';
import { useMe } from '../../api/session.ts';
import { Button, ConfirmDialog, toast } from '../../ui/index.ts';
import { DeleteArtifactDialog, RevokeLinkDialog } from './moderation-dialogs.tsx';
import { Day, PersonText, personName, ShowsText, When } from './moderation-parts.tsx';

type Takedown = 'revoke' | 'endGrants' | 'deleteVersion' | 'deleteArtifact' | 'block';

/**
 * What a reported address belongs to, and what an admin can do about it. The facts are the
 * artifact, its project and owner, the version, and the share link or open page behind the
 * address, never the content. Every action asks first, then `onChanged` runs the look-up again,
 * so the result shows what is left.
 */
export function LookupResult({ result, onChanged }: { result: AdminLookup; onChanged(): void }) {
  const { t } = useTranslation();
  const headingId = useId();
  const { data: me } = useMe();
  const [asking, setAsking] = useState<Takedown | null>(null);
  const endGrants = useEndVersionGrants();
  const deleteVersion = useAdminDeleteVersion();
  const setRole = useSetUserRole();

  const { artifact, version, share_link: link, grant } = result;
  const { owner } = artifact;
  // Blocking yourself is refused by the server too; the button is simply not offered.
  const blockable = owner !== null && owner.id !== me?.id;
  const ownerName = owner ? personName(owner, t('web.admin.person.unnamed')) : '';
  const dialog = (kind: Takedown) => ({
    open: asking === kind,
    onOpenChange: (open: boolean) => setAsking(open ? kind : null),
  });

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-lg border border-border bg-surface"
    >
      <h2
        id={headingId}
        className="border-border border-b px-4 py-3 font-semibold text-fg text-md sm:px-5"
      >
        {t(`web.admin.lookup.kind.${result.kind}`)}
      </h2>
      <div className="divide-y divide-border">
        <Group title={t('web.admin.lookup.group.what')}>
          <Facts>
            <Fact label={t('web.admin.links.col.artifact')}>{artifact.name}</Fact>
            <Fact label={t('web.admin.lookup.fact.project')}>{artifact.project.name}</Fact>
            <Fact label={t('web.admin.links.col.owner')}>
              <PersonText person={owner} />
            </Fact>
            <Fact label={t('web.admin.lookup.fact.version')}>
              {t('web.share.scopeVersionShort', { number: version.number })}
            </Fact>
            <Fact label={t('web.admin.lookup.fact.publishedBy')}>
              <PersonText person={version.published_by} />
            </Fact>
          </Facts>
        </Group>

        {link ? (
          <Group title={t('web.admin.lookup.group.link')}>
            <Facts>
              <Fact label={t('web.admin.links.col.shows')}>
                <ShowsText version={link.version} />
              </Fact>
              <Fact label={t('web.admin.links.col.madeBy')}>
                <PersonText person={link.created_by} />
              </Fact>
              <Fact label={t('web.admin.links.col.created')}>
                <Day at={link.created_at} />
              </Fact>
              <Fact label={t('web.admin.links.col.expires')}>
                <When at={link.expires_at} />
              </Fact>
              <Fact label={t('web.admin.links.password')}>
                {link.has_password ? t('web.admin.lookup.yes') : t('web.admin.lookup.no')}
              </Fact>
              <Fact label={t('web.admin.links.comments')}>
                {link.allow_comments
                  ? t('web.admin.lookup.allowed')
                  : t('web.admin.lookup.notAllowed')}
              </Fact>
              <Fact label={t('web.admin.links.col.lastUsed')}>
                <When at={link.last_used_at} />
              </Fact>
            </Facts>
          </Group>
        ) : null}

        {grant ? (
          <Group title={t('web.admin.lookup.group.grant')}>
            <Facts>
              <Fact label={t('web.admin.lookup.fact.mode')}>
                {t(`web.admin.lookup.mode.${grant.mode}`)}
              </Fact>
              <Fact label={t('web.admin.links.col.expires')}>
                <When at={grant.expires_at} />
              </Fact>
              <Fact label={t('web.admin.lookup.fact.holder')}>
                {grant.holder ? <PersonText person={grant.holder} /> : t('web.admin.lookup.guest')}
              </Fact>
            </Facts>
          </Group>
        ) : null}

        <Group title={t('web.admin.lookup.group.actions')}>
          <div className="flex flex-wrap gap-2">
            {link ? (
              <Button
                variant="secondary"
                className="text-danger"
                leadingIcon={<Link2Off />}
                onClick={() => setAsking('revoke')}
              >
                {t('web.admin.lookup.revoke')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              leadingIcon={<PowerOff />}
              onClick={() => setAsking('endGrants')}
            >
              {t('web.admin.lookup.endGrants', { number: version.number })}
            </Button>
            <Button
              variant="secondary"
              className="text-danger"
              leadingIcon={<Trash2 />}
              onClick={() => setAsking('deleteVersion')}
            >
              {t('web.admin.lookup.deleteVersion', { number: version.number })}
            </Button>
            <Button
              variant="secondary"
              className="text-danger"
              leadingIcon={<Trash2 />}
              onClick={() => setAsking('deleteArtifact')}
            >
              {t('web.admin.links.deleteArtifact')}
            </Button>
            {blockable ? (
              <Button
                variant="secondary"
                className="text-danger"
                leadingIcon={<Ban />}
                onClick={() => setAsking('block')}
              >
                {t('web.admin.lookup.block')}
              </Button>
            ) : null}
          </div>
        </Group>
      </div>

      <RevokeLinkDialog
        {...dialog('revoke')}
        target={link && { linkId: link.id, artifactName: artifact.name }}
        onDone={onChanged}
      />
      <ConfirmDialog
        {...dialog('endGrants')}
        title={t('web.admin.lookup.endGrantsTitle', { number: version.number })}
        body={t('web.admin.lookup.endGrantsBody', { number: version.number })}
        confirmLabel={t('web.admin.lookup.endGrantsConfirm')}
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          const ended = await endGrants.mutateAsync(version.id);
          toast.success(t('web.admin.lookup.grantsEnded', { count: ended.grants }));
          onChanged();
        }}
      />
      <ConfirmDialog
        {...dialog('deleteVersion')}
        tone="danger"
        title={t('web.admin.lookup.deleteVersionTitle', {
          number: version.number,
          name: artifact.name,
        })}
        body={t('web.admin.lookup.deleteVersionBody', { number: version.number })}
        confirmLabel={t('web.admin.lookup.deleteVersion', { number: version.number })}
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          await deleteVersion.mutateAsync({ id: artifact.id, number: version.number });
          toast.success(
            t('web.admin.lookup.deleteVersionDone', {
              number: version.number,
              name: artifact.name,
            }),
          );
          onChanged();
        }}
      />
      <DeleteArtifactDialog
        {...dialog('deleteArtifact')}
        target={{ artifactId: artifact.id, artifactName: artifact.name }}
        onDone={onChanged}
      />
      <ConfirmDialog
        {...dialog('block')}
        tone="danger"
        title={t('web.admin.lookup.blockTitle', { name: ownerName })}
        body={t('web.admin.lookup.blockBody', { name: ownerName })}
        confirmLabel={t('web.admin.lookup.blockConfirm')}
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          if (owner === null) return;
          await setRole.mutateAsync({ id: owner.id, option: 'blocked' });
          toast.success(t('web.admin.lookup.blocked', { name: ownerName }));
          onChanged();
        }}
      />
    </section>
  );
}

/** A titled part of the result; the title names it for assistive technology. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; this groups facts and buttons
    <div role="group" aria-labelledby={id} className="px-4 py-4 sm:px-5">
      <h3 id={id} className="mb-3 font-medium text-fg-muted text-sm">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-base sm:grid-cols-[9rem_minmax(0,1fr)]">{children}</dl>
  );
}

/** One fact: its name above its value on a phone, side by side from 640 px. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:contents">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
