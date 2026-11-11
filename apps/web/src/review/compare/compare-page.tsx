import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { errorMessage } from '../../api/client.ts';
import { useVersionDiff } from '../../api/diff.ts';
import type { ArtifactSummary } from '../../api/dto.ts';
import { useArtifact } from '../../api/library.ts';
import { reviewPath, useVersions } from '../../api/versions.ts';
import { PHONE_QUERY, useMediaQuery } from '../../lib/media.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { LibraryPage, PageError } from '../../pages/library-page.tsx';
import { Button, ErrorState, LoadingRegion, Skeleton } from '../../ui/index.ts';
import { BackLink, CompareBar, CompareHeading } from './compare-bar.tsx';
import { COMPARE_VIEWS, type CompareView, defaultPair, isMarkdownPath } from './defaults.ts';
import { OverlayView } from './overlay-view.tsx';
import { RenderedDiff } from './rendered-diff.tsx';
import { SideBySide } from './side-by-side.tsx';
import { DiffListError, SourceDiff } from './source-diff.tsx';

const VERSION_NUMBER = /^[1-9]\d*$/;

/** A version number from the address, or undefined when there is none or it is malformed. */
function numberParam(value: string | null): number | undefined {
  return value !== null && VERSION_NUMBER.test(value) ? Number(value) : undefined;
}

const PAGE_CLASS = 'flex h-dvh flex-col bg-canvas max-md:h-[calc(100dvh-var(--topbar-height))]';

/**
 * `/a/:artifactId/compare?from=&to=&view=`: two versions of an artifact side
 * by side, overlaid with a slider, as source changes, or as rendered Markdown.
 * The address holds the choice; missing or unknown parts are filled in and
 * written back in place, so a link always opens the same comparison.
 */
export function ComparePage(): ReactElement {
  const { artifactId = '' } = useParams();
  return <CompareScreen key={artifactId} artifactId={artifactId} />;
}

/** The artifact's loading and failure, around the comparison itself. */
function CompareScreen({ artifactId }: { artifactId: string }) {
  const { t } = useTranslation();
  const query = useArtifact(artifactId);
  usePageTitle(query.data ? t('web.compare.title', { name: query.data.name }) : null);
  if (query.data === undefined) {
    if (query.isError) {
      return (
        <LibraryPage>
          <div className="pt-5 md:pt-8">
            <PageError
              error={query.error}
              unavailableTitle={t('web.artifact.unavailable')}
              onRetry={() => void query.refetch()}
            />
          </div>
        </LibraryPage>
      );
    }
    return <CompareSkeleton />;
  }
  return <Compare artifact={query.data} />;
}

function CompareSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.compare.loading')}>
      <div className={PAGE_CLASS}>
        <div className="flex h-(--topbar-height) shrink-0 items-center gap-3 border-border border-b px-3">
          <Skeleton className="h-4 w-40 max-w-[30%]" />
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-7 w-64 max-md:hidden" />
        </div>
        <div className="min-h-0 flex-1 bg-surface-muted" />
      </div>
    </LoadingRegion>
  );
}

function Compare({ artifact }: { artifact: ArtifactSummary }) {
  const { t } = useTranslation();
  const phone = useMediaQuery(PHONE_QUERY);
  const { search } = useLocation();
  const [params, setParams] = useSearchParams();
  const [sync, setSync] = useState(true);

  const versions = useVersions(artifact.id);
  const list = useMemo(
    () => versions.data?.pages.flatMap((page) => page.items) ?? [],
    [versions.data],
  );
  const asked = { from: numberParam(params.get('from')), to: numberParam(params.get('to')) };
  // A version the address names may be on a later page: read on until it is found or there is none.
  const missing = [asked.from, asked.to].some(
    (n) => n !== undefined && !list.some((v) => v.number === n),
  );
  // A page that fails to load ends the search: the versions read so far decide.
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError } = versions;
  const readOn = missing && hasNextPage && !isFetchNextPageError;
  const reading = versions.data === undefined || readOn;
  useEffect(() => {
    if (readOn && !isFetchingNextPage) void fetchNextPage();
  }, [readOn, isFetchingNextPage, fetchNextPage]);

  const pair = reading ? null : defaultPair(list, asked.from, asked.to);
  const diff = useVersionDiff(artifact.id, pair?.from ?? null, pair?.to ?? null);
  const markdownPaths = useMemo(
    () => diff.data?.files.map((f) => f.path).filter(isMarkdownPath) ?? [],
    [diff.data],
  );
  // Rendered is offered for Markdown: the artifact is Markdown, or a changed file is.
  const rendered: boolean | null =
    artifact.kind === 'markdown' || markdownPaths.length > 0
      ? true
      : diff.data !== undefined || diff.isError
        ? false
        : null;
  const views = COMPARE_VIEWS.filter((v) => v !== 'rendered' || rendered === true);
  const askedView = COMPARE_VIEWS.find((v) => v === params.get('view'));
  // Rendered waits for the file list before it is turned down.
  const view: CompareView =
    askedView === undefined || (askedView === 'rendered' && rendered === false)
      ? 'side'
      : askedView;

  const write = (next: { from: number; to: number; view: CompareView }) =>
    setParams(
      new URLSearchParams({ from: String(next.from), to: String(next.to), view: next.view }),
      { replace: true },
    );
  const normal =
    pair === null
      ? null
      : `?${new URLSearchParams({ from: String(pair.from), to: String(pair.to), view })}`;
  useEffect(() => {
    if (normal !== null && normal !== search)
      setParams(new URLSearchParams(normal), { replace: true });
  }, [normal, search, setParams]);

  if (versions.isError && versions.data === undefined) {
    return (
      <div className={PAGE_CLASS}>
        <div className="grid flex-1 place-items-center">
          <ErrorState
            title={t('web.compare.versionsFailed')}
            message={errorMessage(versions.error, t)}
            onRetry={() => void versions.refetch()}
          />
        </div>
      </div>
    );
  }
  if (pair === null) {
    if (reading) return <CompareSkeleton />;
    return <SingleVersion artifact={artifact} />;
  }

  const choose = (side: 'from' | 'to', n: number) => {
    const other = side === 'from' ? pair.to : pair.from;
    // Choosing the other side's version swaps the two.
    if (n === other) write({ from: pair.to, to: pair.from, view });
    else write({ ...pair, [side]: n, view });
  };
  const entry = list.find((v) => v.number === pair.to)?.entry_path;

  const content = (() => {
    switch (view) {
      case 'side':
        return <SideBySide artifact={artifact} pair={pair} versions={list} sync={sync} />;
      case 'overlay':
        return <OverlayView artifact={artifact} pair={pair} />;
      case 'files':
        return <SourceDiff artifactId={artifact.id} pair={pair} diff={diff} phone={phone} />;
      case 'rendered':
        if (diff.isError) return <DiffListError diff={diff} />;
        return diff.data === undefined ? null : (
          <RenderedDiff artifact={artifact} pair={pair} paths={markdownPaths} entry={entry} />
        );
    }
  })();

  return (
    <div className={PAGE_CLASS}>
      <CompareBar
        artifact={artifact}
        phone={phone}
        versions={list}
        pair={pair}
        view={view}
        views={views}
        sync={view === 'side' ? sync : null}
        onFrom={(n) => choose('from', n)}
        onTo={(n) => choose('to', n)}
        onSwap={() => write({ from: pair.to, to: pair.from, view })}
        onView={(next) => write({ ...pair, view: next })}
        onSync={setSync}
      />
      <div className="relative min-h-0 flex-1">{content}</div>
    </div>
  );
}

/** One version has nothing to compare with: say so, and lead back. */
function SingleVersion({ artifact }: { artifact: ArtifactSummary }) {
  const { t } = useTranslation();
  return (
    <div className={PAGE_CLASS}>
      <header className="flex h-(--topbar-height) shrink-0 items-center border-border border-b px-2 md:px-3">
        <CompareHeading name={artifact.name} />
        <BackLink artifact={artifact} compact={false} />
      </header>
      <div className="grid flex-1 place-items-center p-6">
        <div className="flex max-w-sm flex-col items-center text-center">
          <p className="text-balance text-base text-fg-muted">{t('web.compare.single')}</p>
          <Button asChild variant="secondary" className="mt-5">
            <Link to={reviewPath(artifact.id)}>
              {t('web.compare.back', { name: artifact.name })}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
