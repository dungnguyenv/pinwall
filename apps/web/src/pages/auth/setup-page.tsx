import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, KeyRound, Link2Off, RectangleEllipsis, ScrollText } from 'lucide-react';
import { Switch } from 'radix-ui';
import { type FormEvent, type ReactNode, type Ref, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { checkSetupToken, completeSetup, setupPasskeyOptions } from '../../api/auth.ts';
import { type ApiError, errorMessage, isApiError } from '../../api/client.ts';
import { Label, PASSWORD_MIN_LENGTH, type PublicConfig, SetupRequest } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { replaceSession, usePublicConfig } from '../../api/session.ts';
import { IsolationExplainer } from '../../app/isolation-explainer.tsx';
import { usePageTitle } from '../../lib/page-title.ts';
import { passwordProblem } from '../../lib/password.ts';
import { createPasskey, passkeyErrorMessage, passkeysUsable } from '../../lib/webauthn.ts';
import { Button, ErrorState, Field, Input, toast } from '../../ui/index.ts';
import { AuthLayout, AuthNotice, AuthSkeleton, FormAlert } from './auth-layout.tsx';

const MAX_NAME = 100;
const MAX_EMAIL = 254;

/**
 * `/setup?token=…`, opened from the one-time link the server logs on first
 * start. The link is checked before the form shows; the form creates the
 * owner account with a passkey, a password or both, then opens the app.
 */
export function SetupPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.setup.pageTitle'));
  const [params] = useSearchParams();
  const token = params.get('token');
  if (!token) {
    return (
      <AuthLayout title={t('web.setup.title')} wide>
        <AuthNotice icon={<ScrollText />}>{t('web.setup.noToken')}</AuthNotice>
      </AuthLayout>
    );
  }
  return <SetupWithLink token={token} />;
}

function SetupWithLink({ token }: { token: string }) {
  const { t } = useTranslation();
  const check = useQuery<true, ApiError>({
    queryKey: qk.setupCheck(token),
    queryFn: async () => {
      await checkSetupToken(token);
      return true as const;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  const config = usePublicConfig();
  // Set when the form's own request finds setup already done.
  const [doneElsewhere, setDoneElsewhere] = useState<ApiError | null>(null);

  const title = t('web.setup.title');
  const problem = doneElsewhere ?? check.error ?? config.error;
  if (problem) {
    const retry = () => {
      if (check.isError) void check.refetch();
      if (config.isError) void config.refetch();
    };
    return (
      <AuthLayout title={title} wide>
        <LinkProblem error={problem} onRetry={retry} />
      </AuthLayout>
    );
  }
  if (!check.data || !config.data) {
    return (
      <AuthLayout title={title} wide>
        <AuthSkeleton />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={title} description={t('web.setup.description')} wide>
      <SetupForm token={token} config={config.data} onSetupDone={setDoneElsewhere} />
    </AuthLayout>
  );
}

/**
 * Why the form cannot show: setup is done (sign in instead), the link is dead
 * (the server says how to get a new one), or the check failed on the way
 * (try again). The server's message is shown as it wrote it.
 */
function LinkProblem({ error, onRetry }: { error: ApiError; onRetry(): void }) {
  const { t } = useTranslation();
  if (error.code === 'setup_done') {
    return (
      <AuthNotice
        icon={<CircleCheck />}
        action={
          <Button asChild size="lg" className="w-full">
            <Link to="/signin">{t('web.setup.signIn')}</Link>
          </Button>
        }
      >
        {errorMessage(error, t)}
      </AuthNotice>
    );
  }
  if (error.status === 403) {
    return (
      <AuthNotice tone="danger" icon={<Link2Off />}>
        {errorMessage(error, t)}
      </AuthNotice>
    );
  }
  return <ErrorState compact message={errorMessage(error, t)} onRetry={onRetry} />;
}

type Problem = 'name' | 'email' | 'methods' | 'password' | 'confirm';
/** The order fields appear in, so the first one with a problem takes focus. */
const PROBLEM_ORDER: readonly Problem[] = ['name', 'email', 'methods', 'password', 'confirm'];

function SetupForm({
  token,
  config,
  onSetupDone,
}: {
  token: string;
  config: PublicConfig;
  onSetupDone(error: ApiError): void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canPasskey = passkeysUsable(config);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [passkeyOn, setPasskeyOn] = useState(canPasskey);
  const [passwordOn, setPasswordOn] = useState(!canPasskey);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problems, setProblems] = useState<Partial<Record<Problem, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set at once, unlike `pending`, so a second submit cannot start a second setup.
  const busy = useRef(false);

  const nameInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const passkeySwitch = useRef<HTMLButtonElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const focusTargets: Record<Problem, { current: HTMLElement | null }> = {
    name: nameInput,
    email: emailInput,
    methods: passkeySwitch,
    password: passwordInput,
    confirm: confirmInput,
  };

  const withPasskey = canPasskey && passkeyOn;
  const withPassword = !canPasskey || passwordOn;
  const methodsId = useId();

  const clear = (...fields: Problem[]) =>
    setProblems((current) => {
      const next = { ...current };
      for (const field of fields) delete next[field];
      return next;
    });

  const findProblems = (): Partial<Record<Problem, string>> => {
    const found: Partial<Record<Problem, string>> = {};
    if (!Label.safeParse(name).success) found.name = t('web.setup.nameRequired');
    const mail = email.trim();
    if (mail !== '' && !SetupRequest.shape.email.safeParse(mail).success) {
      found.email = t('web.setup.emailInvalid');
    }
    if (!withPasskey && !withPassword) found.methods = t('auth.setup.needCredential');
    if (withPassword) {
      const problem = passwordProblem(password, t);
      if (problem) found.password = problem;
      else if (confirm !== password) found.confirm = t('web.setup.passwordMismatch');
    }
    return found;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    const found = findProblems();
    setProblems(found);
    setFormError(null);
    const first = PROBLEM_ORDER.find((field) => found[field]);
    if (first) {
      focusTargets[first].current?.focus();
      return;
    }

    busy.current = true;
    setPending(true);
    const owner = Label.parse(name);
    const mail = email.trim();
    try {
      const body: SetupRequest = { token, name: owner };
      if (mail !== '') body.email = mail;
      if (withPassword) body.password = password;
      if (withPasskey) {
        const ceremony = await setupPasskeyOptions({ token, name: owner });
        const response = await createPasskey(ceremony.options);
        body.passkey = { ceremony_id: ceremony.ceremony_id, response };
      }
      const me = await completeSetup(body);
      replaceSession(queryClient, me);
      // The configuration is read once per page load; now that an owner
      // exists, a later sign-in must not be told to finish setup.
      queryClient.setQueryData<PublicConfig>(qk.publicConfig, (c) =>
        c ? { ...c, setup_required: false } : c,
      );
      toast.success(t('web.setup.welcome'));
      void navigate('/', { replace: true });
    } catch (error) {
      busy.current = false;
      if (isApiError(error, 'setup_done')) {
        onSetupDone(error);
        return;
      }
      const aboutPassword = isApiError(error) && error.details?.field === 'password';
      // Re-enabled in this render, so focus can go back to the form right after.
      flushSync(() => {
        setPending(false);
        if (aboutPassword) setProblems({ password: errorMessage(error, t) });
        else setFormError(passkeyErrorMessage(error, t, 'create'));
      });
      (aboutPassword ? passwordInput : submitButton).current?.focus();
    }
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-6">
      <Field label={t('web.setup.name')} error={problems.name}>
        {(control) => (
          <Input
            {...control}
            ref={nameInput}
            autoComplete="name"
            maxLength={MAX_NAME}
            className="h-10"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              clear('name');
            }}
          />
        )}
      </Field>
      <Field label={t('web.setup.email')} error={problems.email} optional>
        {(control) => (
          <Input
            {...control}
            ref={emailInput}
            type="email"
            autoComplete="email"
            maxLength={MAX_EMAIL}
            className="h-10"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              clear('email');
            }}
          />
        )}
      </Field>

      <fieldset aria-describedby={canPasskey ? `${methodsId}-hint` : undefined}>
        <legend className="font-medium text-fg text-sm">{t('web.setup.methods')}</legend>
        {canPasskey ? (
          <p id={`${methodsId}-hint`} className="mt-1 text-pretty text-fg-muted text-sm">
            {t('web.setup.bothHint')}
          </p>
        ) : null}
        <div className="mt-3 divide-y divide-border rounded-lg border border-border">
          {canPasskey ? (
            <MethodRow
              icon={<KeyRound />}
              title={t('web.setup.passkey')}
              hint={t('web.setup.passkeyHint')}
              checked={passkeyOn}
              switchRef={passkeySwitch}
              onCheckedChange={(on) => {
                setPasskeyOn(on);
                clear('methods');
              }}
            />
          ) : null}
          <MethodRow
            icon={<RectangleEllipsis />}
            title={t('web.setup.password')}
            hint={t('web.setup.passwordHint', { min: PASSWORD_MIN_LENGTH })}
            // Without passkeys a password is the only way in: no switch.
            checked={canPasskey ? passwordOn : null}
            onCheckedChange={(on) => {
              setPasswordOn(on);
              clear('methods', 'password', 'confirm');
            }}
          >
            {withPassword ? (
              <>
                <Field label={t('web.setup.passwordNew')} error={problems.password}>
                  {(control) => (
                    <Input
                      {...control}
                      ref={passwordInput}
                      type="password"
                      autoComplete="new-password"
                      className="h-10"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        clear('password');
                      }}
                    />
                  )}
                </Field>
                <Field label={t('web.setup.passwordConfirm')} error={problems.confirm}>
                  {(control) => (
                    <Input
                      {...control}
                      ref={confirmInput}
                      type="password"
                      autoComplete="new-password"
                      className="h-10"
                      value={confirm}
                      onChange={(event) => {
                        setConfirm(event.target.value);
                        clear('confirm');
                      }}
                    />
                  )}
                </Field>
              </>
            ) : null}
          </MethodRow>
        </div>
        {problems.methods ? (
          <div className="mt-3">
            <FormAlert>{problems.methods}</FormAlert>
          </div>
        ) : null}
        {config.passkeys_available ? null : (
          <p className="mt-3 text-pretty text-fg-muted text-sm">{t('auth.passkeysUnavailable')}</p>
        )}
      </fieldset>

      <IsolationExplainer current={config.isolation} compact />

      <div className="flex flex-col gap-3">
        {formError ? <FormAlert>{formError}</FormAlert> : null}
        <Button ref={submitButton} type="submit" size="lg" className="w-full" loading={pending}>
          {t('web.setup.submit')}
        </Button>
        {withPasskey ? (
          <p className="text-center text-fg-muted text-sm">{t('web.setup.passkeyNext')}</p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * One way to sign in: its icon, name and a line about it, with a switch to
 * turn it on. `checked: null` means it is always on and has no switch.
 * Clicking the name flips the switch too.
 */
function MethodRow({
  icon,
  title,
  hint,
  checked,
  onCheckedChange,
  switchRef,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  checked: boolean | null;
  onCheckedChange(on: boolean): void;
  switchRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-muted text-fg-muted [&_svg]:size-4"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          {checked === null ? (
            <p className="font-medium text-base text-fg">{title}</p>
          ) : (
            <label htmlFor={id} className="cursor-pointer font-medium text-base text-fg">
              {title}
            </label>
          )}
          <p id={hintId} className="mt-0.5 text-pretty text-fg-muted text-sm">
            {hint}
          </p>
        </div>
        {checked === null ? null : (
          <Switch.Root
            id={id}
            ref={switchRef}
            checked={checked}
            onCheckedChange={onCheckedChange}
            aria-describedby={hintId}
            className="group mt-1 inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-border-strong p-0.5 transition-colors aria-checked:bg-primary"
          >
            <Switch.Thumb className="block size-5 rounded-full bg-primary-fg shadow-card transition-transform group-aria-checked:translate-x-4 motion-reduce:transition-none" />
          </Switch.Root>
        )}
      </div>
      {children ? <div className="mt-4 flex flex-col gap-4 sm:pl-11">{children}</div> : null}
    </div>
  );
}
