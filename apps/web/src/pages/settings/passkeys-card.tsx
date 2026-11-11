import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addPasskey,
  addPasskeyOptions,
  useDeletePasskey,
  usePasskeys,
  useRefreshCredentials,
  useRenamePasskey,
} from '../../api/account.ts';
import { errorMessage } from '../../api/client.ts';
import { Label, type Passkey } from '../../api/dto.ts';
import { usePublicConfig } from '../../api/session.ts';
import { formatDate, formatRelativeTime } from '../../lib/format.ts';
import { createPasskey, passkeyErrorMessage, passkeysUsable } from '../../lib/webauthn.ts';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingRegion,
  Skeleton,
  toast,
} from '../../ui/index.ts';
import { FormAlert } from '../auth/auth-layout.tsx';
import { CardBody, CardRows, Facts, SettingsCard } from './settings-card.tsx';
import { useRowDialog } from './use-row-dialog.ts';

const MAX_NAME = 100;

/** The owner's passkeys: what they are called, when they were added and last used, and how to manage them. */
export function PasskeysCard() {
  const { t } = useTranslation();
  const passkeys = usePasskeys();
  const config = usePublicConfig();
  const deletePasskey = useDeletePasskey();
  const [adding, setAdding] = useState(false);
  const rename = useRowDialog<Passkey>();
  const remove = useRowDialog<Passkey>();
  const reasonId = useId();

  // Passkeys need the server's origin to allow them and a browser that has WebAuthn.
  const usable = config.data ? passkeysUsable(config.data) : false;
  const reason =
    !config.data || usable
      ? null
      : t(
          config.data.passkeys_available
            ? 'web.security.passkeysBrowser'
            : 'auth.passkeysUnavailable',
        );

  return (
    <SettingsCard
      title={t('web.security.passkeys')}
      description={
        <>
          {t('web.security.passkeysHint')}
          {reason ? (
            <span id={reasonId} className="mt-2 block text-sm">
              {reason}
            </span>
          ) : null}
        </>
      }
      actions={
        <Button
          variant="secondary"
          leadingIcon={<Plus />}
          disabled={!usable}
          aria-describedby={reason ? reasonId : undefined}
          onClick={() => setAdding(true)}
        >
          {t('web.security.passkeyAdd')}
        </Button>
      }
    >
      {passkeys.isPending ? (
        <div className="border-border border-t">
          <LoadingRegion label={t('web.security.passkeysLoading')}>
            <div className="flex flex-col gap-5 px-4 py-5 sm:px-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </LoadingRegion>
        </div>
      ) : passkeys.isError ? (
        <CardBody>
          <ErrorState
            compact
            message={errorMessage(passkeys.error, t)}
            onRetry={() => void passkeys.refetch()}
          />
        </CardBody>
      ) : passkeys.data.items.length === 0 ? (
        <div className="border-border border-t">
          <EmptyState
            icon={<KeyRound />}
            title={t('web.security.passkeysEmpty')}
            description={t('web.security.passkeysEmptyHint')}
          />
        </div>
      ) : (
        <CardRows label={t('web.security.passkeysLabel')}>
          {passkeys.data.items.map((passkey) => (
            <li key={passkey.id} className="flex items-center gap-3 px-4 py-4 sm:px-5">
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-muted text-fg-muted [&_svg]:size-4"
              >
                <KeyRound />
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium text-base text-fg">{passkey.name}</p>
                <Facts
                  items={[
                    {
                      label: t('web.security.passkeyAddedOn'),
                      value: formatDate(passkey.created_at),
                    },
                    {
                      label: t('web.security.passkeyLastUsed'),
                      value: passkey.last_used_at
                        ? formatRelativeTime(passkey.last_used_at)
                        : t('web.security.passkeyNeverUsed'),
                    },
                  ]}
                />
              </div>
              <div className="flex shrink-0 gap-0.5">
                <IconButton
                  label={t('web.security.passkeyRename', { name: passkey.name })}
                  icon={<Pencil />}
                  size="sm"
                  onClick={() => rename.show(passkey)}
                />
                <IconButton
                  label={t('web.security.passkeyDelete', { name: passkey.name })}
                  icon={<Trash2 />}
                  size="sm"
                  onClick={() => remove.show(passkey)}
                />
              </div>
            </li>
          ))}
        </CardRows>
      )}

      <AddPasskeyDialog open={adding} onOpenChange={setAdding} />
      {rename.item ? (
        <RenamePasskeyDialog
          key={rename.item.id}
          passkey={rename.item}
          open={rename.open}
          onOpenChange={rename.onOpenChange}
        />
      ) : null}
      <ConfirmDialog
        open={remove.open}
        onOpenChange={remove.onOpenChange}
        title={t('web.security.passkeyDeleteTitle')}
        body={t('web.security.passkeyDeleteBody', { name: remove.item?.name ?? '' })}
        confirmLabel={t('web.security.passkeyDeleteConfirm')}
        tone="danger"
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          if (!remove.item) return;
          await deletePasskey.mutateAsync(remove.item.id);
          toast.success(t('web.security.passkeyDeleted'));
        }}
      />
    </SettingsCard>
  );
}

/**
 * Asks for a name, then runs the passkey ceremony: the server's options, the
 * browser's prompt, and the server again with the result. A closed prompt
 * leaves the dialog open so the person can try again.
 */
function AddPasskeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const refresh = useRefreshCredentials();
  const formId = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set at once, unlike `pending`, so a second Enter cannot start a second ceremony.
  const busy = useRef(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName('');
      setError(null);
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const ceremony = await addPasskeyOptions();
      const response = await createPasskey(ceremony.options);
      const label = name.trim();
      await addPasskey({
        ceremony_id: ceremony.ceremony_id,
        response,
        ...(label === '' ? {} : { name: label }),
      });
      await refresh();
      toast.success(t('web.security.passkeyAdded'));
      onOpenChange(false);
    } catch (caught) {
      setError(passkeyErrorMessage(caught, t, 'create'));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('web.security.passkeyAdd')}
      description={t('web.security.passkeyAddHint')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('web.common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {t('web.security.passkeyContinue')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
      >
        <Field
          label={t('web.security.passkeyName')}
          description={t('web.security.passkeyNameHint')}
          optional
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              maxLength={MAX_NAME}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        {error ? <FormAlert>{error}</FormAlert> : null}
      </form>
    </Dialog>
  );
}

function RenamePasskeyDialog({
  passkey,
  open,
  onOpenChange,
}: {
  passkey: Passkey;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const rename = useRenamePasskey();
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(passkey.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(passkey.name);
      setNameError(null);
      setFormError(null);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (rename.isPending) return;
    const parsed = Label.safeParse(name);
    if (!parsed.success) {
      setNameError(t('web.profile.nameRequired'));
      input.current?.focus();
      return;
    }
    setFormError(null);
    if (parsed.data === passkey.name) {
      onOpenChange(false);
      return;
    }
    rename.mutate(
      { id: passkey.id, name: parsed.data },
      {
        onSuccess: () => {
          toast.success(t('web.security.passkeyRenamed'));
          onOpenChange(false);
        },
        onError: (error) => setFormError(errorMessage(error, t)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('web.security.passkeyRenameTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('web.common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={rename.isPending}>
            {t('web.common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('web.security.passkeyName')} error={nameError}>
          {(control) => (
            <Input
              {...control}
              ref={input}
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
        {formError ? <FormAlert>{formError}</FormAlert> : null}
      </form>
    </Dialog>
  );
}
