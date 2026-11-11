import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../ui/cn.ts';
import type { FrameBox } from './device.ts';
import { PointOverlay } from './point-overlay.tsx';
import { CONTENT_ALLOW, CONTENT_SANDBOX } from './sandbox.ts';
import type { FrameBridge, PickedAnchor, ViewerPin } from './use-frame-bridge.ts';

export { PointOverlay } from './point-overlay.tsx';

/**
 * The artifact in its sandboxed frame, sized and scaled by `box`. The wrapper
 * carries `data-annotator`; a thin bar runs along the top while a page loads;
 * when the page runs no annotator, the point overlay covers it.
 */
export function ContentFrame({
  bridge,
  title,
  box,
  pins,
  mode,
  onPicked,
  onPinClicked,
  className,
}: {
  bridge: FrameBridge;
  title: string;
  box: FrameBox;
  pins: ViewerPin[];
  mode: 'browse' | 'comment';
  onPicked(p: PickedAnchor): void;
  onPinClicked(id: string): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const frameSize: CSSProperties = box.framed
    ? {
        width: box.width,
        height: box.height,
        transform: box.scale === 1 ? undefined : `scale(${box.scale})`,
      }
    : { width: '100%', height: '100%' };
  return (
    <div
      data-annotator={bridge.annotator}
      className={cn('relative overflow-hidden', !box.framed && 'size-full', className)}
      style={
        box.framed ? { width: box.width * box.scale, height: box.height * box.scale } : undefined
      }
    >
      {bridge.src === '' ? null : (
        <iframe
          ref={bridge.frameRef}
          title={title}
          src={bridge.src}
          sandbox={CONTENT_SANDBOX}
          allow={CONTENT_ALLOW}
          referrerPolicy="no-referrer"
          onLoad={bridge.onFrameLoad}
          className="block origin-top-left border-0"
          // A page that paints no background shows the browser's default canvas, as on its raw
          // link; a page that asks for dark colors gets its own dark canvas.
          style={{ ...frameSize, colorScheme: 'light', backgroundColor: 'Canvas' }}
        />
      )}
      {bridge.annotator === 'missing' ? (
        <PointOverlay
          box={box}
          page={bridge.topPage}
          pins={pins}
          mode={mode}
          onPicked={onPicked}
          onPinClicked={onPinClicked}
        />
      ) : null}
      {bridge.loading ? (
        <div
          role="progressbar"
          aria-label={t('web.frame.loading')}
          className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-accent-soft"
        >
          <div className="h-full w-2/5 animate-indeterminate bg-accent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
        </div>
      ) : null}
    </div>
  );
}
