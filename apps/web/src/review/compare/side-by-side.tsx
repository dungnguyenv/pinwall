import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactSummary, VersionSummary } from '../../api/dto.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import {
  type ComparedFrame,
  ComparedFrameView,
  NoSyncNote,
  useComparedFrames,
} from './compared-frames.tsx';

/**
 * The two versions next to each other, each in half the width under its
 * number; on phones one above the other. Whichever page the pointer or focus
 * is on leads, and the other scrolls with it while `sync` is on.
 */
export function SideBySide({
  artifact,
  pair,
  versions,
  sync,
}: {
  artifact: ArtifactSummary;
  pair: { from: number; to: number };
  versions: VersionSummary[];
  sync: boolean;
}) {
  const frames = useComparedFrames(artifact.id, pair, sync);
  return (
    <div className="relative grid size-full grid-cols-2 gap-px bg-border max-md:grid-cols-1 max-md:grid-rows-2">
      {(['from', 'to'] as const).map((side) => (
        <Pane
          key={side}
          artifact={artifact}
          frame={frames[side]}
          version={versions.find((v) => v.number === frames[side].n)}
          onLead={() => frames.lead(side)}
        />
      ))}
      {sync && frames.blocked ? <NoSyncNote /> : null}
    </div>
  );
}

function Pane({
  artifact,
  frame,
  version,
  onLead,
}: {
  artifact: ArtifactSummary;
  frame: ComparedFrame;
  version: VersionSummary | undefined;
  onLead(): void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <section
      aria-labelledby={labelId}
      onPointerEnter={onLead}
      onFocus={onLead}
      className="flex min-h-0 min-w-0 flex-col bg-surface-muted"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-border border-b bg-canvas px-3">
        <span id={labelId} className="font-semibold text-fg text-sm tabular-nums">
          {t('web.compare.version', { number: frame.n })}
        </span>
        {version ? (
          <span className="truncate text-fg-muted text-xs">
            {formatRelativeTime(version.created_at)}
          </span>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <ComparedFrameView artifact={artifact} frame={frame} />
      </div>
    </section>
  );
}
