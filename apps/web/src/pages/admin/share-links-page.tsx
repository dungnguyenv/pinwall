import { Link2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminShareLinks } from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import type { AdminShareLink } from '../../api/dto.ts';
import { useMediaQuery } from '../../lib/media.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { Button, cn, EmptyState, ErrorState, LoadingRegion, Skeleton } from '../../ui/index.ts';
import { useRowDialog } from '../settings/use-row-dialog.ts';
import { DeleteArtifactDialog, RevokeLinkDialog } from './moderation-dialogs.tsx';
import { Day, LinkBadges, MadeByLine, PersonText, ShowsText, When } from './moderation-parts.tsx';

/**
 * The table has eight columns and an actions column, and needs the width the content area has
 * at its widest. The users table needs the same room, so both turn into cards under the same
 * window width: the open sidebar, a scrollbar and the content's maximum width reach it from
 * about 1480 px.
 */
const TABLE_QUERY = '(min-width: 1500px)';

/**
 * `/admin/share-links`: every share link that still opens, with whose it is and how it is set up.
 * Metadata only. A link is stored as a hash, so nothing here leads to the link, the artifact or
 * its content; the actions end a link, or delete the artifact for good.
 */
export function ShareLinksPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.admin.links'));
  const links = useAdminShareLinks();
  const roomForTable = useMediaQuery(TABLE_QUERY);
  const revoking = useRowDialog<AdminShareLink>();
  const deleting = useRowDialog<AdminShareLink>();

  const items = links.data?.pages.flatMap((page) => page.items);

  return (
    <div className="flex flex-col gap-5">
      <p className="max-w-prose text-pretty text-base text-fg-muted">{t('web.admin.links.hint')}</p>

      {items === undefined ? (
        links.isError ? (
          <ErrorState message={errorMessage(links.error, t)} onRetry={() => void links.refetch()} />
        ) : (
          <LinksSkeleton />
        )
      ) : items.length === 0 ? (
        <EmptyState icon={<Link2 />} title={t('web.admin.links.empty')} />
      ) : (
        <>
          {roomForTable ? (
            <LinkTable links={items} onRevoke={revoking.show} onDelete={deleting.show} />
          ) : (
            <LinkCards links={items} onRevoke={revoking.show} onDelete={deleting.show} />
          )}
          {links.isFetchNextPageError ? (
            <p role="alert" className="text-center text-danger text-sm">
              {errorMessage(links.error, t)}
            </p>
          ) : null}
          {links.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={links.isFetchingNextPage}
                onClick={() => void links.fetchNextPage()}
              >
                {t('web.admin.links.loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <RevokeLinkDialog
        open={revoking.open}
        onOpenChange={revoking.onOpenChange}
        target={
          revoking.item && { linkId: revoking.item.id, artifactName: revoking.item.artifact.name }
        }
      />
      <DeleteArtifactDialog
        open={deleting.open}
        onOpenChange={deleting.onOpenChange}
        target={
          deleting.item && {
            artifactId: deleting.item.artifact.id,
            artifactName: deleting.item.artifact.name,
          }
        }
      />
    </div>
  );
}

function LinksSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.admin.links.loading')}>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border bg-border">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-2 bg-surface px-4 py-4">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

interface LinkListProps {
  links: AdminShareLink[];
  onRevoke(link: AdminShareLink): void;
  onDelete(link: AdminShareLink): void;
}

const TH = 'whitespace-nowrap px-3 py-2.5 text-left font-medium text-fg-muted text-sm';
const TD = 'px-3 py-3.5 align-top';

/** Where the content area is wide: one row per link. If it still overflows (large text), the table scrolls within its box. */
function LinkTable({ links, onRevoke, onDelete }: LinkListProps) {
  const { t } = useTranslation();
  const heads = [
    'artifact',
    'owner',
    'shows',
    'options',
    'created',
    'expires',
    'lastUsed',
  ] as const;
  return (
    // `relative` holds the screen-reader-only texts inside the box; left to the page they would widen it.
    <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[60rem] border-collapse text-base">
        <caption className="sr-only">{t('web.admin.links')}</caption>
        <thead className="border-border border-b bg-surface-muted/60">
          <tr>
            {heads.map((head) => (
              <th key={head} scope="col" className={TH}>
                {t(`web.admin.links.col.${head}`)}
              </th>
            ))}
            <th scope="col" className={TH}>
              <span className="sr-only">{t('web.admin.links.col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {links.map((link) => (
            <tr key={link.id}>
              <th
                scope="row"
                className={`${TD} min-w-40 text-left font-medium text-fg [overflow-wrap:anywhere]`}
              >
                {link.artifact.name}
              </th>
              <td className={`${TD} min-w-48`}>
                <OwnerCell link={link} />
              </td>
              <td className={`${TD} whitespace-nowrap text-fg`}>
                <ShowsText version={link.version} />
              </td>
              <td className={`${TD} min-w-28`}>
                <LinkBadges link={link} />
              </td>
              <td className={`${TD} whitespace-nowrap text-fg`}>
                <Day at={link.created_at} />
              </td>
              <td className={`${TD} whitespace-nowrap text-fg`}>
                <When at={link.expires_at} />
              </td>
              <td className={`${TD} whitespace-nowrap text-fg`}>
                <When at={link.last_used_at} />
              </td>
              <td className={`${TD} whitespace-nowrap text-right`}>
                <LinkActions link={link} onRevoke={onRevoke} onDelete={onDelete} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Everywhere narrower: one card per link, the same facts stacked. */
function LinkCards({ links, onRevoke, onDelete }: LinkListProps) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('web.admin.links')} className="flex flex-col gap-3">
      {links.map((link) => (
        <li
          key={link.id}
          className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
        >
          <p className="font-medium text-base text-fg [overflow-wrap:anywhere]">
            {link.artifact.name}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <CardFact label={t('web.admin.links.col.owner')} wide>
              <OwnerCell link={link} />
            </CardFact>
            <CardFact label={t('web.admin.links.col.shows')}>
              <ShowsText version={link.version} />
            </CardFact>
            <CardFact label={t('web.admin.links.col.options')}>
              <LinkBadges link={link} />
            </CardFact>
            <CardFact label={t('web.admin.links.col.created')}>
              <Day at={link.created_at} />
            </CardFact>
            <CardFact label={t('web.admin.links.col.expires')}>
              <When at={link.expires_at} />
            </CardFact>
            <CardFact label={t('web.admin.links.col.lastUsed')}>
              <When at={link.last_used_at} />
            </CardFact>
          </dl>
          <LinkActions link={link} onRevoke={onRevoke} onDelete={onDelete} stacked />
        </li>
      ))}
    </ul>
  );
}

function CardFact({
  label,
  wide = false,
  children,
}: {
  label: string;
  /** Spans both columns, for a fact with several lines. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col items-start gap-1', wide && 'col-span-2')}>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  );
}

/** Whose artifact it is, and, when someone else made the link, who. */
function OwnerCell({ link }: { link: AdminShareLink }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <PersonText person={link.owner} />
      <MadeByLine link={link} />
    </div>
  );
}

/** Revoke ends the link; Delete artifact removes everything it opened, for its owner too. */
function LinkActions({
  link,
  onRevoke,
  onDelete,
  stacked = false,
}: {
  link: AdminShareLink;
  onRevoke(link: AdminShareLink): void;
  onDelete(link: AdminShareLink): void;
  stacked?: boolean;
}) {
  const { t } = useTranslation();
  const name = link.artifact.name;
  const variant = stacked ? 'secondary' : 'ghost';
  const size = stacked ? 'md' : 'sm';
  return (
    <div className={cn('flex items-center', stacked ? 'gap-2' : 'justify-end gap-1')}>
      <Button
        variant={variant}
        size={size}
        className={cn('text-danger', stacked && 'flex-1')}
        aria-label={t('web.admin.links.revokeFor', { name })}
        onClick={() => onRevoke(link)}
      >
        {t('web.admin.links.revoke')}
      </Button>
      <Button
        variant={variant}
        size={size}
        className={cn('text-danger', stacked && 'flex-1')}
        aria-label={t('web.admin.links.deleteArtifactFor', { name })}
        onClick={() => onDelete(link)}
      >
        {t('web.admin.links.deleteArtifact')}
      </Button>
    </div>
  );
}
