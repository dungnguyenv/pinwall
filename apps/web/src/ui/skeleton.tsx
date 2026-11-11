import { VisuallyHidden } from 'radix-ui';
import { type ReactNode, useId } from 'react';
import { cn } from './cn.ts';

/**
 * A placeholder block shaped like the content it stands in for. A soft band of
 * light crosses it, then rests; under reduced motion it stays still.
 * Size it with `className` (e.g. "h-4 w-40").
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative overflow-hidden rounded-md bg-surface-muted',
        'after:absolute after:inset-0 after:animate-shimmer after:bg-linear-100 after:from-transparent after:via-shimmer after:to-transparent motion-reduce:after:hidden',
        className,
      )}
    />
  );
}

/**
 * Wraps skeletons so assistive technology hears one polite "Loading …" instead
 * of nothing. The label is visually hidden.
 */
export function LoadingRegion({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="status" aria-live="polite" aria-labelledby={id}>
      <VisuallyHidden.Root id={id}>{label}</VisuallyHidden.Root>
      {children}
    </div>
  );
}
