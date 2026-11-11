import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, MessageSquare } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ApiError, errorMessage } from '../../api/client.ts';
import type {
  ArtifactSummary,
  Me,
  ShareLink,
  ShareLinkList as ShareLinkPage,
} from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { listShareLinks, revokeShareLink } from '../../api/shares.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  LoadingRegion,
  Skeleton,
  toast,
} from '../../ui/index.ts';
import { canRevoke, shareStatus } from './share-status.ts';

/** What a link shows: the latest version, or the one it is fixed to. */
function useScopeLabel() {
  const { t } = useTranslation();
  return (l: ShareLink) =>
    l.version
      ? t('web.share.scopeVersionShort', { number: l.version.number })
      : t('web.share.scopeLatestShort');
}

/**
 * The line a link is known by: its scope, the Password and Comments badges,
 * and its status when that is worth a badge (expired, revoked, ending soon).
 * Other statuses are left to the text under it.
 */
export function LinkTitle({ link, now }: { link: ShareLink; now: number }) {
  const { t } = useTranslation();
  const scope = useScopeLabel();
  const status = shareStatus(link, now);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium text-base text-fg">{scope(link)}</span>
      {link.has_password ? <Badge icon={<Lock />}>{t('web.share.badge.password')}</Badge> : null}
      {link.allow_comments ? (
        <Badge icon={<MessageSquare />}>{t('web.share.badge.comments')}</Badge>
      ) : null}
      {status.tone === 'neutral' ? null : (
        <Badge tone={status.tone}>{t(status.key, status.vars ?? {})}</Badge>
      )}
    </div>
  );
}

/** A link's status as plain text, for the ones `LinkTitle` does not badge. */
export function LinkStatusText({ link, now }: { link: ShareLink; now: number }) {
  const { t } = useTranslation();
  const status = shareStatus(link, now);
  return status.tone === 'neutral' ? <span>{t(status.key, status.vars ?? {})}</span> : null;
}

function LinkRow({
  link,
  now,
  revocable,
  onRevoke,
}: {
  link: ShareLink;
  now: number;
  revocable: boolean;
  onRevoke(): void;
}) {
  const { t } = useTranslation();
  const scope = useScopeLabel();
  const when = formatRelativeTime(link.created_at, now);
  const name = link.created_by?.name;
  return (
    <li className="flex items-start gap-3 py-3.5">
      <div className="min-w-0 flex-1">
        <LinkTitle link={link} now={now} />
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-fg-muted text-sm">
          <LinkStatusText link={link} now={now} />
          <span className="[overflow-wrap:anywhere]">
            {name ? t('web.share.madeBy', { name, when }) : t('web.share.madeByFormer', { when })}
          </span>
          <span>
            {link.last_used_at
              ? t('web.share.lastUsed', { when: formatRelativeTime(link.last_used_at, now) })
              : t('web.share.neverUsed')}
          </span>
        </p>
      </div>
      {revocable ? (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-danger"
          aria-label={t('web.share.revokeNamed', { scope: scope(link), when })}
          onClick={onRevoke}
        >
          {t('web.share.revoke')}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * The share links of `artifact` that work or lately did, newest first, with
 * Revoke on the ones `me` may revoke, after a question. Read afresh each time
 * it appears, since links also come from elsewhere (an agent, another tab).
 */
export function ShareLinkList({
  artifact,
  me,
}: {
  artifact: ArtifactSummary;
  me: Me | null | undefined;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingId = useId();
  const links = useInfiniteQuery<
    ShareLinkPage,
    ApiError,
    InfiniteData<ShareLinkPage>,
    ReturnType<typeof qk.shareLinks>,
    string | null
  >({
    queryKey: qk.shareLinks(artifact.id),
    queryFn: ({ pageParam }) => listShareLinks(artifact.id, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 0,
  });
  // The link a question is about stays as it was when asked, while the dialog fades out.
  const [revoking, setRevoking] = useState<{ link: ShareLink; open: boolean } | null>(null);
  const items = links.data?.pages.flatMap((page) => page.items) ?? [];
  const now = Date.now();

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="font-semibold text-fg text-md">
        {t('web.share.existing')}
      </h3>
      {links.isPending ? (
        <LoadingRegion label={t('web.share.loading')}>
          <div className="mt-3 flex flex-col gap-4">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        </LoadingRegion>
      ) : links.isError ? (
        <ErrorState
          compact
          message={errorMessage(links.error, t)}
          onRetry={() => void links.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="mt-3 rounded-lg border border-border-strong border-dashed px-4 py-5 text-center text-fg-muted text-sm">
          {t('web.share.none')}
        </p>
      ) : (
        <>
          <ul aria-label={t('web.share.listLabel')} className="mt-1 divide-y divide-border">
            {items.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                now={now}
                revocable={me != null && canRevoke(me, artifact, link)}
                onRevoke={() => setRevoking({ link, open: true })}
              />
            ))}
          </ul>
          {links.hasNextPage ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              loading={links.isFetchingNextPage}
              onClick={() => void links.fetchNextPage()}
            >
              {t('web.share.loadMore')}
            </Button>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={revoking?.open ?? false}
        onOpenChange={(open) => setRevoking((now) => (now ? { ...now, open } : now))}
        tone="danger"
        title={t('web.share.revokeTitle')}
        body={t('web.share.revokeBody')}
        confirmLabel={t('web.share.revokeConfirm')}
        errorMessage={(caught) => errorMessage(caught, t)}
        onConfirm={async () => {
          if (!revoking) return;
          await revokeShareLink(revoking.link.id);
          // The artifact's count of links that still open changes too.
          void queryClient.invalidateQueries({ queryKey: qk.artifact(artifact.id) });
          void queryClient.invalidateQueries({ queryKey: qk.artifactLists });
          await queryClient.invalidateQueries({ queryKey: qk.shareLinks(artifact.id) });
          toast.success(t('web.share.revoked'));
        }}
      />
    </section>
  );
}
