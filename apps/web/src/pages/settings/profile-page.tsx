import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUpdateProfile } from '../../api/account.ts';
import { errorMessage } from '../../api/client.ts';
import { Label, type Me, UpdateProfileRequest } from '../../api/dto.ts';
import { useMe, usePublicConfig } from '../../api/session.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { Avatar, Button, Field, Input, toast } from '../../ui/index.ts';
import { FormAlert } from '../auth/auth-layout.tsx';
import { CardBody, SettingsCard } from './settings-card.tsx';

const MAX_NAME = 100;
const MAX_EMAIL = 254;

/** `/settings/profile`: the owner edits their name and email; single sign-on users only read them. */
export function ProfilePage() {
  const { t } = useTranslation();
  usePageTitle(t('web.settings.profile'));
  const { data: me } = useMe();
  if (!me) return null;
  return me.kind === 'owner' ? <OwnerProfile me={me} /> : <ManagedProfile me={me} />;
}

function OwnerProfile({ me }: { me: Me }) {
  const { t } = useTranslation();
  const update = useUpdateProfile();
  const [name, setName] = useState(me.name);
  const [email, setEmail] = useState(me.email ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);

  // An emptied email is sent as null, which removes it.
  const mail = email.trim() === '' ? null : email.trim();
  const dirty = name.trim() !== me.name || mail !== me.email;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (update.isPending) return;
    setFormError(null);

    const parsedName = Label.safeParse(name);
    const emailOk = mail === null || UpdateProfileRequest.shape.email.safeParse(mail).success;
    setNameError(parsedName.success ? null : t('web.profile.nameRequired'));
    setEmailError(emailOk ? null : t('web.profile.emailInvalid'));
    if (!parsedName.success) {
      nameInput.current?.focus();
      return;
    }
    if (!emailOk) {
      emailInput.current?.focus();
      return;
    }

    update.mutate(
      { name: parsedName.data, email: mail },
      {
        onSuccess: (saved) => {
          setName(saved.name);
          setEmail(saved.email ?? '');
          toast.success(t('web.profile.saved'));
        },
        onError: (error) => setFormError(errorMessage(error, t)),
      },
    );
  };

  return (
    <SettingsCard title={t('web.profile.title')} description={t('web.profile.description')}>
      <CardBody>
        <form noValidate onSubmit={submit} className="flex max-w-md flex-col gap-5">
          <Field label={t('web.profile.name')} error={nameError}>
            {(control) => (
              <Input
                {...control}
                ref={nameInput}
                autoComplete="name"
                maxLength={MAX_NAME}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
              />
            )}
          </Field>
          <Field label={t('web.profile.email')} error={emailError} optional>
            {(control) => (
              <Input
                {...control}
                ref={emailInput}
                type="email"
                autoComplete="email"
                maxLength={MAX_EMAIL}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailError(null);
                }}
              />
            )}
          </Field>
          {formError ? <FormAlert>{formError}</FormAlert> : null}
          <div>
            <Button type="submit" loading={update.isPending} disabled={!dirty}>
              {t('web.profile.save')}
            </Button>
          </div>
        </form>
      </CardBody>
    </SettingsCard>
  );
}

/** Details that come from the identity provider: shown, not editable. */
function ManagedProfile({ me }: { me: Me }) {
  const { t } = useTranslation();
  const config = usePublicConfig();
  const idp = config.data?.oidc.display_name ?? t('web.signin.oidcDefaultName');

  return (
    <SettingsCard title={t('web.profile.title')} description={t('web.profile.managedBy', { idp })}>
      <CardBody className="flex items-start gap-4">
        <Avatar name={me.name} size="lg" />
        <dl className="flex min-w-0 flex-1 flex-col gap-4">
          <ManagedDetail label={t('web.profile.name')}>{me.name}</ManagedDetail>
          <ManagedDetail label={t('web.profile.email')}>
            {me.email ?? <span className="text-fg-muted">{t('web.profile.noEmail')}</span>}
          </ManagedDetail>
        </dl>
      </CardBody>
    </SettingsCard>
  );
}

/** One read-only detail: its label, with its value beside it from 640 px and under it on phones. */
function ManagedDetail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-x-6">
      <dt className="text-fg-muted text-sm sm:pt-0.5">{label}</dt>
      <dd className="break-words text-base text-fg">{children}</dd>
    </div>
  );
}
