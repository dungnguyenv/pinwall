import { type ReactNode, type RefObject, useLayoutEffect, useState } from 'react';
import { cn } from '../../ui/index.ts';

/** The size of the element `ref` points at, kept up to date as it changes. 0 × 0 until measured. */
export function useElementSize(ref: RefObject<HTMLElement | null>): {
  width: number;
  height: number;
} {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries.at(-1)?.contentRect;
      if (rect === undefined) return;
      setSize((now) =>
        now.width === rect.width && now.height === rect.height
          ? now
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Where the page sits: a muted surface the frame fills on Desktop, or on which
 * a device frame is centered. In comment mode an accent edge runs round it, so
 * the mode is plain wherever the eye is. `notices` float at the top centre,
 * over the page; they take pointer events only on themselves.
 */
export function Stage({
  stageRef,
  framed,
  commenting,
  notices,
  children,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  framed: boolean;
  commenting: boolean;
  notices: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      ref={stageRef}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-surface-muted"
    >
      <div className={cn('absolute inset-0', framed && 'grid place-items-center')}>{children}</div>
      {commenting ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 animate-fade-in ring-2 ring-accent ring-inset"
        />
      ) : null}
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center px-4">
        {notices}
      </div>
    </div>
  );
}

/** A short line at the top of the stage, with an optional action after it. */
export function StagePill({
  tone = 'quiet',
  children,
  action,
}: {
  tone?: 'quiet' | 'accent';
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'pointer-events-auto mb-2 flex max-w-full animate-pop-in items-center gap-3 rounded-full px-4 py-1.5 text-sm shadow-popover',
        tone === 'accent'
          ? 'bg-accent text-primary-fg'
          : 'border border-border bg-surface text-fg-muted',
      )}
    >
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  );
}

/** What the stage shows in place of the page: why it is not there, and where to go. */
export function StageMessage({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid size-full place-items-center p-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <p className="font-semibold text-fg text-md [overflow-wrap:anywhere]">{title}</p>
        {message ? <p className="mt-1 text-base text-fg-muted">{message}</p> : null}
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}
