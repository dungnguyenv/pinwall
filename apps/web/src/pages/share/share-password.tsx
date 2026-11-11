import { Eye, EyeOff, LockKeyholeOpen } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage, isApiError } from '../../api/client.ts';
import { unlockShare } from '../../api/shares.ts';
import { browser } from '../../lib/navigation.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { Button, Field, IconButton, Input } from '../../ui/index.ts';
import { FormAlert } from '../auth/auth-layout.tsx';
import { ShareCard } from './share-card.tsx';

/**
 * The page a password-protected link opens until this browser unlocks it: one
 * password field and Unlock. The server answers with the unlock cookie, and
 * the link then loads again in full, because the server decides what it
 * opens: the share viewer for a link with comments, the raw page otherwise.
 * A wrong password or too many tries show the server's own words.
 */
export function SharePassword({ token }: { token: string }) {
  const { t } = useTranslation();
  usePageTitle(t('web.share.password.title'));
  const input = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The password is all this page asks for.
  useEffect(() => input.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password === '') {
      setFieldError(t('web.share.password.required'));
      input.current?.focus();
      return;
    }
    setBusy(true);
    setFieldError(null);
    setFormError(null);
    try {
      await unlockShare(token, password);
      // Stays busy: the page is replaced.
      browser.assign(`/s/${encodeURIComponent(token)}`);
    } catch (error) {
      setBusy(false);
      if (isApiError(error, 'invalid_credentials')) {
        setFieldError(errorMessage(error, t));
        input.current?.select();
      } else {
        setFormError(errorMessage(error, t));
      }
    }
  };

  return (
    <ShareCard
      title={t('web.share.password.title')}
      description={t('web.share.password.description')}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('web.share.password.label')} error={fieldError}>
          {(control) => (
            <div className="relative">
              <Input
                {...control}
                ref={input}
                type={reveal ? 'text' : 'password'}
                // Not the person's own account password, which a browser would offer for this site.
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="h-10 pr-11"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setFieldError(null);
                }}
              />
              <div className="absolute top-1 right-1">
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
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          leadingIcon={<LockKeyholeOpen />}
          loading={busy}
        >
          {t('web.share.password.unlock')}
        </Button>
      </form>
    </ShareCard>
  );
}
