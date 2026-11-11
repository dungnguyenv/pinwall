import { useState } from 'react';

/**
 * Which row a dialog is about, and whether it is open. The row stays after
 * the dialog closes, so its text does not change while the dialog fades out.
 */
export function useRowDialog<T>(): {
  item: T | null;
  open: boolean;
  show(item: T): void;
  onOpenChange(open: boolean): void;
} {
  const [state, setState] = useState<{ item: T; open: boolean } | null>(null);
  return {
    item: state?.item ?? null,
    open: state?.open ?? false,
    show: (item) => setState({ item, open: true }),
    onOpenChange: (open) => setState((current) => (current ? { ...current, open } : current)),
  };
}
