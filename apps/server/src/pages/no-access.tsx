import { t } from '../lib/i18n.ts';
import { Layout, renderDocument } from './layout.tsx';

export interface NoAccessPageProps {
  /** The IdP's display name. */
  idp: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  /** Restarts the sign-in with the IdP's account chooser. */
  switchHref: string;
  /** This sign-in already asked the IdP to choose an account. */
  retried: boolean;
  requestId: string;
}

/**
 * The page for an IdP sign-in without access: who signed in, and a way to use another account.
 * The name and email come from the IdP and are escaped like every other value.
 */
export function renderNoAccessPage(p: NoAccessPageProps): string {
  const title = t('oidc.noAccess.title');
  return renderDocument(
    <Layout title={title}>
      <h1 class="pw-title">{title}</h1>
      <p class="pw-lead">{t('oidc.noAccess.signedInAs', { idp: p.idp })}</p>
      <div class="pw-identity">
        <p class="pw-identity-name">{p.name}</p>
        <p class="pw-identity-email">
          {p.email ?? t('oidc.noAccess.noEmail')}
          {p.email !== null && !p.emailVerified && (
            <span class="pw-tag">{t('oidc.noAccess.unverified')}</span>
          )}
        </p>
      </div>
      <p class="pw-message">{t('oidc.noAccess.message')}</p>
      <nav class="pw-actions">
        <a class="pw-button pw-button-primary" href={p.switchHref}>
          {t('oidc.noAccess.switch')}
        </a>
      </nav>
      {p.retried && <p class="pw-hint">{t('oidc.noAccess.retryHint', { idp: p.idp })}</p>}
      <p class="pw-meta">
        {t('error.requestId')} <code>{p.requestId}</code>
      </p>
    </Layout>,
  );
}
