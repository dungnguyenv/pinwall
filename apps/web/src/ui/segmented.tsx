import { ToggleGroup as RadixToggleGroup } from 'radix-ui';
import { useTranslation } from 'react-i18next';

/**
 * A row of text choices of which exactly one is on, such as a list filter.
 * Pressing the active item again does nothing. An item with a `count` shows it
 * after its label and is named "Label (n)". Arrow keys move between items.
 */
export function Segmented<T extends string>({
  label,
  value,
  onValueChange,
  items,
}: {
  label: string;
  value: T;
  onValueChange(value: T): void;
  items: { value: T; label: string; count?: number }[];
}) {
  const { t } = useTranslation();
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
      className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-border p-0.5"
    >
      {items.map((item) => (
        <RadixToggleGroup.Item
          key={item.value}
          value={item.value}
          aria-label={
            item.count === undefined
              ? undefined
              : t('web.common.labelCount', { label: item.label, count: item.count })
          }
          className="group inline-flex h-7 min-w-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full px-3 font-medium text-fg-muted text-sm transition-colors duration-(--duration-fast) hover:bg-surface-muted hover:text-fg aria-checked:bg-selected aria-checked:text-fg"
        >
          {item.label}
          {item.count === undefined ? null : (
            <span className="text-fg-muted text-xs tabular-nums group-aria-checked:text-fg">
              {item.count}
            </span>
          )}
        </RadixToggleGroup.Item>
      ))}
    </RadixToggleGroup.Root>
  );
}
