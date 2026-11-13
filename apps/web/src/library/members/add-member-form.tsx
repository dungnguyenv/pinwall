import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import {
  AddMemberRequest,
  type MemberCandidate,
  type Project,
  ProjectMemberRole,
} from '../../api/dto.ts';
import { candidatesOf, memberErrorField, useAddMember } from '../../api/members.ts';
import { FormAlert } from '../../pages/auth/auth-layout.tsx';
import { Button, Field, Input, Select } from '../../ui/index.ts';
import { useDisplayName, useRoleOptions } from './member-row.tsx';

const EMAIL = AddMemberRequest.shape.email;

/** How each kind of account signs in; spelled out so every key can be found by search. */
const KIND_LABELS: Record<MemberCandidate['kind'], string> = {
  owner: 'web.members.kind.owner',
  oidc: 'web.members.kind.oidc',
};

/**
 * What the owner fills in to let someone in: the email they signed in to Pinwall with, and a
 * role. When several accounts use the email the server lists them; the owner then picks one,
 * and only that one is added. The choice belongs to the address typed: editing it drops the choice.
 */
export function AddMemberForm({ project }: { project: Project }) {
  const { t } = useTranslation();
  const add = useAddMember(project.id);
  const roles = useRoleOptions();
  const display = useDisplayName();
  const emailInput = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectMemberRole>('viewer');
  const [several, setSeveral] = useState<{
    candidates: MemberCandidate[];
    message: string;
  } | null>(null);
  const [accountId, setAccountId] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const changeEmail = (next: string) => {
    setEmail(next);
    setEmailError(null);
    setSeveral(null);
    setAccountId('');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (add.isPending) return;
    // With accounts to choose from, Add waits for the choice; Enter in the field must too.
    if (several && accountId === '') return;
    const address = email.trim();
    if (!EMAIL.safeParse(address).success) {
      setEmailError(t('web.members.emailInvalid'));
      emailInput.current?.focus();
      return;
    }
    setEmailError(null);
    setFormError(null);
    const body: AddMemberRequest = { email: address, role };
    if (several) body.user_id = accountId;
    add.mutate(body, {
      onSuccess: () => {
        setEmail('');
        setRole('viewer');
        setSeveral(null);
        setAccountId('');
        emailInput.current?.focus();
      },
      onError: (error) => {
        const candidates = candidatesOf(error);
        if (candidates) {
          setSeveral({ candidates, message: errorMessage(error, t) });
          setAccountId('');
        } else if (memberErrorField(error) === 'email') {
          setEmailError(errorMessage(error, t));
          emailInput.current?.focus();
        } else {
          setFormError(errorMessage(error, t));
        }
      },
    });
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4 border-border border-t pt-5">
      <Field label={t('web.members.email')} description={t('web.members.hint')} error={emailError}>
        {(control) => (
          <Input
            {...control}
            ref={emailInput}
            type="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            value={email}
            onChange={(event) => changeEmail(event.target.value)}
          />
        )}
      </Field>
      {several ? (
        <div className="flex flex-col gap-3 rounded-lg bg-surface-muted p-3.5">
          <p className="text-fg text-sm">{several.message}</p>
          <Select
            label={t('web.members.chooseAccount')}
            placeholder={t('web.members.choosePlaceholder')}
            value={accountId}
            onValueChange={setAccountId}
            options={several.candidates.map((candidate) => ({
              value: candidate.user_id,
              label: display(candidate.name),
              detail: t(KIND_LABELS[candidate.kind]),
            }))}
          />
        </div>
      ) : null}
      <div className="flex items-end gap-3">
        <div className="w-40">
          <Select
            label={t('web.members.role')}
            value={role}
            onValueChange={(next) => {
              const parsed = ProjectMemberRole.safeParse(next);
              if (parsed.success) setRole(parsed.data);
            }}
            options={roles}
          />
        </div>
        <Button
          type="submit"
          loading={add.isPending}
          disabled={several !== null && accountId === ''}
        >
          {t('web.members.add')}
        </Button>
      </div>
      {formError ? <FormAlert>{formError}</FormAlert> : null}
    </form>
  );
}
