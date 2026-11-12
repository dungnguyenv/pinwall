import { ChevronsLeftRight } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactSummary } from '../../api/dto.ts';
import { cn } from '../../ui/index.ts';
import { ComparedFrameView, NoSyncNote, useComparedFrames } from './compared-frames.tsx';

/** The version names at the box's two edges, over the pages. */
const EDGE_LABEL =
  'pointer-events-none absolute top-3 z-20 rounded-full bg-primary px-2.5 py-0.5 font-semibold text-primary-fg text-xs tabular-nums shadow-card';

/** Where the divider starts: halfway. */
const START = 50;

/** `n` within 0..100, to one decimal. */
function clampPercent(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

/**
 * The two versions in one box, `to` over `from`: left of the divider shows
 * `from`, right of it `to`. The divider is a slider: arrow keys move it by 1,
 * with Shift by 10, Home and End to the edges, and it drags with the pointer.
 * While dragging, a clear shield covers the pages, so the frames never take
 * the pointer away. Scrolling always follows the page last pointed at.
 */
export function OverlayView({
  artifact,
  pair,
}: {
  artifact: ArtifactSummary;
  pair: { from: number; to: number };
}) {
  const { t } = useTranslation();
  const frames = useComparedFrames(artifact.id, pair, true);
  const [split, setSplit] = useState(START);
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const splitAt = (clientX: number) => {
    const rect = boxRef.current?.getBoundingClientRect();
    if (rect === undefined || !(rect.width > 0)) return;
    setSplit(clampPercent(((clientX - rect.left) / rect.width) * 100));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    const next = (() => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          return split + step;
        case 'ArrowLeft':
        case 'ArrowDown':
          return split - step;
        case 'PageUp':
          return split + 10;
        case 'PageDown':
          return split - 10;
        case 'Home':
          return 0;
        case 'End':
          return 100;
        default:
          return null;
      }
    })();
    if (next === null) return;
    e.preventDefault();
    setSplit(clampPercent(next));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    setDragging(true);
    splitAt(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (dragging) splitAt(e.clientX);
  };
  const endDrag = () => setDragging(false);

  return (
    // Moves and releases bubble here from the captured divider, or from the shield where a
    // browser does not capture.
    <div
      ref={boxRef}
      data-overlay=""
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="relative size-full overflow-hidden bg-surface-muted"
    >
      <section
        aria-label={t('web.compare.version', { number: pair.from })}
        data-overlay-from=""
        className="absolute inset-0"
        onPointerEnter={() => frames.lead('from')}
        onFocus={() => frames.lead('from')}
      >
        <ComparedFrameView artifact={artifact} frame={frames.from} />
      </section>
      <section
        aria-label={t('web.compare.version', { number: pair.to })}
        data-overlay-top=""
        className="absolute inset-0"
        style={{ clipPath: `inset(0 0 0 ${split}%)` }}
        onPointerEnter={() => frames.lead('to')}
        onFocus={() => frames.lead('to')}
      >
        <ComparedFrameView artifact={artifact} frame={frames.to} />
      </section>
      {dragging ? (
        <div data-drag-shield="" className="absolute inset-0 z-10 cursor-ew-resize" />
      ) : null}

      <span aria-hidden="true" className={cn(EDGE_LABEL, 'left-3')}>
        {t('web.compare.version', { number: pair.from })}
      </span>
      <span aria-hidden="true" className={cn(EDGE_LABEL, 'right-3')}>
        {t('web.compare.version', { number: pair.to })}
      </span>

      <div
        role="slider"
        tabIndex={0}
        aria-label={t('web.compare.slider', { from: pair.from, to: pair.to })}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={split}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onLostPointerCapture={endDrag}
        style={{ left: `${split}%` }}
        className="group absolute inset-y-0 z-20 w-6 -translate-x-1/2 cursor-ew-resize touch-none select-none outline-none"
      >
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-primary shadow-[0_0_0_1px_var(--pw-canvas)]"
        />
        <div
          aria-hidden="true"
          className="absolute top-1/2 left-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-fg shadow-popover ring-2 ring-canvas transition-transform duration-(--duration-fast) group-hover:scale-105 group-focus-visible:outline-2 group-focus-visible:outline-accent group-focus-visible:outline-offset-2 group-focus-visible:outline-solid group-active:scale-95 motion-reduce:transition-none [&_svg]:size-4"
        >
          <ChevronsLeftRight />
        </div>
      </div>
      {frames.blocked ? <NoSyncNote /> : null}
    </div>
  );
}
