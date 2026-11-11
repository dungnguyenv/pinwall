import { Link } from 'react-router';
import type { ArtifactSummary } from '../api/dto.ts';
import { ArtifactSignals, useArtifactMeta } from './artifact-meta.tsx';
import { ArtifactThumb } from './artifact-thumb.tsx';

/**
 * One artifact in the grid: its picture, then its name and what changed when.
 * The whole card is a single link. Its name is everything it shows, the
 * artifact's name first, so what a person sees is what a voice command or a
 * screen reader gets (WCAG 2.5.3, Label in Name).
 */
export function ArtifactCard({ artifact }: { artifact: ArtifactSummary }) {
  const meta = useArtifactMeta(artifact);
  return (
    <Link
      to={`/a/${encodeURIComponent(artifact.id)}`}
      className="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card transition-[border-color,box-shadow] duration-(--duration-base) hover:border-border-strong/45 hover:shadow-popover"
    >
      <div className="border-border border-b">
        <ArtifactThumb artifact={artifact} size="card" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3.5 pt-3 pb-3.5">
        <span title={artifact.name} className="truncate font-medium text-base text-fg">
          {artifact.name}
        </span>{' '}
        <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <span className="min-w-0 truncate text-fg-muted text-sm">{meta}</span>{' '}
          <ArtifactSignals artifact={artifact} />
        </span>
      </div>
    </Link>
  );
}
