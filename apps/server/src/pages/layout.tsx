import type { Child } from 'hono/jsx';
import type { HtmlEscapedString } from 'hono/utils/html';
import { t } from '../lib/i18n.ts';
import { PAGES_CSS_HREF } from './pages.css.ts';

/** The document every server-rendered page shares: one centered panel, styles from pages.css. */
export function Layout(props: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex" />
        <title>{`${props.title} · ${t('app.name')}`}</title>
        <link rel="stylesheet" href={PAGES_CSS_HREF} />
      </head>
      <body>
        <main class="pw-page">
          <div class="pw-panel">{props.children}</div>
        </main>
      </body>
    </html>
  );
}

/** Renders a page element (`JSX.Element`) to a complete HTML document. Pages are synchronous. */
export function renderDocument(element: HtmlEscapedString | Promise<HtmlEscapedString>): string {
  // An async component anywhere in the tree turns the markup into a promise.
  const markup: unknown = element instanceof Promise ? element : element.toString();
  if (typeof markup !== 'string') throw new Error('Server-rendered pages must be synchronous.');
  return `<!doctype html>${markup}`;
}
