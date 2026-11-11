import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-fg-muted',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

/** A short status label ("Private", "Shared link"). Text, not color alone, carries the meaning. */
export function Badge({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 max-w-full items-center gap-1 whitespace-nowrap rounded-sm px-1.5 font-medium text-xs',
        TONES[tone],
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-3">
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
