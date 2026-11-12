import { cn } from '../../ui/cn.ts';

/**
 * A comment thread's pin: its number on an accent disc, muted once resolved,
 * ringed while selected. The point overlay and the comment panel draw the same
 * pin, so a number on the page and in the list read as one thing.
 */
export function PinBadge({
  number,
  resolved,
  selected = false,
}: {
  number: number;
  resolved: boolean;
  selected?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 min-w-6 shrink-0 select-none items-center justify-center rounded-full px-1.5 font-semibold text-xs tabular-nums leading-none',
        // primary-fg is white on the light accent and near-black on the dark one: ≥ 4.5:1 in both.
        resolved
          ? 'bg-surface-muted text-fg-muted ring-1 ring-border-strong ring-inset'
          : 'bg-accent text-primary-fg',
        selected && 'outline-2 outline-accent outline-offset-2',
      )}
    >
      {number}
    </span>
  );
}
