import { type FormEvent, type RefObject, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChangePassword, useRemovePassword } from '../../api/account.ts';
import { errorMessage } from '../../api/client.ts';
import { PASSWORD_MIN_LENGTH } from '../../api/dto.ts';
import { passwordProblem } from '../../lib/password.ts';
import { Button, ConfirmDialog, Field, Input, toast } from '../../ui/index.ts';
import { FormAlert } from '../auth/auth-layout.tsx';
import { CardBody, SettingsCard } from './settings-card.tsx';

type Problem = 'old' | 'new' | 'confirm';
const PROBLEM_ORDER: readonly Problem[] = ['old', 'new', 'confirm'];

/**
 * The owner's password. With one set, changing it takes the current one; an
 * owner who signs in with passkeys alone adds one without. Removing it is
 * offered only while a passkey remains, and the server has the last word.
 */
export function PasswordCard({
  hasPassword,
  passkeyCount,
}: {
  hasPassword: boolean;
  passkeyCount: number;
}) {
  const { t } = useTranslation();
  const change = useChangePassword();
  const remove = useRemovePassword();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<Partial<Record<Problem, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const fields: Record<Problem, RefObject<HTMLInputElement | null>> = {
    old: useRef<HTMLInputElement>(null),
    new: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  const clear = (field: Problem) =>
    setProblems((found) => {
      const { [field]: _gone, ...rest } = found;
      return rest;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (change.isPending) return;
    setFormError(null);

    const found: Partial<Record<Problem, string>> = {};
    if (hasPassword && oldPassword === '') found.old = t('web.security.passwordCurrentRequired');
    const problem = passwordProblem(newPassword, t);
    if (problem) found.new = problem;
    else if (confirm !== newPassword) found.confirm = t('web.security.passwordMismatch');
    setProblems(found);
    const first = PROBLEM_ORDER.find((field) => found[field]);
    if (first) {
      fields[first].current?.focus();
      return;
    }

    change.mutate(
      hasPassword
        ? { current_password: oldPassword, new_password: newPassword }
        : { new_password: newPassword },
      {
        onSuccess: () => {
          setOldPassword('');
          setNewPassword('');
          setConfirm('');
          toast.success(
            t(hasPassword ? 'web.security.passwordChanged' : 'web.security.passwordAdded'),
          );
        },
        onError: (error) => {
          if (error.code === 'invalid_credentials') {
            setProblems({ old: errorMessage(error, t) });
            fields.old.current?.focus();
            fields.old.current?.select();
          } else if (error.details?.field === 'password') {
            setProblems({ new: errorMessage(error, t) });
            fields.new.current?.focus();
          } else {
            setFormError(errorMessage(error, t));
          }
        },
      },
    );
  };

  return (
    <SettingsCard
      title={t('web.security.password')}
      description={t(
        hasPassword ? 'web.security.passwordChangeHint' : 'web.security.passwordAddHint',
      )}
    >
      <CardBody>
        <form noValidate onSubmit={submit} className="flex max-w-sm flex-col gap-5">
          {hasPassword ? (
            <Field label={t('web.security.passwordCurrent')} error={problems.old}>
              {(control) => (
                <Input
                  {...control}
                  ref={fields.old}
                  type="password"
                  autoComplete="current-password"
                  value={oldPassword}
                  onChange={(event) => {
                    setOldPassword(event.target.value);
                    clear('old');
                  }}
                />
              )}
            </Field>
          ) : null}
          <Field
            label={t('web.security.passwordNew')}
            description={t('web.security.passwordHint', { min: PASSWORD_MIN_LENGTH })}
            error={problems.new}
          >
            {(control) => (
              <Input
                {...control}
                ref={fields.new}
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  clear('new');
                }}
              />
            )}
          </Field>
          <Field label={t('web.security.passwordConfirm')} error={problems.confirm}>
            {(control) => (
              <Input
                {...control}
                ref={fields.confirm}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => {
                  setConfirm(event.target.value);
                  clear('confirm');
                }}
              />
            )}
          </Field>
          {formError ? <FormAlert>{formError}</FormAlert> : null}
          <div>
            <Button type="submit" loading={change.isPending}>
              {t(hasPassword ? 'web.security.passwordChange' : 'web.security.passwordAdd')}
            </Button>
          </div>
        </form>
      </CardBody>

      {hasPassword && passkeyCount >= 1 ? (
        <CardBody className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="min-w-0 flex-1 basis-64 text-fg-muted text-sm">
            {t('web.security.passwordRemoveHint')}
          </p>
          <Button variant="secondary" onClick={() => setRemoving(true)}>
            {t('web.security.passwordRemove')}
          </Button>
        </CardBody>
      ) : null}

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('web.security.passwordRemoveTitle')}
        body={t('web.security.passwordRemoveBody')}
        confirmLabel={t('web.security.passwordRemove')}
        tone="danger"
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success(t('web.security.passwordRemoved'));
        }}
      />
    </SettingsCard>
  );
}
