import { Check, ChevronDown } from 'lucide-react';
import { Select as RadixSelect, VisuallyHidden } from 'radix-ui';
import { useId } from 'react';
import { cn } from './cn.ts';
import { CONTROL_CLASS } from './input.tsx';

/**
 * A labelled single-choice list on Radix Select (keyboard, typeahead, screen
 * readers). An option's `detail` shows after its label in the list only: the
 * closed select shows the label alone.
 */
export function Select({
  label,
  value,
  onValueChange,
  options,
  disabled = false,
  hideLabel = false,
  inline = false,
}: {
  label: string;
  value: string;
  onValueChange(value: string): void;
  options: { value: string; label: string; detail?: string }[];
  disabled?: boolean;
  /** Keeps the label for screen readers only, for selects whose purpose is clear in context. */
  hideLabel?: boolean;
  /** A compact select with its label beside it, for toolbars. */
  inline?: boolean;
}) {
  const id = useId();
  const labelElement = (
    <label
      htmlFor={id}
      className={inline ? 'shrink-0 text-fg-muted text-sm' : 'font-medium text-fg text-sm'}
    >
      {label}
    </label>
  );

  return (
    <div className={inline ? 'flex min-w-0 items-center gap-2' : 'flex flex-col gap-1.5'}>
      {hideLabel ? <VisuallyHidden.Root>{labelElement}</VisuallyHidden.Root> : labelElement}
      <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
        <RadixSelect.Trigger
          id={id}
          className={cn(
            CONTROL_CLASS,
            'inline-flex h-9 cursor-pointer items-center justify-between gap-2 text-left data-placeholder:text-fg-subtle',
            inline && 'h-8 w-auto gap-1.5 px-2.5 text-sm',
          )}
        >
          <span className="truncate">
            <RadixSelect.Value />
          </span>
          <RadixSelect.Icon className="shrink-0 text-fg-muted">
            <ChevronDown aria-hidden="true" className="size-4" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-popover data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in"
          >
            <RadixSelect.Viewport className="p-1">
              {options.map((option) => (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  className="relative flex h-9 cursor-pointer select-none items-center rounded-md pr-9 pl-2.5 text-base outline-offset-[-2px] data-disabled:cursor-not-allowed data-highlighted:bg-surface-muted data-disabled:opacity-50"
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  {option.detail ? (
                    <span className="ml-2 text-fg-muted text-sm">{option.detail}</span>
                  ) : null}
                  <RadixSelect.ItemIndicator className="absolute right-2.5 inline-flex text-fg">
                    <Check aria-hidden="true" className="size-4" />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
}
