import { DropdownMenu, Slot } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.ts';
import { ariaKeyShortcuts, formatShortcut } from './kbd.tsx';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

/** The menu panel, portalled, 6px from its trigger and kept 8px inside the viewport. */
export function MenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={collisionPadding}
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-48 max-w-[calc(100vw-1rem)] origin-(--radix-dropdown-menu-content-transform-origin) overflow-y-auto rounded-lg border border-border bg-surface p-1 text-fg shadow-popover outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in',
          className,
        )}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

/**
 * One action. A keyboard user sees the accent focus ring on the highlighted
 * item; a pointer user sees only the soft fill. `tone="danger"` is for
 * destructive actions and is best placed last, after a MenuSeparator.
 */
export function MenuItem({
  icon,
  shortcut,
  tone,
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.Item> & {
  icon?: ReactNode;
  /** Keys shown at the end of the row, e.g. ['mod', 'backspace']. */
  shortcut?: string[];
  tone?: 'danger';
}) {
  return (
    <DropdownMenu.Item
      aria-keyshortcuts={shortcut ? ariaKeyShortcuts(shortcut) : undefined}
      className={cn(
        'flex h-9 cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 text-base outline-offset-[-2px] data-disabled:cursor-not-allowed data-highlighted:bg-surface-muted data-disabled:opacity-50',
        tone === 'danger' && 'text-danger data-highlighted:bg-danger-soft',
        className,
      )}
      {...props}
    >
      {/* Slottable keeps the icon and shortcut when the item renders a link (asChild). */}
      <Slot.Slottable child={children}>
        {(child) => (
          <>
            {icon ? (
              <span
                aria-hidden="true"
                className={cn(
                  'inline-flex shrink-0 [&_svg]:size-4',
                  tone === 'danger' ? 'text-danger' : 'text-fg-muted',
                )}
              >
                {icon}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{child}</span>
            {shortcut ? (
              <span aria-hidden="true" className="ml-4 shrink-0 text-fg-muted text-sm">
                {formatShortcut(shortcut)}
              </span>
            ) : null}
          </>
        )}
      </Slot.Slottable>
    </DropdownMenu.Item>
  );
}

export function MenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.Separator>) {
  return (
    <DropdownMenu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />
  );
}

/** A quiet heading for a group of items (not interactive). */
export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      className={cn('truncate px-2.5 pt-2 pb-1 font-medium text-fg-muted text-xs', className)}
      {...props}
    />
  );
}
