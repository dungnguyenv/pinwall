import { ChevronRight, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import type { ArtifactSummary } from '../../api/dto.ts';
import { useArtifact, useProject } from '../../api/library.ts';
import { PageHeader } from '../../app/shell/page-header.tsx';
import { formatRelativeTime } from '../../lib/format.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { ArtifactSignals } from '../../library/artifact-meta.tsx';
import { ArtifactThumb } from '../../library/artifact-thumb.tsx';
import { Button, LoadingRegion, Skeleton } from '../../ui/index.ts';
import { LibraryPage, PageError } from '../library-page.tsx';
import { NotFoundPage } from '../not-found-page.tsx';

const VERSION_NUMBER = /^[1-9]\d*$/;

/** Project / artifact, above the title. The project's name loads on its own. */
function Breadcrumb({ artifact }: { artifact: ArtifactSummary }) {
  const { t } = useTranslation();
  const project = useProject(artifact.project_id);
  return (
    <nav aria-label={t('web.artifact.breadcrumb')} className="pt-5 md:pt-8">
      <ol className="flex min-w-0 items-center gap-1 text-fg-muted text-sm">
        <li className="flex min-w-0 shrink items-center">
          {project.data ? (
            <Link
              to={`/projects/${encodeURIComponent(project.data.id)}`}
              className="truncate rounded-sm hover:text-fg hover:underline hover:underline-offset-2"
            >
              {project.data.name}
            </Link>
          ) : project.isError ? null : (
            <Skeleton className="h-3.5 w-24" />
          )}
        </li>
        <li aria-hidden="true" className="flex shrink-0">
          <ChevronRight className="size-3.5" />
        </li>
        <li className="min-w-0 shrink-[2] truncate text-fg" aria-current="page">
          {artifact.name}
        </li>
      </ol>
    </nav>
  );
}

function ArtifactSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.artifact.loading')}>
      <div className="flex flex-col gap-4 pt-5 md:pt-8">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="mt-2 h-8 w-72 max-w-full" />
        <Skeleton className="h-4 w-44" />
        <Skeleton className="mt-4 aspect-[16/10] w-full max-w-4xl rounded-xl" />
      </div>
    </LoadingRegion>
  );
}

function ArtifactView({ artifactId, n }: { artifactId: string; n: string | undefined }) {
  const { t } = useTranslation();
  const query = useArtifact(artifactId);
  usePageTitle(query.data?.name ?? null);

  if (!query.data) {
    if (query.isError) {
      return (
        <div className="pt-5 md:pt-8">
          <PageError
            error={query.error}
            unavailableTitle={t('web.artifact.unavailable')}
            onRetry={() => void query.refetch()}
          />
        </div>
      );
    }
    return <ArtifactSkeleton />;
  }

  const artifact = query.data;
  const number = n === undefined ? artifact.current_version?.number : Number(n);
  const base = `/a/${encodeURIComponent(artifact.id)}`;
  const rawHref = n === undefined ? `${base}/raw` : `${base}/v/${n}/raw`;
  const time = formatRelativeTime(artifact.updated_at);

  return (
    <>
      <Breadcrumb artifact={artifact} />
      {/* The breadcrumb sits close above the title. */}
      <div className="[&>header]:pt-3">
        <PageHeader
          title={artifact.name}
          description={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                {number === undefined
                  ? t('web.artifact.updated', { time })
                  : t('web.artifact.headline', {
                      version: t('web.artifact.version', { number }),
                      time,
                    })}
              </span>{' '}
              <ArtifactSignals artifact={artifact} />
            </span>
          }
          actions={
            <Button asChild leadingIcon={<ExternalLink />}>
              <a href={rawHref} target="_blank" rel="noopener">
                {t('web.artifact.openPage')}{' '}
                <span className="sr-only">{t('web.artifact.newTab')}</span>
              </a>
            </Button>
          }
        />
      </div>
      <div className="max-w-4xl">
        <ArtifactThumb artifact={artifact} size="hero" />
      </div>
    </>
  );
}

/**
 * Where an artifact's links land: `/a/:id`, `/a/:id/v/:n` and
 * `/a/:id/compare`. Until the review screen arrives it shows the artifact's
 * place, version and picture, and opens the page itself in a new tab.
 */
export function ArtifactPage() {
  const { artifactId = '', n } = useParams();
  if (n !== undefined && !VERSION_NUMBER.test(n)) return <NotFoundPage />;
  return (
    <LibraryPage>
      <ArtifactView key={artifactId} artifactId={artifactId} n={n} />
    </LibraryPage>
  );
}
