import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';
import { type ApiError, errorMessage } from '../../api/client.ts';
import type { ShareInfo } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { getShareInfo } from '../../api/shares.ts';
import { grantRenewDelay } from '../../api/versions.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { ErrorState, LoadingRegion, Skeleton } from '../../ui/index.ts';
import { ShareGone } from './share-gone.tsx';
import { SharePassword } from './share-password.tsx';
import { ShareViewer } from './share-viewer.tsx';

/**
 * What link `token` shows, with a new content grant each time it is read. It
 * is read again only to renew that grant (five minutes before it expires) or
 * when the live stream says the link changed, never because time passed or
 * the tab came back: each read makes a grant. The app's queries never retry a
 * 4xx, so a link that is locked (401), unknown (404) or gone (410) says so at once.
 */
function useShareInfo(token: string): UseQueryResult<ShareInfo, ApiError> {
  return useQuery<ShareInfo, ApiError>({
    queryKey: qk.shareInfo(token),
    queryFn: () => getShareInfo(token),
    staleTime: Number.POSITIVE_INFINITY,
    // A tab in the background keeps renewing too: it is the one left open for hours.
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const info = query.state.data;
      return info ? grantRenewDelay(info.content.expires_at) : false;
    },
  });
}

/** Whether `error` says the link has a password this browser has not unlocked. */
function isLocked(error: ApiError): boolean {
  return error.status === 401 && error.details?.password_required === true;
}

/**
 * `/s/:token`, the page a share link opens: the password page for a link
 * this browser has not unlocked, a notice for one that is unknown or gone,
 * otherwise the shared page. It stands outside the app's shell and needs no
 * account. Search engines are told to leave it alone.
 */
export function SharePage(): ReactElement {
  const { token = '' } = useParams();
  return (
    <>
      <meta name="robots" content="noindex, nofollow" />
      <ShareScreen key={token} token={token} />
    </>
  );
}

function ShareScreen({ token }: { token: string }) {
  const query = useShareInfo(token);
  const { error, data } = query;
  // A refusal wins over what was shown before it: the unlock ran out, or the link went.
  if (error !== null && isLocked(error)) return <SharePassword token={token} />;
  if (error !== null && (error.status === 404 || error.status === 410)) {
    return <ShareGone error={error} />;
  }
  if (data !== undefined) return <ShareViewer token={token} info={data} />;
  if (error !== null) return <ShareFailed error={error} onRetry={() => void query.refetch()} />;
  return <ShareLoading />;
}

/** Any other failure to open the link: what the server said, and a way to try again. */
function ShareFailed({ error, onRetry }: { error: ApiError; onRetry(): void }) {
  const { t } = useTranslation();
  usePageTitle(null);
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4">
      <ErrorState
        title={t('web.share.viewer.loadFailed')}
        message={errorMessage(error, t)}
        onRetry={onRetry}
      />
    </main>
  );
}

/** The bar and the page, as grey shapes, faded in late so a quick answer shows nothing. */
function ShareLoading() {
  const { t } = useTranslation();
  usePageTitle(null);
  return (
    <LoadingRegion label={t('web.share.viewer.loading')}>
      <div className="flex h-dvh animate-fade-in flex-col bg-canvas [animation-delay:250ms]">
        <div className="flex h-11 shrink-0 items-center gap-3 border-border border-b px-3">
          <Skeleton className="size-5 rounded-full" />
          <Skeleton className="h-4 w-40 max-w-[40%]" />
          <div className="flex-1" />
          <Skeleton className="h-7 w-16" />
        </div>
        <div className="min-h-0 flex-1 bg-surface-muted" />
      </div>
    </LoadingRegion>
  );
}
