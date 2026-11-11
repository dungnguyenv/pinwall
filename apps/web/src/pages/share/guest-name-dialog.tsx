import { type FormEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuestName } from '../../api/dto.ts';
import { Button, Dialog, Field, Input } from '../../ui/index.ts';

/** The longest name the server accepts for a guest. */
const GUEST_NAME_MAX = 60;

/**
 * Asks a share-link guest for the name their comments show, before the first
 * one, or to change it (`change`). What is typed stays in the field; the name
 * is handed on only when it is sent with Save, trimmed, and only when the
 * server would take it (1 to 60 characters, no control characters). Closing
 * the dialog any other way cancels.
 *
 * `returnFocus` false leaves focus, after a save, to whatever the save opened
 * (a composer) rather than to the control that opened the dialog.
 */
export function GuestNameDialog({
  open,
  change,
  initial,
  onSave,
  onCancel,
  returnFocus = true,
}: {
  open: boolean;
  change: boolean;
  initial: string;
  onSave(name: string): void;
  onCancel(): void;
  returnFocus?: boolean;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const saved = useRef(false);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the name as it is now.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setText(initial);
      setError(null);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = GuestName.safeParse(text);
    if (!parsed.success) {
      setError(t(text.trim() === '' ? 'web.guest.nameRequired' : 'web.guest.nameInvalid'));
      input.current?.focus();
      return;
    }
    saved.current = true;
    onSave(parsed.data);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      size="sm"
      title={t(change ? 'web.guest.changeTitle' : 'web.guest.addTitle')}
      onCloseAutoFocus={(event) => {
        if (saved.current && !returnFocus) event.preventDefault();
        saved.current = false;
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t('web.common.cancel')}
          </Button>
          <Button type="submit" form={formId}>
            {t('web.common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit}>
        <Field label={t('web.guest.name')} description={t('web.guest.nameHint')} error={error}>
          {(control) => (
            <Input
              {...control}
              ref={input}
              value={text}
              maxLength={GUEST_NAME_MAX}
              autoComplete="name"
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
