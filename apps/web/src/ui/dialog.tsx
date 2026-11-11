import { X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import { type ReactNode, type RefObject, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from './cn.ts';
import { IconButton } from './icon-button.tsx';

export type DialogSize = 'sm' | 'md' | 'lg';

/*
 * Shared by Dialog and ConfirmDialog. The overlay is also the layout box: it
 * centers the panel from 640px up and docks it to the bottom edge, full width,
 * below that. The panel scrolls inside itself, never the page.
 */
export const OVERLAY_CLASS =
  'fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-overlay p-4 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in max-sm:items-end max-sm:justify-items-stretch max-sm:p-0';

const PANEL_SIZES: Record<DialogSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
};

export function panelClass(size: DialogSize) {
  return cn(
    'relative flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-xl border border-border bg-surface text-fg shadow-dialog outline-none',
    'data-[state=closed]:animate-dialog-out data-[state=open]:animate-dialog-in',
    'max-sm:max-h-[90dvh] max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom)] max-sm:data-[state=closed]:animate-sheet-out max-sm:data-[state=open]:animate-sheet-in',
    PANEL_SIZES[size],
  );
}

export const FOOTER_CLASS =
  'flex shrink-0 flex-col-reverse gap-2 px-6 pt-2 pb-6 max-sm:px-5 max-sm:pb-5 max-sm:[&>*]:w-full sm:flex-row sm:items-center sm:justify-end';

/**
 * Returns focus to whatever had it when the dialog opened. Radix only does this
 * for its own Trigger, and Pinwall's dialogs are controlled, so they open from
 * any button, menu item or shortcut.
 */
export function useReturnFocus() {
  const returnTo = useRef<HTMLElement | null>(null);
  const onOpenAutoFocus = useCallback(() => {
    // Radix calls this before moving focus in, so activeElement is still the opener.
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  const onCloseAutoFocus = useCallback((event: Event) => {
    const target = returnTo.current;
    returnTo.current = null;
    // Someone already decided where focus goes (a page the dialog navigated to).
    if (event.defaultPrevented) return;
    if (target?.isConnected) {
      event.preventDefault();
      target.focus({ preventScroll: true });
    }
  }, []);
  return { onOpenAutoFocus, onCloseAutoFocus };
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  footer,
  children,
  dismissible = true,
  initialFocus,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  size?: DialogSize;
  footer?: ReactNode;
  children?: ReactNode;
  /**
   * `false` keeps the dialog open on Escape and on a click beside it, so only
   * its own buttons close it. For steps whose content is lost once closed,
   * such as a secret shown once.
   */
  dismissible?: boolean;
  /**
   * The element to focus when the dialog opens, instead of the first one in
   * it. For a dialog whose safest choice is not its first button.
   */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Runs as the dialog closes, before focus goes back to the opener. Calling
   * `event.preventDefault()` leaves focus alone, e.g. when the dialog opened a
   * new page that focuses its own heading.
   */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY_CLASS}>
          <RadixDialog.Content
            className={panelClass(size)}
            onOpenAutoFocus={(event) => {
              returnFocus.onOpenAutoFocus();
              const first = initialFocus?.current;
              if (!first) return;
              event.preventDefault();
              first.focus();
            }}
            onEscapeKeyDown={(event) => {
              if (!dismissible) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (!dismissible) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              onCloseAutoFocus?.(event);
              returnFocus.onCloseAutoFocus(event);
            }}
            // Without a description Radix expects the attribute to be cleared explicitly.
            {...(description ? {} : { 'aria-describedby': undefined })}
          >
            <div className="shrink-0 px-6 pt-5 pr-14 pb-3 max-sm:px-5 max-sm:pr-14">
              <RadixDialog.Title className="font-semibold text-fg text-lg">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description asChild>
                  <div className="mt-1 text-base text-fg-muted">{description}</div>
                </RadixDialog.Description>
              ) : null}
            </div>
            {children ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-1 pb-5 max-sm:px-5">
                {children}
              </div>
            ) : null}
            {footer ? <div className={FOOTER_CLASS}>{footer}</div> : null}
            {/* Last in the DOM so opening focuses the content, not the close button. */}
            <RadixDialog.Close asChild>
              <IconButton
                label={t('web.common.close')}
                icon={<X />}
                size="sm"
                tooltip={false}
                className="absolute top-4 right-4 text-fg-muted hover:text-fg"
              />
            </RadixDialog.Close>
          </RadixDialog.Content>
        </RadixDialog.Overlay>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
