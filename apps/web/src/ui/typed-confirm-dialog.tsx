import { type ReactNode, useEffect, useState } from 'react';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { Field } from './field.tsx';
import { Input } from './input.tsx';

/** Trimmed and lower-cased, so the match ignores spaces around the text and its letter case. */
const normalized = (text: string) => text.trim().toLowerCase();

/**
 * A `ConfirmDialog` (tone danger) for what cannot be undone: Confirm stays
 * disabled until the person has typed `expected`, so the action is never one
 * click away. Typing is compared trimmed and ignoring case; the server still
 * judges what is sent. The field starts empty each time the dialog opens.
 */
export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  expected,
  fieldLabel,
  onConfirm,
  errorMessage,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Compared trimmed and ignoring case; Confirm stays disabled until it matches. */
  expected: string;
  fieldLabel: string;
  /** Receives the typed text, trimmed. */
  onConfirm(typed: string): Promise<unknown>;
  /** Turns a rejection into text. Defaults to the error's message. */
  errorMessage?(error: unknown): string;
}) {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      body={body}
      confirmLabel={confirmLabel}
      tone="danger"
      confirmDisabled={normalized(typed) !== normalized(expected)}
      onConfirm={() => onConfirm(typed.trim())}
      errorMessage={errorMessage}
    >
      <Field label={fieldLabel}>
        {(control) => (
          <Input
            {...control}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        )}
      </Field>
    </ConfirmDialog>
  );
}
