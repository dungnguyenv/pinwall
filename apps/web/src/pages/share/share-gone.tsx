import { useTranslation } from 'react-i18next';
import { type ApiError, errorMessage } from '../../api/client.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { ShareCard } from './share-card.tsx';

/** The title for a link the server refused with `error`: unknown (404), expired, or otherwise gone (410). */
function goneTitle(error: ApiError): string {
  if (error.status === 404) return 'share.notFound.title';
  return error.details?.reason === 'expired' ? 'share.expired.title' : 'share.gone.title';
}

/**
 * What a share link that no longer opens shows: unknown, expired, revoked, or
 * gone with what it shared. The title names which; the explanation is the
 * server's, word for word. There is nothing to retry.
 */
export function ShareGone({ error }: { error: ApiError }) {
  const { t } = useTranslation();
  const title = t(goneTitle(error));
  usePageTitle(title);
  return <ShareCard loose title={title} description={errorMessage(error, t)} />;
}
