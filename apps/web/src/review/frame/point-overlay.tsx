import { type MouseEvent, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../ui/cn.ts';
import type { FrameBox } from './device.ts';
import { PinBadge } from './pin.tsx';
import type { PickedAnchor, ViewerPin } from './use-frame-bridge.ts';

/** The frame id of a pick made on the overlay, which has no annotator to name one. */
const OVERLAY_FRAME_ID = 'overlay';

/** `n` of `size` as a fraction within 0..1, to 4 decimals. */
function fraction(n: number, size: number): number {
  if (!(size > 0)) return 0;
  return Math.round(Math.min(1, Math.max(0, n / size)) * 10_000) / 10_000;
}

/**
 * Point comments over a page that runs no annotator (its own policy blocks
 * it). Pins sit where they were made, as fractions of the frame's visible box:
 * the page's scroll is unknown here, so they do not follow it. In comment mode
 * a click pins a comment to that spot; from the keyboard, to the middle.
 * Otherwise the page keeps its clicks and only the pins take theirs.
 */
export function PointOverlay({
  box,
  page,
  pins,
  mode,
  onPicked,
  onPinClicked,
}: {
  box: FrameBox;
  page: string;
  pins: ViewerPin[];
  mode: 'browse' | 'comment';
  onPicked(p: PickedAnchor): void;
  onPinClicked(id: string): void;
}) {
  const { t } = useTranslation();
  const noteId = useId();
  const commenting = mode === 'comment';
  const shown = pins
    .filter((p) => p.anchor.kind === 'point' && p.anchor.page === page)
    .sort((a, b) => a.number - b.number);

  const pick = (event: MouseEvent<HTMLButtonElement>) => {
    // A click from the keyboard (detail 0) has no pointer position.
    let x = box.width / 2;
    let y = box.height / 2;
    if (event.detail !== 0) {
      const rect = event.currentTarget.getBoundingClientRect();
      x = (event.clientX - rect.left) / box.scale;
      y = (event.clientY - rect.top) / box.scale;
    }
    onPicked({
      anchor: {
        page,
        kind: 'point',
        position: { x: fraction(x, box.width), y: fraction(y, box.height) },
        viewport: { width: Math.round(box.width) },
      },
      frameId: OVERLAY_FRAME_ID,
      topFrame: true,
      client: { x, y },
    });
  };

  const at = (f: number, size: number) => `${Math.round(f * size * box.scale * 100) / 100}px`;

  return (
    <div
      data-point-overlay=""
      className={cn('absolute inset-0 overflow-hidden', !commenting && 'pointer-events-none')}
    >
      {commenting ? (
        <>
          <button
            type="button"
            aria-label={t('web.frame.pickPoint')}
            aria-describedby={noteId}
            onClick={pick}
            className="absolute inset-0 size-full cursor-crosshair focus-visible:outline-offset-[-2px]"
          />
          <p
            id={noteId}
            className="pointer-events-none absolute right-3 bottom-3 left-3 max-w-88 rounded-lg border border-border bg-surface px-3 py-2 text-fg-muted text-xs shadow-popover sm:right-auto"
          >
            {t('web.comments.noAnnotator')}
          </p>
        </>
      ) : null}
      {shown.map((pin) => (
        <button
          key={pin.id}
          type="button"
          aria-label={t(pin.resolved ? 'web.frame.pinResolved' : 'web.frame.pin', {
            number: pin.number,
          })}
          onClick={() => onPinClicked(pin.id)}
          className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full shadow-popover ring-2 ring-canvas"
          style={{
            left: at(pin.anchor.position.x, box.width),
            top: at(pin.anchor.position.y, box.height),
          }}
        >
          <PinBadge number={pin.number} resolved={pin.resolved} />
        </button>
      ))}
    </div>
  );
}
