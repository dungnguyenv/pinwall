import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import { t } from '../lib/i18n.ts';
import { RESERVED_DIR } from '../publish/paths.ts';
import { highlightCode } from './syntax-highlight.js';

/** Where a page finds the stylesheet, relative to the root of the grant it is served in. */
export const MARKDOWN_CSS_PATH = `${RESERVED_DIR}/markdown.css`;

/**
 * Markdown above this many bytes is shown as plain text, not rendered. Rendering is synchronous
 * and markdown-it needs up to ~2.6 µs per byte on hostile input (unmatched `![` and `[`), so this
 * keeps one render under about half a second.
 */
export const MARKDOWN_RENDER_MAX_BYTES = 200_000;

export interface Heading {
  level: number;
  id: string;
  text: string;
}

/** The table of contents lists these levels, and only when there are at least `TOC_MIN` of them. */
const TOC_LEVELS = new Set([2, 3]);
const TOC_MIN = 2;

/**
 * The id of a heading: NFC, lower case, whitespace as `-`, and nothing but letters, digits, `-`
 * and `_` besides (so `Chụp ảnh!` is `chụp-ảnh`). A heading with no such character is `section`.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
  return slug === '' ? 'section' : slug;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/** Highlights a fenced block in a language highlight.js knows; any other block is escaped. */
function highlight(code: string, language: string): string {
  try {
    const highlighted = highlightCode(code, language);
    if (highlighted !== null) return highlighted;
  } catch {
    // The block is shown plain rather than failing the whole page.
  }
  return escapeHtml(code);
}

/**
 * Raw HTML passes through: the page is served inside the grant's sandbox or on its own content
 * host, exactly like an HTML artifact. Heading ids come from `slugify`, made unique per document
 * by markdown-it-anchor (`a`, `a-1`, `a-2`).
 */
const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false, highlight });
markdown.use(anchor, { slugify, tabIndex: false });

/**
 * The headings of a parsed document in order. markdown-it-anchor has given each its id by the
 * time `parse` returns; the text is what the heading shows, without markup.
 */
function headingsOf(tokens: ReturnType<typeof markdown.parse>): Heading[] {
  const headings: Heading[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') return;
    const id = token.attrGet('id');
    const inline = tokens[index + 1];
    if (typeof id !== 'string' || inline === undefined) return;
    const text = (inline.children ?? [])
      .filter((child) => child.type === 'text' || child.type === 'code_inline')
      .map((child) => child.content)
      .join('')
      .trim();
    headings.push({ level: Number(token.tag.slice(1)), id, text });
  });
  return headings;
}

/**
 * Renders Markdown to HTML. `title` is the text of the first heading, whatever its level, or null
 * when the document has none. A source over `MARKDOWN_RENDER_MAX_BYTES` is not parsed: its html
 * is a notice and the source as preformatted text, with no headings and no title.
 */
export function renderMarkdown(src: string): {
  html: string;
  headings: Heading[];
  title: string | null;
} {
  if (Buffer.byteLength(src) > MARKDOWN_RENDER_MAX_BYTES) {
    const notice = t('content.markdownTooLarge', {
      limit: Math.round(MARKDOWN_RENDER_MAX_BYTES / 1000),
    });
    const html =
      `<p class="pw-md-notice" role="note">${escapeHtml(notice)}</p>` +
      `<pre class="pw-md-source">${escapeHtml(src)}</pre>`;
    return { html, headings: [], title: null };
  }
  const env = {};
  const tokens = markdown.parse(src, env);
  const html = markdown.renderer.render(tokens, markdown.options, env);
  const headings = headingsOf(tokens);
  const title = headings.find((heading) => heading.text !== '')?.text ?? null;
  return { html, headings, title };
}

/** The body of a rendered document without a table of contents (the rendered diff shows blocks). */
export function renderMarkdownFragment(src: string): string {
  return renderMarkdown(src).html;
}

function renderToc(headings: readonly Heading[]): string {
  const entries = headings.filter((heading) => TOC_LEVELS.has(heading.level));
  if (entries.length < TOC_MIN) return '';
  const items = entries
    .map(
      (heading) =>
        `<li class="pw-toc-h${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join('');
  return `<nav class="pw-toc" aria-label="${escapeHtml(t('content.markdownContents'))}"><ul>${items}</ul></nav>`;
}

/**
 * A whole HTML document for a Markdown file. `pagePath` is the path the page is requested at,
 * relative to the grant's root: it sets how many directories the stylesheet link climbs, and its
 * last segment is the title of a document with no heading.
 */
export function renderMarkdownPage(src: string, pagePath: string): string {
  const { html, headings, title } = renderMarkdown(src);
  const segments = pagePath.split('/');
  const stylesheet = `${'../'.repeat(segments.length - 1)}${MARKDOWN_CSS_PATH}`;
  const pageTitle = title ?? segments.at(-1) ?? '';
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    `<title>${escapeHtml(pageTitle)}</title>` +
    `<link rel="stylesheet" href="${escapeHtml(stylesheet)}"></head>` +
    `<body><div class="pw-md">${renderToc(headings)}<article class="pw-md-body">${html}</article></div></body></html>`
  );
}
