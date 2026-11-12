import { Switch as RadixSwitch } from 'radix-ui';
import { type ReactNode, useId } from 'react';

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
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="font-medium text-fg text-sm">
          {label}
        </label>
        {description ? (
          <div id={descriptionId} className="mt-0.5 text-fg-muted text-sm">
            {description}
          </div>
        ) : null}
      </div>
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
    </div>
  );
}
