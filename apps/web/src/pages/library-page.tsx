import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type ApiError, errorMessage } from '../api/client.ts';
import { PageHeader } from '../app/shell/page-header.tsx';
import { Button, ErrorState } from '../ui/index.ts';

/** The width and gutters of every library page. */
export function LibraryPage({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-(--content-library) px-4 pb-16 md:px-8">{children}</div>
  );
}

/**
 * Why a page could not show what its address names. Something that does not
 * exist or was deleted (404, 410) gets a heading with the server's own words
 * and a way back; anything else may pass, so it offers Retry.
 */
export function PageError({
  error,
  unavailableTitle,
  onRetry,
}: {
  error: ApiError;
  unavailableTitle: string;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const message = errorMessage(error, t);
  if (error.status === 404 || error.status === 410) {
    return (
      <PageHeader title={unavailableTitle} description={<span role="alert">{message}</span>}>
        <div>
          <Button asChild variant="secondary">
            <Link to="/">{t('web.library.goToAll')}</Link>
          </Button>
        </div>
      </PageHeader>
    );
  }
  return (
    <div className="pt-6 md:pt-10">
      <ErrorState message={message} onRetry={onRetry} />
    </div>
  );
}
