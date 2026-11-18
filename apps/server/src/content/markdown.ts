import MarkdownIt, { type Token } from 'markdown-it';
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
 * The text a heading's id is made from: its text and code spans, joined, as markdown-it-anchor
 * read it.
 */
function headingText(inline: Token | undefined): string {
  return (inline?.children ?? [])
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('');
}

/**
 * Gives every heading an `id`: `slugify` of its text, made unique in the document by the first
 * free suffix `-1`, `-2`, … (`a`, `a-1`, `a-2`). These are the ids markdown-it-anchor 10 gave
 * (with `slugify` and `tabIndex: false`) when it made them, and comments (`#id` paths) and links
 * name them, so they must not change.
 *
 * The plugin tried every suffix from `-1` again for each repeat of a heading, and looked each
 * heading up in the whole token list again, so a document of repeated headings took quadratic
 * time. Here each base remembers the suffix it reached: an id once taken is never freed, so the
 * first free suffix is never below it, and the answer is the plugin's in linear time. `taken` is a
 * plain object, as the plugin's was: `__proto__` cannot be stored in one, so a heading slugged
 * `__proto__` repeats as it did.
 */
function headingIds(state: { tokens: Token[] }): void {
  const taken: Record<string, true> = {};
  const next = new Map<string, number>();
  const { tokens } = state;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.type !== 'heading_open') continue;
    const base = slugify(headingText(tokens[index + 1]));
    let id = base;
    if (Object.hasOwn(taken, id)) {
      let suffix = next.get(base) ?? 1;
      while (Object.hasOwn(taken, `${base}-${suffix}`)) suffix++;
      next.set(base, suffix + 1);
      id = `${base}-${suffix}`;
    }
    taken[id] = true;
    token.attrSet('id', id);
  }
}

/**
 * Raw HTML passes through: the page is served inside the grant's sandbox or on its own content
 * host, exactly like an HTML artifact. Headings get ids from `headingIds`, after every other rule.
 */
const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false, highlight });
markdown.core.ruler.push('heading_ids', headingIds);

/** The attribute that names a block's source lines, `{first}-{last}` from 1, under `sourceLines`. */
const SOURCE_LINES = 'data-pw-lines';

// A fenced block puts its token's attributes on its `<code>`; with source lines its `<pre>` names
// them too, so the block's outer element finds its lines. Without them the block is as it was.
const renderFence = markdown.renderer.rules.fence;
if (renderFence !== undefined) {
  markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
    const html = renderFence(tokens, index, options, env, self);
    const lines = tokens[index]?.attrGet(SOURCE_LINES) ?? null;
    return lines === null || !html.startsWith('<pre>')
      ? html
      : `<pre ${SOURCE_LINES}="${lines}">${html.slice('<pre>'.length)}`;
  };
}

/** A line that holds nothing but blank space. */
const BLANK_LINE = /^[ \t]*$/;

/**
 * Gives every block token of `src` that opens an element, or is one (a fence, an indented code
 * block, a rule), the source lines markdown-it mapped it to, as `SOURCE_LINES`, without the blank
 * lines that end a list or its last item. The attribute is added to elements the page has anyway,
 * so the element structure a selector path counts stays the same.
 */
function markSourceLines(src: string, tokens: Token[]): void {
  // markdown-it counts lines as it splits them: at CRLF, CR or LF.
  const lines = src.split(/\r\n?|\n/);
  for (const token of tokens) {
    if (!token.block || token.map === null || token.nesting === -1) continue;
    const [first, end] = token.map;
    let last = end;
    while (last > first + 1 && BLANK_LINE.test(lines[last - 1] ?? '')) last--;
    token.attrSet(SOURCE_LINES, `${first + 1}-${last}`);
  }
}

/**
 * The headings of a parsed document in order. `headingIds` has given each its id by the time
 * `parse` returns; the text is what the heading shows, without markup.
 */
function headingsOf(tokens: ReturnType<typeof markdown.parse>): Heading[] {
  const headings: Heading[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'heading_open') return;
    const id = token.attrGet('id');
    const inline = tokens[index + 1];
    if (typeof id !== 'string' || inline === undefined) return;
    headings.push({ level: Number(token.tag.slice(1)), id, text: headingText(inline).trim() });
  });
  return headings;
}

/**
 * Renders Markdown to HTML. `title` is the text of the first heading, whatever its level, or null
 * when the document has none. A source over `MARKDOWN_RENDER_MAX_BYTES` is not parsed: its html
 * is a notice and the source as preformatted text, with no headings and no title. With
 * `sourceLines`, each block names its source lines (`markSourceLines`).
 */
export function renderMarkdown(
  src: string,
  sourceLines = false,
): {
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
  if (sourceLines) markSourceLines(src, tokens);
  const html = markdown.renderer.render(tokens, markdown.options, env);
  const headings = headingsOf(tokens);
  const title = headings.find((heading) => heading.text !== '')?.text ?? null;
  return { html, headings, title };
}

/** The body of a rendered document without a table of contents (the rendered diff shows blocks). */
export function renderMarkdownFragment(src: string): string {
  return renderMarkdown(src).html;
}

/** One top-level block of a document: its source lines and what they render to. */
export interface MarkdownBlock {
  source: string;
  html: string;
}

/**
 * The top-level blocks of a document, in order: a paragraph, a heading, a whole list, quote,
 * table or fence, a rule, an HTML block. `source` is the block's own lines, line endings as `\n`
 * and trailing blank space dropped. The document is parsed once, so a reference link in one block
 * resolves against a definition anywhere, and its html is what the same block shows in
 * `renderMarkdown`. Reference definitions are not blocks. A source over `MARKDOWN_RENDER_MAX_BYTES`
 * is not parsed: it is one block holding the notice `renderMarkdown` gives.
 */
export function renderMarkdownBlocks(src: string): MarkdownBlock[] {
  if (Buffer.byteLength(src) > MARKDOWN_RENDER_MAX_BYTES) {
    return [{ source: src, html: renderMarkdown(src).html }];
  }
  // markdown-it numbers the lines of the text it normalizes, so split that text.
  const text = src.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const env = {};
  const tokens = markdown.parse(text, env);
  const blocks: MarkdownBlock[] = [];
  let start = 0;
  while (start < tokens.length) {
    const first = tokens[start];
    if (first === undefined) break;
    // A block is one token (a fence, a rule), or runs from its `_open` to the `_close` that
    // comes back to level 0.
    let end = start;
    if (first.nesting === 1) {
      while (end < tokens.length && !(tokens[end]?.nesting === -1 && tokens[end]?.level === 0)) {
        end += 1;
      }
    }
    const [from, to] = first.map ?? [0, 0];
    blocks.push({
      source: lines.slice(from, to).join('\n').trimEnd(),
      html: markdown.renderer.render(tokens.slice(start, end + 1), markdown.options, env),
    });
    start = end + 1;
  }
  return blocks;
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
 * last segment is the title of a document with no heading. With `sourceLines`, each block of the
 * article names its source lines in a `data-pw-lines` attribute (`{first}-{last}`, from 1), for
 * locating comments (`locate.ts`); the page is otherwise the one served.
 */
export function renderMarkdownPage(
  src: string,
  pagePath: string,
  o: { sourceLines?: boolean } = {},
): string {
  const { html, headings, title } = renderMarkdown(src, o.sourceLines === true);
  return pageDocument(
    pagePath,
    title,
    `${renderToc(headings)}<article class="pw-md-body">${html}</article>`,
  );
}

/**
 * The page served for a Markdown file over `MARKDOWN_RENDER_MAX_BYTES`, made without reading the
 * file: a notice and a link to the stored file. The link is `?source`, relative to the page's own
 * URL, so it names the same file at the grant's root, at a directory and at the file's path.
 * `pagePath` is as for `renderMarkdownPage`; its last segment is the title.
 */
export function renderMarkdownTooLargePage(pagePath: string): string {
  const notice = t('content.markdownTooLargePage', { limit: MARKDOWN_RENDER_MAX_BYTES / 1000 });
  const body =
    `<article class="pw-md-body"><p class="pw-md-notice" role="note">${escapeHtml(notice)} ` +
    `<a href="?source">${escapeHtml(t('content.markdownSource'))}</a></p></article>`;
  return pageDocument(pagePath, null, body);
}

/** The document around a page's body: its title (else the last segment of `pagePath`) and stylesheet. */
function pageDocument(pagePath: string, title: string | null, body: string): string {
  const segments = pagePath.split('/');
  const stylesheet = `${'../'.repeat(segments.length - 1)}${MARKDOWN_CSS_PATH}`;
  const pageTitle = title ?? segments.at(-1) ?? '';
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    `<title>${escapeHtml(pageTitle)}</title>` +
    `<link rel="stylesheet" href="${escapeHtml(stylesheet)}"></head>` +
    `<body><div class="pw-md">${body}</div></body></html>`
  );
}
