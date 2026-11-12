import { X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useReturnFocus } from '../../ui/dialog.tsx';
import { IconButton } from '../../ui/icon-button.tsx';

/**
 * The comment panel on a phone: a sheet that rises from the bottom edge, up to
 * 85% of the screen, with its title and a close button. `children` (the
 * panel) fills it and scrolls inside it.
 */
export function CommentSheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <RadixDialog.Content
          {...returnFocus}
          // Without a description Radix expects the attribute to be cleared explicitly.
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // Escape in a box holding text belongs to that box: it never hides unsent words.
            const active = document.activeElement;
            const typed =
              (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
              active.value.trim() !== '';
            if (typed) event.preventDefault();
          }}
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-xl border-border border-t bg-canvas pb-[env(safe-area-inset-bottom)] text-fg shadow-dialog outline-none data-[state=closed]:animate-sheet-out data-[state=open]:animate-sheet-in"
        >
          <div
            aria-hidden="true"
            className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border"
          />
          <RadixDialog.Title className="shrink-0 px-4 pt-1.5 pr-14 font-semibold text-fg text-md">
            {title}
          </RadixDialog.Title>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          {/* Last, so opening the sheet focuses its content rather than Close. */}
          <RadixDialog.Close asChild>
            <IconButton
              label={t('web.comments.close')}
              icon={<X />}
              size="sm"
              tooltip={false}
              className="absolute top-3.5 right-3 text-fg-muted hover:text-fg"
            />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
