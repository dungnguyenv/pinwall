import { type Ref, type TextareaHTMLAttributes, useCallback, useLayoutEffect, useRef } from 'react';
import { cn } from './cn.ts';
import { CONTROL_CLASS, TEXT_ENTRY_CLASS } from './input.tsx';

export function Textarea({
  autosize = false,
  className,
  onInput,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  /** Grows with its content up to max-h-80, then scrolls. */
  autosize?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const inner = useRef<HTMLTextAreaElement | null>(null);

  const fitToContent = useCallback(() => {
    const element = inner.current;
    if (!autosize || !element) return;
    element.style.height = 'auto';
    // scrollHeight leaves out the borders; border-box sizing needs them back.
    const borders = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + borders}px`;
  }, [autosize]);

  // Re-fit when a controlled value changes from outside (a reset, a draft restore).
  // biome-ignore lint/correctness/useExhaustiveDependencies: props.value is the trigger
  useLayoutEffect(fitToContent, [fitToContent, props.value]);

  const setRefs = useCallback(
    (element: HTMLTextAreaElement | null) => {
      inner.current = element;
      if (typeof ref === 'function') ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );

  return (
    <textarea
      ref={setRefs}
      className={cn(
        CONTROL_CLASS,
        TEXT_ENTRY_CLASS,
        'min-h-20 resize-y py-2',
        autosize && 'max-h-80 resize-none overflow-y-auto',
        className,
      )}
      onInput={(event) => {
        fitToContent();
        onInput?.(event);
      }}
      {...props}
    />
  );
}
