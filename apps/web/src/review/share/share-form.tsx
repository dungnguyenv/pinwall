import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import {
  type CreatedShareLink,
  PASSWORD_MAX_LENGTH,
  SHARE_PASSWORD_MIN_LENGTH,
  type VersionSummary,
} from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { createShareLink } from '../../api/shares.ts';
import { FormAlert } from '../../pages/auth/auth-layout.tsx';
import { Field, IconButton, Input, Select, Switch } from '../../ui/index.ts';
import { EXPIRY_DAYS, type ExpiryDays, expiresAtFor } from './share-status.ts';

type Scope = 'latest' | 'version';
type Access = 'anyone' | 'password';

/** A Select's values are text; `null` (never expires) has none of its own. */
const expiryValue = (days: ExpiryDays) => (days === null ? 'never' : String(days));
/** The label of each choice, by its value; spelled out so every key can be found by search. */
const EXPIRY_LABELS: Record<string, string> = {
  never: 'web.share.expiry.never',
  '1': 'web.share.expiry.1',
  '7': 'web.share.expiry.7',
  '30': 'web.share.expiry.30',
};

/**
 * How long a password is as the server counts it: in code points, once
 * normalized the way it normalizes (NFKC), so "fewer than 8" agrees on both sides.
 */
function passwordLength(password: string): number {
  return [...password.normalize('NFKC')].length;
}

/**
 * What a new link shows, who can open it, when it ends and whether people may
 * comment. Sends the request itself; the new link, with its one-time URL, goes
 * to `onCreated` and nowhere else. `shown` is the version on screen, or null
 * when it is not known (its page of the list is not read), which leaves only
 * the latest version to choose. The submit button is outside, in the dialog's
 * footer, and names this form by `formId`.
 */
export function ShareForm({
  artifactId,
  shown,
  formId,
  onPending,
  onCreated,
}: {
  artifactId: string;
  shown: VersionSummary | null;
  formId: string;
  onPending(pending: boolean): void;
  onCreated(created: CreatedShareLink): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const passwordInput = useRef<HTMLInputElement>(null);
  // The version the choice "v3 only" means stays as it was when the form opened, even if
  // the review moves to a newer one meanwhile; one not known yet is taken once it is.
  const [pinned, setPinned] = useState(shown);
  if (pinned === null && shown !== null) setPinned(shown);
  const [scope, setScope] = useState<Scope>('latest');
  const [access, setAccess] = useState<Access>('anyone');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState(expiryValue(EXPIRY_DAYS[0]));
  const [comments, setComments] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Set at once, unlike state, so a second Enter cannot make a second link.
  const busy = useRef(false);

  const chooseAccess = (next: string) => {
    setAccess(next === 'password' ? 'password' : 'anyone');
    if (next !== 'password') {
      // A password nobody asked for is not kept around.
      setPassword('');
      setPasswordError(null);
      setReveal(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    if (access === 'password' && passwordLength(password) < SHARE_PASSWORD_MIN_LENGTH) {
      setPasswordError(t('share.passwordTooShort', { min: SHARE_PASSWORD_MIN_LENGTH }));
      passwordInput.current?.focus();
      return;
    }
    busy.current = true;
    onPending(true);
    setFormError(null);
    try {
      // Not a mutation: the answer holds the token, and mutation results are cached.
      const created = await createShareLink(artifactId, {
        version_id: scope === 'version' && pinned ? pinned.id : null,
        password: access === 'password' ? password : null,
        expires_at: expiresAtFor(expiry === 'never' ? null : Number(expiry), Date.now()),
        allow_comments: comments,
      });
      // The list, and the "share links" count of the artifact, change. Neither holds the token.
      void queryClient.invalidateQueries({ queryKey: qk.shareLinks(artifactId) });
      void queryClient.invalidateQueries({ queryKey: qk.artifact(artifactId) });
      void queryClient.invalidateQueries({ queryKey: qk.artifactLists });
      onCreated(created);
    } catch (error) {
      setFormError(errorMessage(error, t));
    } finally {
      busy.current = false;
      onPending(false);
    }
  };

  const scopeOptions = [{ value: 'latest', label: t('web.share.scopeLatest') }];
  if (pinned) {
    scopeOptions.push({
      value: 'version',
      label: t('web.share.scopeVersion', { number: pinned.number }),
    });
  }

  return (
    <form
      id={formId}
      noValidate
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-5"
    >
      <Select
        label={t('web.share.scope')}
        value={scope}
        onValueChange={(next) => setScope(next === 'version' ? 'version' : 'latest')}
        options={scopeOptions}
      />
      <Select
        label={t('web.share.access')}
        value={access}
        onValueChange={chooseAccess}
        options={[
          { value: 'anyone', label: t('web.share.accessAnyone') },
          { value: 'password', label: t('web.share.accessPassword') },
        ]}
      />
      {access === 'password' ? (
        <Field
          label={t('web.share.password')}
          description={t('web.share.passwordHint', { min: SHARE_PASSWORD_MIN_LENGTH })}
          error={passwordError}
        >
          {(control) => (
            <div className="relative">
              <Input
                {...control}
                ref={passwordInput}
                // "new-password" keeps the browser from offering the person's own account password.
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={PASSWORD_MAX_LENGTH}
                type={reveal ? 'text' : 'password'}
                className="pr-11"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setPasswordError(null);
                }}
              />
              <div className="absolute top-0.5 right-0.5">
                <IconButton
                  label={t(reveal ? 'web.share.hidePassword' : 'web.share.showPassword')}
                  icon={reveal ? <EyeOff /> : <Eye />}
                  size="sm"
                  onClick={() => setReveal((now) => !now)}
                />
              </div>
            </div>
          )}
        </Field>
      ) : null}
      <Select
        label={t('web.share.expires')}
        value={expiry}
        onValueChange={setExpiry}
        options={EXPIRY_DAYS.map((days) => ({
          value: expiryValue(days),
          label: t(EXPIRY_LABELS[expiryValue(days)] ?? 'web.share.expiry.never'),
        }))}
      />
      <Switch
        label={t('web.share.comments')}
        description={t('web.share.commentsHint')}
        checked={comments}
        onCheckedChange={setComments}
      />
      {formError ? <FormAlert>{formError}</FormAlert> : null}
    </form>
  );
}
