import { t } from '../lib/i18n.ts';
import { Layout, renderDocument } from './layout.tsx';

export interface ErrorPageProps {
  status: number;
  title: string;
  message: string;
  requestId: string;
  /** Links shown as buttons; the first is the primary one. */
  actions?: { label: string; href: string }[];
}

/**
 * A complete HTML error page for people: status, title, message, optional links and the request
 * id to report. It shows only what it is given, so never pass internal error details.
 */
export function renderErrorPage(p: ErrorPageProps): string {
  const actions = p.actions ?? [];
  return renderDocument(
    <Layout title={p.title}>
      <p class="pw-status">{p.status}</p>
      <h1 class="pw-title">{p.title}</h1>
      <p class="pw-message">{p.message}</p>
      {actions.length > 0 && (
        <nav class="pw-actions">
          {actions.map((action, index) => (
            <a class={index === 0 ? 'pw-button pw-button-primary' : 'pw-button'} href={action.href}>
              {action.label}
            </a>
          ))}
        </nav>
      )}
      <p class="pw-meta">
        {t('error.requestId')} <code>{p.requestId}</code>
      </p>
    </Layout>,
  );
}
