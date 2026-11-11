import { Slot } from 'radix-ui';
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from './cn.ts';
import { Spinner } from './spinner.tsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button, marks it aria-busy and shows a spinner in place of the leading icon. */
  loading?: boolean;
  /** Renders the single child element (a link, say) with the button's look. `loading` does not apply. */
  asChild?: boolean;
  leadingIcon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

// Press feedback is a small scale-down, dropped for people who reduce motion.
const BASE =
  'relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-full font-medium transition-[background-color,border-color,color,scale] duration-(--duration-fast) ease-out active:scale-[0.97] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 [&_svg]:shrink-0';

// aria-expanded keeps a menu's trigger looking pressed while its menu is open.
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary/85 disabled:hover:bg-primary',
  secondary:
    'border border-border-strong bg-surface text-fg hover:bg-surface-muted active:bg-selected aria-expanded:bg-surface-muted disabled:hover:bg-surface',
  ghost:
    'text-fg hover:bg-surface-muted active:bg-selected aria-expanded:bg-selected disabled:hover:bg-transparent',
  danger: 'bg-danger text-danger-fg hover:bg-danger/88 disabled:hover:bg-danger',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-sm [&_svg]:size-4',
  md: 'h-9 gap-2 px-4 text-base [&_svg]:size-4',
  lg: 'h-11 gap-2 px-5 text-md [&_svg]:size-5',
};

function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md') {
  return cn(BASE, VARIANTS[variant], SIZES[size]);
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  asChild = false,
  leadingIcon,
  className,
  disabled,
  type,
  children,
  ref,
  ...props
}: ButtonProps) {
  const { t } = useTranslation();
  const classes = cn(buttonClass(variant, size), className);

  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...props}>
        <Slot.Slottable child={children}>
          {(child) => (
            <>
              {leadingIcon}
              {child}
            </>
          )}
        </Slot.Slottable>
      </Slot.Root>
    );
  }

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner label={t('web.common.loading')} /> : leadingIcon}
      {children}
    </button>
  );
}
