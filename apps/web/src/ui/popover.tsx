import { Popover as RadixPopover } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;

/**
 * A small panel of controls beside its trigger, such as a field with its
 * button: portalled, 6px from the trigger and kept 8px inside the viewport,
 * with the look of a menu. Escape and a click outside close it, and focus
 * goes back to the trigger.
 */
export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 w-72 max-w-[calc(100vw-1rem)] origin-(--radix-popover-content-transform-origin) rounded-lg border border-border bg-surface p-3 text-fg shadow-popover outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
          className,
        )}
        {...props}
      />
    </RadixPopover.Portal>
  );
}
