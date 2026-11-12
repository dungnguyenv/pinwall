import { ToggleGroup as RadixToggleGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { ariaKeyShortcuts, Kbd } from './kbd.tsx';
import { Tooltip } from './tooltip.tsx';

/**
 * A segmented control of icon-only choices (Grid / List). Exactly one item is
 * on, unless `value` names none of them; pressing the active item again does
 * nothing. Each item is a radio named by its label, which also shows as a
 * tooltip, followed by its `detail` (such as a size) and its `shortcut` keys.
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
  items: { value: T; label: string; icon: ReactNode; detail?: string; shortcut?: string[] }[];
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
        <Tooltip
          key={item.value}
          content={
            <>
              <span>{item.label}</span>
              {item.detail ? <span className="font-normal opacity-75">{item.detail}</span> : null}
              {item.shortcut ? <Kbd keys={item.shortcut} /> : null}
            </>
          }
        >
          <RadixToggleGroup.Item
            value={item.value}
            aria-label={item.label}
            aria-keyshortcuts={item.shortcut ? ariaKeyShortcuts(item.shortcut) : undefined}
            className="inline-flex h-7 w-8 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg aria-checked:bg-selected aria-checked:text-fg [&_svg]:size-4"
          >
            {item.icon}
          </RadixToggleGroup.Item>
        </Tooltip>
      ))}
    </RadixToggleGroup.Root>
  );
}
