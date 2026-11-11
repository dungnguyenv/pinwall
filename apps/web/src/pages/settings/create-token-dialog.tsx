import { useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createToken, DEFAULT_TOKEN_EXPIRY, TOKEN_EXPIRY_CHOICES } from '../../api/account.ts';
import { errorMessage } from '../../api/client.ts';
import { type CreatedApiToken, Label } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { Button, CopyField, Dialog, Field, Input, Select } from '../../ui/index.ts';
import { FormAlert } from '../auth/auth-layout.tsx';

const MAX_NAME = 100;
/** A Select's values are text; `null` (never expires) has none of its own. */
const NEVER = 'never';

const expiryValue = (days: number | null) => (days === null ? NEVER : String(days));
/** The label of each choice, by its value; spelled out so every key can be found by search. */
const EXPIRY_LABELS: Record<string, string> = {
  '30': 'web.tokens.expiry30',
  '90': 'web.tokens.expiry90',
  '365': 'web.tokens.expiry365',
  [NEVER]: 'web.tokens.expiryNever',
};

/**
 * Creates an API token in two steps. The form asks for a name and how long
 * the token lasts. The result step shows the secret, the only time anything
 * does: it lives in this component's state alone, never in a query or
 * mutation cache, and is dropped as soon as the dialog has closed.
 */
export function CreateTokenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const formId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const secretBox = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState(expiryValue(DEFAULT_TOKEN_EXPIRY));
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  // Set at once, unlike `pending`, so a second Enter cannot create a second token.
  const busy = useRef(false);

  // Each opening starts from a blank form.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName('');
      setExpiry(expiryValue(DEFAULT_TOKEN_EXPIRY));
      setNameError(null);
      setFormError(null);
      setCreated(null);
    }
  }

  // With the secret on screen, focus it selected, so copying is one keystroke away.
  // Selecting scrolls a long token to its end; show the start, where "pw_" is.
  useEffect(() => {
    const field = created ? secretBox.current?.querySelector('input') : null;
    if (!field) return;
    field.focus();
    field.scrollLeft = 0;
  }, [created]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    const parsed = Label.safeParse(name);
    if (!parsed.success) {
      setNameError(t('web.tokens.nameRequired'));
      nameInput.current?.focus();
      return;
    }
    busy.current = true;
    setPending(true);
    setFormError(null);
    try {
      const days = expiry === NEVER ? null : Number(expiry);
      setCreated(await createToken({ name: parsed.data, expires_in_days: days }));
      void queryClient.invalidateQueries({ queryKey: qk.tokens });
    } catch (error) {
      setFormError(errorMessage(error, t));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  // While the request runs, closing would leave a token nobody holds the secret of; once the
  // secret shows, closing drops it for good. Both wait for the button made for it: Done.
  const locked = pending || created !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!locked}
      title={t(created ? 'web.tokens.createdTitle' : 'web.tokens.createTitle')}
      description={
        created
          ? t('web.tokens.createdBody', { name: created.token.name })
          : t('web.tokens.createHint')
      }
      // The dialog has finished closing: only now may the secret go, or its text
      // would blank out while the dialog fades.
      onCloseAutoFocus={() => setCreated(null)}
      footer={
        created ? (
          <Button onClick={() => onOpenChange(false)}>{t('web.tokens.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
              {t('web.common.cancel')}
            </Button>
            <Button type="submit" form={formId} loading={pending}>
              {t('web.tokens.create')}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-4">
          <p className="flex items-start gap-2.5 rounded-lg bg-warning-soft px-3.5 py-3 text-fg text-sm">
            <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-warning" />
            <span>{t('web.tokens.secretOnce')}</span>
          </p>
          <div ref={secretBox}>
            <CopyField label={t('web.tokens.secret')} value={created.secret} mono />
          </div>
        </div>
      ) : (
        <form
          id={formId}
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-5"
        >
          <Field label={t('web.tokens.name')} error={nameError}>
            {(control) => (
              <Input
                {...control}
                ref={nameInput}
                autoComplete="off"
                maxLength={MAX_NAME}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
              />
            )}
          </Field>
          <Select
            label={t('web.tokens.expiry')}
            value={expiry}
            onValueChange={setExpiry}
            options={TOKEN_EXPIRY_CHOICES.map((days) => ({
              value: expiryValue(days),
              label: t(EXPIRY_LABELS[expiryValue(days)] ?? 'web.tokens.expiryNever'),
            }))}
          />
          {formError ? <FormAlert>{formError}</FormAlert> : null}
        </form>
      )}
    </Dialog>
  );
}
