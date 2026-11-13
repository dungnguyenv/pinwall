import { Switch as RadixSwitch, VisuallyHidden } from 'radix-ui';
import { type ReactNode, useId } from 'react';
import { cn } from './cn.ts';

/**
 * A labelled on/off setting with an optional line saying what on means, on
 * Radix Switch (Space toggles; screen readers hear "switch, on"). The label is
 * also a click target. The track takes the accent when on; the thumb takes the
 * canvas color, so it stands out from the track in both themes.
 */
export function Switch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  hideLabel = false,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
  /** Keeps the label for screen readers only, for switches whose purpose is clear in context, such as a table cell. The description stays, under the switch. */
  hideLabel?: boolean;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const labelElement = (
    <label htmlFor={id} className="font-medium text-fg text-sm">
      {label}
    </label>
  );
  const descriptionElement = description ? (
    <div id={descriptionId} className={cn('text-fg-muted text-sm', !hideLabel && 'mt-0.5')}>
      {description}
    </div>
  ) : null;
  const control = (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-describedby={description ? descriptionId : undefined}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-border-strong transition-colors duration-(--duration-fast) before:absolute before:-inset-2 before:content-[''] data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <RadixSwitch.Thumb className="pointer-events-none block size-4 translate-x-0.5 rounded-full bg-canvas shadow-card transition-transform duration-(--duration-fast) data-[state=checked]:translate-x-[1.125rem]" />
    </RadixSwitch.Root>
  );

  if (hideLabel) {
    return (
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <VisuallyHidden.Root>{labelElement}</VisuallyHidden.Root>
        {control}
        {descriptionElement}
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        {labelElement}
        {descriptionElement}
      </div>
      {control}
    </div>
  );
}
