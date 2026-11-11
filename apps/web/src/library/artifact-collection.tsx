import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client.ts';
import type { ArtifactSummary } from '../api/dto.ts';
import type { useArtifacts } from '../api/library.ts';
import { Button, ErrorState, LoadingRegion, Skeleton } from '../ui/index.ts';
import { ArtifactCard } from './artifact-card.tsx';
import { ArtifactRow } from './artifact-row.tsx';
import type { LibraryView } from './view-toggle.tsx';

const SKELETONS = 6;

/** Every column at least 220px wide, as many as fit; one on a phone. */
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4';

function CollectionSkeleton({ view, label }: { view: LibraryView; label: string }) {
  const placeholders = Array.from({ length: SKELETONS }, (_, i) => `skeleton-${i}`);
  return (
    <LoadingRegion label={label}>
      {view === 'grid' ? (
        <div className={GRID}>
          {placeholders.map((key) => (
            <div key={key} className="overflow-hidden rounded-lg border border-border">
              <Skeleton className="aspect-[16/10] rounded-none" />
              <div className="flex flex-col gap-2 px-3.5 pt-3.5 pb-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {placeholders.map((key) => (
            <div key={key} className="flex items-center gap-4 px-2 py-2">
              <Skeleton className="aspect-[16/10] w-18 shrink-0 sm:w-22" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      )}
    </LoadingRegion>
  );
}

/** The pages loaded so far, in order. An artifact that moved between pages while they loaded shows once. */
function uniqueItems(pages: { items: ArtifactSummary[] }[]): ArtifactSummary[] {
  const seen = new Set<string>();
  const items: ArtifactSummary[] = [];
  for (const page of pages) {
    for (const artifact of page.items) {
      if (seen.has(artifact.id)) continue;
      seen.add(artifact.id);
      items.push(artifact);
    }
  }
  return items;
}

/** Whether the list has loaded and holds nothing, where grid or list would make no difference. */
export function isEmptyCollection(query: ReturnType<typeof useArtifacts>): boolean {
  return query.data?.pages.every((page) => page.items.length === 0) ?? false;
}

/**
 * A library list in whichever state its query is in: skeletons while the first
 * page loads, an error with Retry, `empty` when there is nothing, then the
 * grid or the list and a "Load more" button while pages remain. A failed later
 * page keeps what is shown and says why under it.
 */
export function ArtifactCollection({
  query,
  view,
  label,
  empty,
  projectNames,
}: {
  query: ReturnType<typeof useArtifacts>;
  view: LibraryView;
  label: string;
  empty: ReactNode;
  projectNames?: Map<string, string>;
}) {
  const { t } = useTranslation();

  if (query.data === undefined) {
    if (query.isError) {
      return (
        <ErrorState message={errorMessage(query.error, t)} onRetry={() => void query.refetch()} />
      );
    }
    return <CollectionSkeleton view={view} label={t('web.library.loading')} />;
  }

  const items = uniqueItems(query.data.pages);
  if (items.length === 0) return <>{empty}</>;

  return (
    <div className="flex flex-col gap-6">
      {view === 'grid' ? (
        <ul aria-label={label} className={GRID}>
          {items.map((artifact) => (
            <li key={artifact.id} className="min-w-0">
              <ArtifactCard artifact={artifact} />
            </li>
          ))}
        </ul>
      ) : (
        <ul aria-label={label} className="-mx-2 flex flex-col gap-0.5">
          {items.map((artifact) => (
            <li key={artifact.id} className="min-w-0">
              <ArtifactRow
                artifact={artifact}
                projectName={projectNames?.get(artifact.project_id)}
              />
            </li>
          ))}
        </ul>
      )}
      {query.isFetchNextPageError ? (
        <p role="alert" className="text-center text-danger text-sm">
          {errorMessage(query.error, t)}
        </p>
      ) : null}
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t('web.library.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
