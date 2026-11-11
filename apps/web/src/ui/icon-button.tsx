import type { ReactNode } from 'react';
import { Button, type ButtonProps, type ButtonSize } from './button.tsx';
import { cn } from './cn.ts';
import { ariaKeyShortcuts, Kbd } from './kbd.tsx';
import { Tooltip } from './tooltip.tsx';

// `asChild` is left out: the icon is the button's only child, so there is no
// element to slot into.
export type IconButtonProps = Omit<ButtonProps, 'children' | 'leadingIcon' | 'asChild'> & {
  /** The accessible name, also shown as the tooltip. */
  label: string;
  icon: ReactNode;
  /** Keys shown in the tooltip and exposed as aria-keyshortcuts, e.g. ['mod', 'k']. */
  shortcut?: string[];
  /** Set to false where a tooltip would only get in the way (a dialog's close button). */
  tooltip?: boolean;
};

const SQUARE: Record<ButtonSize, string> = {
  sm: 'size-8 px-0 [&_svg]:size-4',
  md: 'size-9 px-0 [&_svg]:size-4.5',
  lg: 'size-11 px-0 [&_svg]:size-5',
};

/** A square, icon-only button. Its label is the accessible name and the tooltip. */
export function IconButton({
  label,
  icon,
  shortcut,
  tooltip = true,
  variant = 'ghost',
  size = 'md',
  loading,
  className,
  ...props
}: IconButtonProps) {
  const button = (
    <Button
      variant={variant}
      size={size}
      aria-label={label}
      aria-keyshortcuts={shortcut ? ariaKeyShortcuts(shortcut) : undefined}
      loading={loading}
      className={cn(SQUARE[size], className)}
      {...props}
    >
      {/* While loading, the button's spinner takes the icon's place. */}
      {loading ? null : icon}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip
      content={
        <>
          <span>{label}</span>
          {shortcut ? <Kbd keys={shortcut} /> : null}
        </>
      }
    >
      {button}
    </Tooltip>
  );
}
