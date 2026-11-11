import { Link } from 'react-router';
import type { ArtifactSummary } from '../api/dto.ts';
import { ArtifactSignals, useArtifactMeta } from './artifact-meta.tsx';
import { ArtifactThumb } from './artifact-thumb.tsx';

/**
 * One artifact in the list view: the same facts as a card, in a row. The
 * signals sit at the end of the row on wide screens and under the name on
 * phones. `projectName` is given where artifacts of several projects mix. As
 * on a card, the link's name is everything the row shows, the artifact's name
 * first (WCAG 2.5.3, Label in Name).
 */
export function ArtifactRow({
  artifact,
  projectName,
}: {
  artifact: ArtifactSummary;
  projectName?: string;
}) {
  const meta = useArtifactMeta(artifact, projectName);
  return (
    <Link
      to={`/a/${encodeURIComponent(artifact.id)}`}
      className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 rounded-lg px-2 py-2 outline-offset-0 transition-colors hover:bg-surface-muted sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]"
    >
      <div className="row-span-2 sm:row-span-1">
        <ArtifactThumb artifact={artifact} size="row" />
      </div>
      <span className="flex min-w-0 flex-col">
        <span title={artifact.name} className="truncate font-medium text-base text-fg">
          {artifact.name}
        </span>{' '}
        <span className="truncate text-fg-muted text-sm">{meta}</span>
      </span>{' '}
      <ArtifactSignals
        artifact={artifact}
        className="col-start-2 justify-self-start sm:col-start-3 sm:row-start-1"
      />
    </Link>
  );
}
