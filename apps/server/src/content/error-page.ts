import { t } from '../lib/i18n.ts';

export type ContentErrorKind = 'not_found' | 'gone' | 'expired' | 'error';

const COPY: Record<ContentErrorKind, string> = {
  not_found: 'content.notFound',
  gone: 'content.gone',
  expired: 'content.expired',
  error: 'content.error',
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page a content response shows when it has no file to show. Self-contained (inline style,
 * no script, image, link or font), so it renders the same inside the sandbox and on a content
 * host, and asks nothing of any origin.
 */
export function renderContentErrorPage(kind: ContentErrorKind): string {
  const title = escapeHtml(t(`${COPY[kind]}.title`));
  const message = escapeHtml(t(`${COPY[kind]}.message`));
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`
  );
}
