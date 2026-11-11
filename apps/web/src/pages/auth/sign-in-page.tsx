import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, KeyRound, Wrench } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { passkeySignInOptions, signInWithPasskey, signInWithPassword } from '../../api/auth.ts';
import { errorMessage } from '../../api/client.ts';
import type { Me, PublicConfig } from '../../api/dto.ts';
import { replaceSession, useMe, usePublicConfig } from '../../api/session.ts';
import { useGoTo } from '../../lib/navigation.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { oidcStartPath, returnToFrom } from '../../lib/return-to.ts';
import { getPasskeyAssertion, passkeyErrorMessage, passkeysUsable } from '../../lib/webauthn.ts';
import { Button, ErrorState, Field, Input } from '../../ui/index.ts';
import { AuthLayout, AuthNotice, AuthSkeleton, FormAlert, OrDivider } from './auth-layout.tsx';

/**
 * `/signin?return_to=…` (or `?next=…`, as raw links send it). Single sign-on
 * comes first when it is set up, with the owner account behind a disclosure;
 * otherwise the owner signs in with a passkey or a password. Someone already
 * signed in, or who just signed in, goes on to the return path.
 */
export function SignInPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.signin.pageTitle'));
  const [params] = useSearchParams();
  const returnTo = returnToFrom(params);
  const config = usePublicConfig();
  const me = useMe();
  const queryClient = useQueryClient();
  const goTo = useGoTo();
  const leaving = useRef(false);

  const goOn = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    goTo(returnTo, { replace: true });
  }, [goTo, returnTo]);

  useEffect(() => {
    if (me.data) goOn();
  }, [me.data, goOn]);

  const signedIn = useCallback(
    (next: Me) => {
      replaceSession(queryClient, next);
      goOn();
    },
    [queryClient, goOn],
  );

  const title = t('web.signin.title');
  if (config.isError) {
    return (
      <AuthLayout title={title}>
        <ErrorState
          compact
          message={errorMessage(config.error, t)}
          onRetry={() => void config.refetch()}
        />
      </AuthLayout>
    );
  }
  // A failed `/me` reads as signed out here: signing in is the way forward.
  if (!config.data || me.isPending || me.data) {
    return (
      <AuthLayout title={title}>
        <AuthSkeleton />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={title}>
      {config.data.setup_required ? (
        <AuthNotice icon={<Wrench />}>{t('auth.setup.required')}</AuthNotice>
      ) : (
        <SignInOptions config={config.data} returnTo={returnTo} onSignedIn={signedIn} />
      )}
    </AuthLayout>
  );
}

function SignInOptions({
  config,
  returnTo,
  onSignedIn,
}: {
  config: PublicConfig;
  returnTo: string;
  onSignedIn(me: Me): void;
}) {
  const { t } = useTranslation();
  const [ownerOpen, setOwnerOpen] = useState(false);
  const ownerId = useId();

  if (!config.oidc.enabled)
    return <OwnerSignIn config={config} prominent onSignedIn={onSignedIn} />;

  const idp = config.oidc.display_name ?? t('web.signin.oidcDefaultName');
  return (
    <div className="flex flex-col gap-3">
      {/* A full page load: the server starts the sign-in and redirects to the IdP. */}
      <Button asChild size="lg" className="w-full">
        <a href={oidcStartPath(returnTo)}>{t('web.signin.oidc', { name: idp })}</a>
      </Button>
      <Button
        variant="ghost"
        className="group w-full text-fg-muted hover:text-fg aria-expanded:bg-transparent aria-expanded:text-fg"
        aria-expanded={ownerOpen}
        aria-controls={ownerId}
        onClick={() => setOwnerOpen((open) => !open)}
      >
        {t('web.signin.ownerToggle')}
        <ChevronDown
          aria-hidden="true"
          className="transition-transform duration-(--duration-base) group-aria-expanded:rotate-180"
        />
      </Button>
      <div id={ownerId}>
        {ownerOpen ? (
          <div className="mt-2 border-border border-t pt-6">
            <OwnerSignIn config={config} prominent={false} onSignedIn={onSignedIn} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The owner account's own sign-in: a passkey when this browser can use one,
 * and a password. `prominent` makes its first option the page's primary
 * action; behind single sign-on every option is secondary.
 */
function OwnerSignIn({
  config,
  prominent,
  onSignedIn,
}: {
  config: PublicConfig;
  prominent: boolean;
  onSignedIn(me: Me): void;
}) {
  const { t } = useTranslation();
  const withPasskey = passkeysUsable(config);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<'passkey' | 'password' | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const passkeyButton = useRef<HTMLButtonElement>(null);
  // Set at once, unlike `pending`, so a second click or Enter cannot start a second request.
  const busy = useRef(false);

  const start = (method: 'passkey' | 'password') => {
    busy.current = true;
    setPending(method);
    setPasskeyError(null);
    setPasswordError(null);
  };
  /** Ends an attempt with `error`, then puts focus back where the person can try again. */
  const fail = (show: () => void, focus: HTMLElement | null) => {
    busy.current = false;
    // Re-enabled in this render, so the button can take focus right after.
    flushSync(() => {
      setPending(null);
      show();
    });
    focus?.focus();
  };

  const signInPasskey = async () => {
    if (busy.current) return;
    start('passkey');
    try {
      const ceremony = await passkeySignInOptions();
      const response = await getPasskeyAssertion(ceremony.options);
      onSignedIn(await signInWithPasskey({ ceremony_id: ceremony.ceremony_id, response }));
    } catch (error) {
      fail(() => setPasskeyError(passkeyErrorMessage(error, t, 'get')), passkeyButton.current);
    }
  };

  const signInPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    if (password === '') {
      setPasswordError(t('web.signin.passwordRequired'));
      passwordInput.current?.focus();
      return;
    }
    start('password');
    try {
      onSignedIn(await signInWithPassword(password));
    } catch (error) {
      fail(() => setPasswordError(errorMessage(error, t)), passwordInput.current);
      passwordInput.current?.select();
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {withPasskey ? (
        <>
          <div className="flex flex-col gap-3">
            <Button
              ref={passkeyButton}
              variant={prominent ? 'primary' : 'secondary'}
              size="lg"
              className="w-full"
              leadingIcon={<KeyRound aria-hidden="true" />}
              loading={pending === 'passkey'}
              disabled={pending !== null}
              onClick={() => void signInPasskey()}
            >
              {t('web.signin.passkey')}
            </Button>
            {passkeyError ? <FormAlert>{passkeyError}</FormAlert> : null}
          </div>
          <OrDivider />
        </>
      ) : null}
      <form noValidate onSubmit={signInPassword} className="flex flex-col gap-4">
        <Field label={t('web.signin.password')} error={passwordError}>
          {(control) => (
            <Input
              {...control}
              ref={passwordInput}
              type="password"
              autoComplete="current-password"
              className="h-10"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordError(null);
              }}
            />
          )}
        </Field>
        <Button
          type="submit"
          variant={prominent && !withPasskey ? 'primary' : 'secondary'}
          size="lg"
          className="w-full"
          loading={pending === 'password'}
          disabled={pending !== null}
        >
          {t('web.signin.submit')}
        </Button>
      </form>
      {config.passkeys_available ? null : (
        <p className="text-pretty text-center text-fg-muted text-sm">
          {t('auth.passkeysUnavailable')}
        </p>
      )}
    </div>
  );
}
