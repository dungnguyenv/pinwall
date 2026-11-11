import type { UseQueryResult } from '@tanstack/react-query';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ApiError, errorMessage } from '../../api/client.ts';
import type { ArtifactSummary, ContentGrant } from '../../api/dto.ts';
import { useReviewGrant } from '../../api/versions.ts';
import { cn, ErrorState } from '../../ui/index.ts';
import { ContentFrame } from '../frame/content-frame.tsx';
import { frameBox } from '../frame/device.ts';
import { type FrameBridge, useFrameBridge, type ViewerPin } from '../frame/use-frame-bridge.ts';
import { createScrollSync, type Side } from './scroll-sync.ts';

/** Compare shows the pages only: no comment pins, never comment mode. */
const NO_PINS: ViewerPin[] = [];
const FILL = frameBox('desktop', 0, { width: 0, height: 0 });
const ignore = () => {};

export interface ComparedFrame {
  n: number;
  grant: UseQueryResult<ContentGrant, ApiError>;
  bridge: FrameBridge;
}

/**
 * The two versions' review frames, each from its own review grant, with their
 * scrolling kept in step: whichever frame the reviewer last pointed at or
 * focused (`lead`) leads, and the other follows by fractions, while `sync` is
 * on. `blocked`: a page has no annotator, so it neither reports nor follows.
 */
export function useComparedFrames(
  artifactId: string,
  pair: { from: number; to: number },
  sync: boolean,
): { from: ComparedFrame; to: ComparedFrame; lead(side: Side): void; blocked: boolean } {
  const [scroll] = useState(createScrollSync);
  const bridges = useRef<Partial<Record<Side, FrameBridge>>>({});
  const mirror = (side: Side) => (f: { x: number; y: number }) => {
    const next = scroll.scrolled(side, f);
    if (next !== null) bridges.current[next.side]?.scrollTo(next.f);
  };

  const fromGrant = useReviewGrant(artifactId, pair.from);
  const toGrant = useReviewGrant(artifactId, pair.to);
  const fromBridge = useFrameBridge(fromGrant.data?.url ?? '', {
    pins: NO_PINS,
    mode: 'browse',
    version: pair.from,
    expiresAt: fromGrant.data?.expires_at,
    onScrolled: mirror('from'),
  });
  const toBridge = useFrameBridge(toGrant.data?.url ?? '', {
    pins: NO_PINS,
    mode: 'browse',
    version: pair.to,
    expiresAt: toGrant.data?.expires_at,
    onScrolled: mirror('to'),
  });
  useLayoutEffect(() => {
    bridges.current = { from: fromBridge, to: toBridge };
    scroll.setEnabled(sync);
  });

  return {
    from: { n: pair.from, grant: fromGrant, bridge: fromBridge },
    to: { n: pair.to, grant: toGrant, bridge: toBridge },
    lead: scroll.lead,
    blocked: fromBridge.annotator === 'missing' || toBridge.annotator === 'missing',
  };
}

/** One version's page in its review frame, or why it cannot be shown. */
export function ComparedFrameView({
  artifact,
  frame,
}: {
  artifact: ArtifactSummary;
  frame: ComparedFrame;
}) {
  const { t } = useTranslation();
  const { grant } = frame;
  if (grant.isError && grant.data === undefined) {
    const gone = grant.error.status === 404 || grant.error.status === 410;
    return (
      <div className="grid size-full place-items-center p-4">
        <ErrorState
          title={t('web.review.previewFailed')}
          message={errorMessage(grant.error, t)}
          onRetry={gone ? undefined : () => void grant.refetch()}
        />
      </div>
    );
  }
  return (
    <ContentFrame
      bridge={frame.bridge}
      title={t('web.review.frameTitle', { name: artifact.name, number: frame.n })}
      box={FILL}
      pins={NO_PINS}
      mode="browse"
      onPicked={ignore}
      onPinClicked={ignore}
      overlayNote={false}
    />
  );
}

/** A quiet line at the foot of the pages: scrolling cannot be kept in step. */
export function NoSyncNote({ className }: { className?: string }): ReactNode {
  const { t } = useTranslation();
  return (
    <p
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-3 z-20 mx-auto w-fit max-w-[calc(100%-2rem)] animate-fade-in rounded-xl border border-border bg-surface px-3 py-1 text-center text-fg-muted text-sm shadow-card',
        className,
      )}
    >
      {t('web.compare.noSync')}
    </p>
  );
}
