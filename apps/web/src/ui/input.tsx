import type { InputHTMLAttributes, Ref } from 'react';
import { cn } from './cn.ts';

/**
 * Shared look of text controls. The focus ring sits on the border (offset -1px)
 * so it reads as one crisp 2px edge; invalid fields turn it red. Touch screens
 * get 16px text so iOS does not zoom the page on focus.
 */
export const CONTROL_CLASS =
  'block w-full min-w-0 rounded-md border border-border-strong bg-transparent px-3 text-base text-fg transition-[border-color] placeholder:text-fg-subtle hover:border-fg-subtle focus-visible:outline-offset-[-1px] aria-invalid:border-danger aria-invalid:focus-visible:outline-danger disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60 disabled:hover:border-border-strong pointer-coarse:text-[1rem]';

/** Read-only text reads as not editable. Only for text fields: buttons match :read-only too. */
export const TEXT_ENTRY_CLASS = 'read-only:bg-surface-muted';

export function Input({
  className,
  type = 'text',
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(CONTROL_CLASS, TEXT_ENTRY_CLASS, 'h-9', className)}
      {...props}
    />
  );
}
