import { CornerDownLeft, TimerOff } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router';
import { errorMessage, isApiError } from '../../api/client.ts';
import type { OAuthConsentRequest } from '../../api/dto.ts';
import { decideConsent, useConsentRequest } from '../../api/oauth.ts';
import { useSignOut } from '../../api/session.ts';
import { browser } from '../../lib/navigation.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { Avatar, Button, ErrorState } from '../../ui/index.ts';
import { AuthLayout, AuthNotice, AuthPageFallback, FormAlert } from '../auth/auth-layout.tsx';

/** A request that is gone for good: unknown (404), or expired or already answered (410). */
function hasEnded(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 410);
}

/**
 * URL schemes that would run script or open a page of their own in this
 * origin's tab rather than hand the answer to the app. The server builds
 * `redirect_to` from the client's registered redirect URI; this is a second
 * line behind its checks.
 */
const UNFOLLOWABLE = new Set(['javascript:', 'data:', 'vbscript:', 'blob:', 'file:']);

function canFollow(url: string): boolean {
  try {
    return !UNFOLLOWABLE.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Why the request cannot go on, in the server's words, and what to do instead. */
function Ended({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <AuthLayout title={t('web.consent.endedTitle')} wide>
      <AuthNotice icon={<TimerOff />} tone="danger">
        <span>{message}</span>
        <span className="mt-2 block text-base text-fg-muted">{t('web.consent.restart')}</span>
      </AuthNotice>
    </AuthLayout>
  );
}

type Choice = 'allow' | 'deny';

/**
 * The question itself: who asks, what it may do, where the answer goes and
 * for whom, then Deny or Allow. Neither button has focus at first, so a stray
 * Enter answers nothing. One press decides: both buttons stay disabled from
 * then on, and the browser follows the `redirect_to` the server returns.
 */
function ConsentCard({
  id,
  request,
  onEnded,
}: {
  id: string;
  request: OAuthConsentRequest;
  onEnded(message: string): void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const signOut = useSignOut({ returnTo: location.pathname + location.search });
  const [pending, setPending] = useState<Choice | null>(null);
  // The server took the answer; `leaving` once the browser is on its way back.
  const [answered, setAnswered] = useState<{ choice: Choice; leaving: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set at once, unlike state, so a double click sends one decision.
  const busy = useRef(false);

  const client = request.client_name;
  const host = request.redirect_host;
  const { name, email } = request.user;

  async function decide(choice: Choice) {
    if (busy.current) return;
    busy.current = true;
    setPending(choice);
    setError(null);
    try {
      const { redirect_to } = await decideConsent(id, choice === 'allow');
      const leaving = canFollow(redirect_to);
      setAnswered({ choice, leaving });
      if (leaving) browser.assign(redirect_to);
      else setError(t('web.consent.unsafeRedirect'));
    } catch (caught) {
      if (hasEnded(caught)) {
        onEnded(errorMessage(caught, t));
        return;
      }
      setError(errorMessage(caught, t));
      // A failure that may pass: the person can answer again.
      busy.current = false;
    } finally {
      setPending(null);
    }
  }

  const locked = pending !== null || answered !== null;
  const leaving = answered?.leaving ? answered.choice : null;

  return (
    <AuthLayout title={t('web.consent.title', { client })} wide>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <p className="text-pretty text-base text-fg-muted">{t('web.consent.access')}</p>
          {request.scopes.length > 0 ? (
            <ul aria-label={t('web.consent.scopes')} className="flex flex-wrap gap-1.5">
              {request.scopes.map((scope) => (
                <li key={scope} className="min-w-0">
                  <code className="block rounded-sm bg-surface-muted px-1.5 py-0.5 font-mono text-fg-muted text-xs wrap-anywhere">
                    {scope}
                  </code>
                </li>
              ))}
            </ul>
          ) : null}
          {request.client_uri ? (
            <p className="text-fg-muted text-sm wrap-anywhere">
              {t('web.consent.clientUri', { uri: request.client_uri })}
            </p>
          ) : null}
        </div>

        <p className="flex items-start gap-3 rounded-lg border border-border-strong bg-surface-muted px-4 py-3.5 font-medium text-fg text-md wrap-anywhere">
          <CornerDownLeft aria-hidden="true" className="mt-1 size-4 shrink-0 text-fg-muted" />
          <span className="min-w-0">{t('web.consent.returnsTo', { host })}</span>
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Avatar name={name} size="sm" />
          <p className="min-w-0 flex-1 basis-48 text-fg-muted text-sm wrap-anywhere">
            {email === null
              ? t('web.consent.signedInAs', { name })
              : t('web.consent.signedInAsEmail', { name, email })}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={locked || signOut.isPending}
            onClick={() =>
              signOut.mutate(undefined, { onError: (caught) => setError(errorMessage(caught, t)) })
            }
          >
            {t('web.consent.notYou')}
          </Button>
        </div>

        {error ? <FormAlert>{error}</FormAlert> : null}

        <div className="grid grid-cols-2 gap-3">
          <Button
            variant="secondary"
            size="lg"
            disabled={locked}
            loading={pending === 'deny'}
            onClick={() => void decide('deny')}
          >
            {t('web.consent.deny')}
          </Button>
          <Button
            size="lg"
            disabled={locked}
            loading={pending === 'allow'}
            onClick={() => void decide('allow')}
          >
            {t('web.consent.allow')}
          </Button>
        </div>

        <p role="status" className={leaving ? 'text-pretty text-fg-muted text-sm' : 'sr-only'}>
          {leaving === 'allow' ? t('web.consent.allowed', { client, host }) : null}
          {leaving === 'deny' ? t('web.consent.denied', { client, host }) : null}
        </p>
      </div>
    </AuthLayout>
  );
}

function Consent({ id }: { id: string }) {
  const { t } = useTranslation();
  const request = useConsentRequest(id);
  const [ended, setEnded] = useState<string | null>(null);

  if (ended !== null) return <Ended message={ended} />;
  if (request.isPending) return <AuthPageFallback wide />;
  if (request.isError) {
    if (hasEnded(request.error)) return <Ended message={errorMessage(request.error, t)} />;
    return (
      <AuthLayout title={t('web.consent.pageTitle')} wide>
        <ErrorState
          compact
          message={errorMessage(request.error, t)}
          onRetry={() => void request.refetch()}
        />
      </AuthLayout>
    );
  }
  return <ConsentCard id={id} request={request.data} onEnded={setEnded} />;
}

/**
 * `/oauth/consent?request=<id>`, where Pinwall's OAuth server sends a person
 * to let an agent act as them. Shown without the shell, after sign-in.
 */
export function ConsentPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.consent.pageTitle'));
  const [params] = useSearchParams();
  const id = params.get('request');
  if (!id) return <Ended message={t('web.consent.noRequest')} />;
  return <Consent key={id} id={id} />;
}
