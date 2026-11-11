import { ToggleGroup as RadixToggleGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { Tooltip } from './tooltip.tsx';

/**
 * A segmented control of icon-only choices (Grid / List). Exactly one item is
 * always on: pressing the active item again does nothing. Each item is a radio
 * named by its label, which also shows as a tooltip.
 */
export function ToggleGroup<T extends string>({
  label,
  value,
  onValueChange,
  items,
}: {
  label: string;
  value: T;
  onValueChange(value: T): void;
  items: { value: T; label: string; icon: ReactNode }[];
}) {
  return (
    <RadixToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        // Radix reports '' when the active item is pressed again.
        const item = items.find((candidate) => candidate.value === next);
        if (item) onValueChange(item.value);
      }}
      className="inline-flex items-center gap-0.5 rounded-full border border-border p-0.5"
    >
      {/* Styled by aria-checked, not data-state: the tooltip trigger overwrites data-state. */}
      {items.map((item) => (
        <Tooltip key={item.value} content={item.label}>
          <RadixToggleGroup.Item
            value={item.value}
            aria-label={item.label}
            className="inline-flex h-7 w-8 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg aria-checked:bg-selected aria-checked:text-fg [&_svg]:size-4"
          >
            {item.icon}
          </RadixToggleGroup.Item>
        </Tooltip>
      ))}
    </RadixToggleGroup.Root>
  );
}
