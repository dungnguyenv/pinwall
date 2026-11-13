import { CircleAlert } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './button.tsx';
import { FOOTER_CLASS, OVERLAY_CLASS, panelClass, useReturnFocus } from './dialog.tsx';

/**
 * Asks before an action. Confirm awaits `onConfirm` with the button busy and
 * closes on success; a rejection keeps the dialog open and shows why. While the
 * action runs, Cancel and Escape are held so the outcome is never hidden.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  tone = 'default',
  children,
  confirmDisabled = false,
  onConfirm,
  errorMessage,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  /** Controls under the body, such as a field the person must fill in before Confirm works. */
  children?: ReactNode;
  /** Holds Confirm back; a running action still shows it busy. */
  confirmDisabled?: boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: a sync handler may return nothing
  onConfirm(): Promise<unknown> | void;
  /** Turns a rejection into text. Defaults to the error's message. */
  errorMessage?(error: unknown): string;
}) {
  const { t } = useTranslation();
  const returnFocus = useReturnFocus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: a double click lands before React re-renders the button as disabled.
  const running = useRef(false);
  const confirmButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  // The busy button was disabled, which drops focus to <body>; after a failure,
  // put it back on Confirm so a keyboard user can retry or Tab to Cancel.
  useEffect(() => {
    if (error && !busy) confirmButton.current?.focus();
  }, [error, busy]);

  async function confirm() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function describe(caught: unknown): string {
    if (errorMessage) return errorMessage(caught);
    if (caught instanceof Error && caught.message) return caught.message;
    return t('web.common.error');
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={OVERLAY_CLASS}>
          <AlertDialog.Content
            className={panelClass('sm')}
            {...returnFocus}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
          >
            <div className="px-6 pt-6 pb-4 max-sm:px-5">
              <AlertDialog.Title className="font-semibold text-fg text-lg">
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description asChild>
                <div className="mt-2 text-base text-fg-muted">{body}</div>
              </AlertDialog.Description>
              {children ? <div className="mt-4">{children}</div> : null}
              {error ? (
                <p
                  role="alert"
                  className="mt-4 flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-danger text-sm"
                >
                  <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                  <span>{error}</span>
                </p>
              ) : null}
            </div>
            <div className={FOOTER_CLASS}>
              <AlertDialog.Cancel asChild>
                <Button variant="secondary" disabled={busy}>
                  {t('web.common.cancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                ref={confirmButton}
                variant={tone === 'danger' ? 'danger' : 'primary'}
                loading={busy}
                disabled={confirmDisabled}
                onClick={(event) => {
                  // The second click of a double click is the same intent, not a retry.
                  if (event.detail > 1) return;
                  void confirm();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Overlay>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
