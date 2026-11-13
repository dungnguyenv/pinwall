import { t } from '../lib/i18n.ts';
import { abuseHref } from '../pages/error-page.tsx';

/** Why a content response has no file to show; `framed_only`: a top-level load of a framed-only grant. */
export type ContentErrorKind = 'not_found' | 'gone' | 'expired' | 'error' | 'framed_only';

const COPY: Record<ContentErrorKind, string> = {
  not_found: 'content.notFound',
  gone: 'content.gone',
  expired: 'content.expired',
  error: 'content.error',
  framed_only: 'content.framedOnly',
};

const STYLE = [
  ':root{color-scheme:light dark;--fg:#1f1f1f;--muted:#5f5f5f;--bg:#fff}',
  '@media (prefers-color-scheme:dark){:root{--fg:#ececec;--muted:#a3a3a3;--bg:#1e1e1e}}',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);',
  'color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
  'main{max-width:28rem;padding:2rem 1.5rem;text-align:center}',
  'h1{margin:0 0 .5rem;font-size:1.25rem;font-weight:600}',
  'p{margin:0;color:var(--muted)}',
].join('');

/** What the abuse line adds to `STYLE`; a page without the line keeps the 1.0 style. */
const ABUSE_STYLE = '.pw-meta{margin-top:1.5rem;font-size:.875rem}a{color:inherit}';

/** The kinds that say a link is missing or ended: the ones a person may want to report. */
const REPORTABLE: readonly ContentErrorKind[] = ['not_found', 'gone', 'expired'];

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page a content response shows when it has no file to show. Self-contained (inline style,
 * no script, image or font, and a link only for `abuseContact`), so it renders the same inside the
 * sandbox and on a content host, and asks nothing of any origin. With an `abuseContact`, the pages
 * that say a link is missing or ended (not found, gone, expired) tell where to report abuse; with
 * none, or for another kind, the page is the same as without it.
 */
export function renderContentErrorPage(
  kind: ContentErrorKind,
  abuseContact: string | null = null,
): string {
  const title = escapeHtml(t(`${COPY[kind]}.title`));
  const message = escapeHtml(t(`${COPY[kind]}.message`));
  const report = abuseContact !== null && REPORTABLE.includes(kind);
  const abuse = report
    ? `<p class="pw-meta">${escapeHtml(t('pages.reportAbuse'))} ` +
      `<a href="${escapeHtml(abuseHref(abuseContact))}">${escapeHtml(abuseContact)}</a></p>`
    : '';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title><style>${STYLE}${report ? ABUSE_STYLE : ''}</style></head>` +
    `<body><main><h1>${title}</h1><p>${message}</p>${abuse}</main></body></html>`
  );
}
