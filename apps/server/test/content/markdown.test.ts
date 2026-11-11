import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createGrant, type GrantMode } from '../../src/content/grants.ts';
import { type ContentHooks, contentHooks } from '../../src/content/hooks.ts';
import {
  MARKDOWN_CSS_PATH,
  MARKDOWN_RENDER_MAX_BYTES,
  renderMarkdown,
  renderMarkdownFragment,
  renderMarkdownPage,
  slugify,
} from '../../src/content/markdown.ts';
import { markdownCss } from '../../src/content/markdown-css.ts';
import { CONTENT_SANDBOX_CSP } from '../../src/content/serve.ts';
import type { UserRow } from '../../src/db/schema.ts';
import { FixedClock } from '../../src/lib/clock.ts';
import { t } from '../../src/lib/i18n.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { CONTENT_ENV, fetchContent, withContentHooks } from '../helpers/content.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('slugify', () => {
  test.each([
    ['Chụp ảnh', 'chụp-ảnh'],
    ['Chụp ảnh', 'chụp-ảnh'],
    ['Đà Nẵng', 'đà-nẵng'],
    ['Hello, World!', 'hello-world'],
    ['  many   spaces\there ', 'many-spaces-here'],
    ['snake_case and-dash 42', 'snake_case-and-dash-42'],
    ['!!!', 'section'],
    ['', 'section'],
  ])('%j is %j', (text, slug) => {
    expect(slugify(text)).toBe(slug);
  });
});

describe('renderMarkdown', () => {
  test('renders headings with ids and a table of contents', () => {
    const page = renderMarkdownPage(
      '# Báo giá\n\n## Chụp ảnh\n\n### Giá\n\n## Liên hệ\n',
      'index.md',
    );
    expect(page).toContain('<h2 id="chụp-ảnh">');
    expect(page).toMatch(
      /<nav class="pw-toc"[^>]*>.*href="#chụp-ảnh".*href="#giá".*href="#liên-hệ"/s,
    );
    expect(page).toContain('<title>Báo giá</title>');
    expect(page).toContain('<nav class="pw-toc" aria-label="Contents">');
    expect(page).toContain('<div class="pw-md">');
    expect(page).toMatch(
      /<\/nav><article class="pw-md-body">.*<\/article><\/div><\/body><\/html>$/s,
    );
  });

  test('lists the headings of every level, and h2 and h3 in the table of contents', () => {
    const { headings, title } = renderMarkdown('# One\n\n## Two\n\n#### Four\n\n### Three\n');
    expect(headings).toEqual([
      { level: 1, id: 'one', text: 'One' },
      { level: 2, id: 'two', text: 'Two' },
      { level: 4, id: 'four', text: 'Four' },
      { level: 3, id: 'three', text: 'Three' },
    ]);
    expect(title).toBe('One');
    const toc = renderMarkdownPage('## Two\n\n#### Four\n\n### Three\n', 'a.md');
    expect(toc).toContain('href="#two"');
    expect(toc).toContain('href="#three"');
    expect(toc).not.toContain('href="#four"');
  });

  test('duplicate headings get unique ids', () => {
    const { html, headings } = renderMarkdown('## A\n\n## A\n\n## A\n');
    expect(headings.map((h) => h.id)).toEqual(['a', 'a-1', 'a-2']);
    expect(html).toContain('<h2 id="a">');
    expect(html).toContain('<h2 id="a-1">');
    // Nothing carries over between documents.
    expect(renderMarkdown('## A\n').headings.map((h) => h.id)).toEqual(['a']);
  });

  test('a heading with no usable characters is a section', () => {
    expect(renderMarkdown('## ???\n\n## !!!\n').headings.map((h) => h.id)).toEqual([
      'section',
      'section-1',
    ]);
  });

  test('heading text drops markup', () => {
    const { headings, title } = renderMarkdown('# The *new* `code` [link](x.md)\n');
    expect(headings[0]?.text).toBe('The new code link');
    expect(title).toBe('The new code link');
  });

  test('no table of contents below two headings', () => {
    expect(renderMarkdownPage('# T\n\n## Only one\n\ntext\n', 'a.md')).not.toContain('pw-toc');
    expect(renderMarkdownPage('# T\n\ntext\n', 'a.md')).not.toContain('pw-toc');
    // Only h2 and h3 count.
    expect(renderMarkdownPage('## A\n\n#### B\n\n#### C\n', 'a.md')).not.toContain('pw-toc');
    expect(renderMarkdownPage('## A\n\n### B\n', 'a.md')).toContain('pw-toc');
  });

  test('table of contents entries are escaped', () => {
    const page = renderMarkdownPage('## a & "b"\n\n## c <i>d</i>\n', 'a.md');
    expect(page).toContain('<a href="#a--b">a &amp; &quot;b&quot;</a>');
    expect(page).toContain('<a href="#c-d">c d</a>');
  });

  test('highlights fenced code with known languages only', () => {
    const known = renderMarkdown('```ts\nconst x: number = 1;\n```\n').html;
    expect(known).toContain('hljs-keyword');
    expect(known).toContain('language-ts');
    const alias = renderMarkdown('```sh\necho "hi" # note\n```\n').html;
    expect(alias).toContain('hljs-');

    const unknown = renderMarkdown('```nope\n<b>bold</b> & more\n```\n').html;
    expect(unknown).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more');
    expect(unknown).not.toContain('hljs-');
    const plain = renderMarkdown('```\nconst x = 1;\n<i>\n```\n').html;
    expect(plain).toContain('&lt;i&gt;');
    expect(plain).not.toContain('hljs-');
    const indented = renderMarkdown('    const x = 1; <u>\n').html;
    expect(indented).toContain('&lt;u&gt;');
    expect(indented).not.toContain('hljs-');
  });

  test('a language name is never looked up as an object property', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const { html } = renderMarkdown(`\`\`\`${name}\n<b>x</b>\n\`\`\`\n`);
      expect(html, name).toContain('&lt;b&gt;x&lt;/b&gt;');
      expect(html, name).not.toContain('hljs-');
    }
  });

  test('raw HTML in Markdown passes through', () => {
    const { html } = renderMarkdown(
      '<details><summary>x</summary>y</details>\n\ntext <kbd>k</kbd>\n',
    );
    expect(html).toContain('<details><summary>x</summary>y</details>');
    expect(html).toContain('<kbd>k</kbd>');
  });

  test('links: bare URLs are linked, script URLs are not, relative links are untouched', () => {
    const { html } = renderMarkdown(
      'see https://example.com/a and [n](y.md) and [x](javascript:alert(1)) and ![i](img/a.png)\n',
    );
    expect(html).toContain('<a href="https://example.com/a">https://example.com/a</a>');
    expect(html).toContain('<a href="y.md">n</a>');
    expect(html).toContain('<img src="img/a.png" alt="i">');
    expect(html).not.toContain('href="javascript:');
  });

  test('does not use typographic replacements', () => {
    expect(renderMarkdown('"quoted" -- (c)\n').html).toContain('&quot;quoted&quot; -- (c)');
  });

  test('the title falls back to the file name, and is escaped', () => {
    expect(renderMarkdownPage('just text\n', 'docs/notes.md')).toContain('<title>notes.md</title>');
    expect(renderMarkdownPage('# a & "b"\n', 'x.md')).toContain(
      '<title>a &amp; &quot;b&quot;</title>',
    );
    expect(renderMarkdownPage('text\n', 'a&b.md')).toContain('<title>a&amp;b.md</title>');
    // A heading that shows no text is not a title.
    expect(renderMarkdownPage('# ![](x.png)\n\n## Real\n', 'x.md')).toContain(
      '<title>Real</title>',
    );
  });

  test('links the stylesheet relative to the page', () => {
    expect(MARKDOWN_CSS_PATH).toBe('__pinwall/markdown.css');
    expect(renderMarkdownPage('# T\n', 'index.md')).toContain(
      '<link rel="stylesheet" href="__pinwall/markdown.css">',
    );
    expect(renderMarkdownPage('# T\n', 'docs/a/b.md')).toContain(
      'href="../../__pinwall/markdown.css"',
    );
    expect(renderMarkdownPage('# T\n', 'docs/index.md')).toContain(
      'href="../__pinwall/markdown.css"',
    );
  });

  test('a whole page declares its charset, viewport and color schemes', () => {
    const page = renderMarkdownPage('# T\n', 'index.md');
    expect(page.startsWith('<!doctype html><html><head><meta charset="utf-8">')).toBe(true);
    expect(page).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(page).toContain('<meta name="color-scheme" content="light dark">');
  });

  test('a fragment is the body alone', () => {
    const fragment = renderMarkdownFragment('# T\n\n## A\n\n## B\n\ntext\n');
    expect(fragment).toContain('<h2 id="a">A</h2>');
    expect(fragment).toContain('<p>text</p>');
    expect(fragment).not.toMatch(/pw-toc|<html|<article|<nav/);
  });

  describe('size cap', () => {
    const cap = MARKDOWN_RENDER_MAX_BYTES;

    test('a source at the cap is rendered', () => {
      const src = `# Title\n\n${'a'.repeat(cap - 9)}`;
      expect(Buffer.byteLength(src)).toBe(cap);
      const { html, title } = renderMarkdown(src);
      expect(html).toContain('<h1 id="title">Title</h1>');
      expect(html).not.toContain('pw-md-notice');
      expect(title).toBe('Title');
    });

    test('a larger source is shown as preformatted text with a notice, never parsed', () => {
      const src = `# Title <b>\n\n## Part\n\n${'a'.repeat(cap)}`;
      const { html, headings, title } = renderMarkdown(src);
      expect(html.startsWith('<p class="pw-md-notice" role="note">')).toBe(true);
      expect(html).toContain(t('content.markdownTooLarge', { limit: Math.round(cap / 1000) }));
      expect(html).toContain('<pre class="pw-md-source"># Title &lt;b&gt;\n\n## Part\n\n');
      expect(html).not.toMatch(/<h[1-6]|<p>|<code/);
      expect(headings).toEqual([]);
      expect(title).toBeNull();

      const page = renderMarkdownPage(src, 'docs/big.md');
      expect(page).toContain('<title>big.md</title>');
      expect(page).not.toContain('pw-toc');
      expect(page).toContain('href="../__pinwall/markdown.css"');
      expect(renderMarkdownFragment(src)).toBe(html);
    });

    test('the cap counts bytes, not characters', () => {
      const src = 'ệ'.repeat(Math.floor(cap / 3) + 1);
      expect(src.length).toBeLessThan(cap);
      expect(renderMarkdown(src).html).toContain('pw-md-notice');
    });

    test('hostile input just under the cap is bounded by it', () => {
      // Deep nesting and unmatched openers are what make markdown-it slow.
      const hostile = [
        '['.repeat(cap),
        '*a '.repeat(cap / 3),
        '`'.repeat(cap),
        '> '.repeat(cap / 2),
        '[a](b '.repeat(cap / 6),
      ];
      for (const src of hostile) {
        const started = performance.now();
        const { html } = renderMarkdown(src.slice(0, cap));
        expect(html.length).toBeGreaterThan(0);
        expect(performance.now() - started).toBeLessThan(5000);
      }
    });
  });
});

describe('markdownCss', () => {
  test('styles the page for light and dark, tables, code and tokens', () => {
    expect(markdownCss).toContain('.pw-md');
    expect(markdownCss).toContain('.pw-toc');
    expect(markdownCss).toContain('.pw-md-body');
    expect(markdownCss).toContain('@media (prefers-color-scheme: dark)');
    expect(markdownCss).toContain('.hljs-keyword');
    expect(markdownCss).toContain('.hljs-string');
    expect(markdownCss).toContain('.hljs-comment');
    expect(markdownCss).toMatch(/\btable\b/);
  });

  test('loads nothing from anywhere', () => {
    expect(markdownCss).not.toMatch(/@import|url\(|https?:/i);
  });
});

describe.each(dialects)('Markdown pages on %s', (dialect) => {
  describe.each([
    ['single-domain', {}],
    ['content-domain', CONTENT_ENV],
  ] as const)('in %s mode', (mode, env) => {
    const single = mode === 'single-domain';
    let ctx: TestContext;
    let owner: UserRow;

    beforeEach(async () => {
      ctx = await createTestContext({
        env: { ...env },
        dialect,
        clock: new FixedClock(Date.UTC(2026, 10, 11)),
      });
      owner = (await createSignedInUser(ctx)).user;
    });
    afterEach(() => ctx.close());

    async function grantFor(files: Record<string, string | Buffer>, grantMode: GrantMode = 'raw') {
      const { version } = await publishFiles(ctx, owner, files);
      const grant = await createGrant(ctx.deps, {
        versionId: version.id,
        mode: grantMode,
        user: owner,
      });
      return { token: grant.token, version };
    }

    const get = (token: string, path: string, init: RequestInit = {}) =>
      fetchContent(ctx, token, path, init);

    test('a Markdown entry is served rendered, and ?source returns it raw', async () => {
      const { token } = await grantFor({ 'index.md': '# Hi' });
      const page = await get(token, '');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('cache-control')).toBe('private, max-age=300, no-transform');
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(page.headers.get('content-security-policy')).toBe(single ? CONTENT_SANDBOX_CSP : null);
      expect(page.headers.get('accept-ranges')).toBeNull();
      expect(page.headers.getSetCookie()).toEqual([]);
      const body = await page.text();
      expect(body).toContain('<article class="pw-md-body">');
      expect(body).toContain('<h1 id="hi">Hi</h1>');
      expect(page.headers.get('etag')).toBe(`"${sha256(body)}"`);
      expect(page.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));

      const source = await get(token, '?source');
      expect(source.status).toBe(200);
      expect(source.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(source.headers.get('etag')).toBe(`"${sha256('# Hi')}"`);
      expect(source.headers.get('accept-ranges')).toBe('bytes');
      expect(await source.text()).toBe('# Hi');
      expect(await (await get(token, 'index.md?source')).text()).toBe('# Hi');
      expect(await (await get(token, 'index.md?source=1&x=2')).text()).toBe('# Hi');
      // Any other query still renders.
      expect(await (await get(token, 'index.md?x=source')).text()).toContain('pw-md-body');
    });

    test('Vietnamese Markdown is served as UTF-8 with a BOM dropped', async () => {
      const { token } = await grantFor({ 'index.md': '﻿# Báo giá\n\n## Chụp ảnh\n\n## Liên hệ\n' });
      const body = await (await get(token, '')).text();
      expect(body).toContain('<title>Báo giá</title>');
      expect(body).toContain('<h2 id="chụp-ảnh">');
      expect(body).toContain('<h1 id="báo-giá">');
    });

    test('any .md file is served as a page', async () => {
      const { token } = await grantFor({
        'index.html': '<p>root</p>',
        'docs/x.md': '# X\n\n[n](y.md)\n',
        'docs/y.md': '# Y',
        'NOTES.MD': '# Notes',
      });
      const x = await get(token, 'docs/x.md');
      expect(x.status).toBe(200);
      expect(x.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const body = await x.text();
      expect(body).toContain('<a href="y.md">n</a>');
      expect(body).toContain('href="../__pinwall/markdown.css"');
      expect(await (await get(token, 'docs/y.md')).text()).toContain('<h1 id="y">Y</h1>');
      expect(await (await get(token, 'NOTES.MD')).text()).toContain('<h1 id="notes">Notes</h1>');
      expect(await (await get(token, 'docs/x.md?source')).text()).toBe('# X\n\n[n](y.md)\n');
      // Pages other than Markdown are untouched.
      expect(await (await get(token, 'index.html')).text()).toBe('<p>root</p>');
    });

    test('the stylesheet link reaches markdown.css from every page', async () => {
      const { token } = await grantFor({
        'index.html': '<p>root</p>',
        'a.md': '# A',
        'docs/index.md': '# Docs',
        'docs/deep/b.md': '# B',
      });
      for (const [path, href] of [
        ['a.md', '__pinwall/markdown.css'],
        ['docs/', '../__pinwall/markdown.css'],
        ['docs/index.md', '../__pinwall/markdown.css'],
        ['docs/deep/b.md', '../../__pinwall/markdown.css'],
      ] as const) {
        const body = await (await get(token, path)).text();
        expect(body, path).toContain(`<link rel="stylesheet" href="${href}">`);
        // Resolved the way a browser does from the page's URL, it names a file of the grant.
        const page = path.endsWith('/') ? `${path}x` : path;
        const resolved = posix.normalize(posix.join(posix.dirname(page), href));
        expect(resolved, path).toBe(MARKDOWN_CSS_PATH);
        expect((await get(token, resolved)).status, path).toBe(200);
      }
    });

    test('an entry in a folder, served at the root, links the stylesheet from the root', async () => {
      // One wrapping folder is stripped on publish, so the entry keeps `sub/`.
      const { token, version } = await grantFor({ 'docs/sub/only.md': '# Only' });
      expect(version.entry_path).toBe('sub/only.md');
      const body = await (await get(token, '')).text();
      expect(body).toContain('<title>Only</title>');
      expect(body).toContain('<link rel="stylesheet" href="__pinwall/markdown.css">');
      expect((await get(token, MARKDOWN_CSS_PATH)).status).toBe(200);
      const bare = await grantFor({ 'docs/sub/plain.md': 'no heading' });
      expect(await (await get(bare.token, '')).text()).toContain('<title>plain.md</title>');
    });

    test('a directory index in Markdown is served as a page', async () => {
      const { token } = await grantFor({ 'index.html': 'root', 'md/index.md': '# In dir' });
      const redirect = await get(token, 'md');
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get('location')).toBe('md/');
      const page = await get(token, 'md/');
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await page.text()).toContain('<h1 id="in-dir">In dir</h1>');
    });

    test('markdown.css is served from __pinwall', async () => {
      const { token } = await grantFor({ 'index.md': '# Hi' });
      const r = await get(token, MARKDOWN_CSS_PATH);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/css; charset=utf-8');
      expect(r.headers.get('cache-control')).toBe('private, max-age=300, no-transform');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toBe(single ? CONTENT_SANDBOX_CSP : null);
      expect(r.headers.getSetCookie()).toEqual([]);
      const css = await r.text();
      expect(css).toContain('.pw-md');
      expect(css).toContain('@media (prefers-color-scheme: dark)');
      expect(css).toBe(markdownCss);
      expect(contentHooks.reservedAssets?.['markdown.css']?.contentType).toBe(
        'text/css; charset=utf-8',
      );
      expect((await get(token, '__pinwall/other.css')).status).toBe(404);
    });

    test('a rendered page has no ranges and honors If-None-Match and HEAD', async () => {
      const { token } = await grantFor({ 'index.md': '# Hi\n\ntext' });
      const page = await get(token, '');
      const body = await page.text();
      const etag = page.headers.get('etag');
      expect(etag).toBe(`"${sha256(body)}"`);

      const ranged = await get(token, '', { headers: { range: 'bytes=0-9' } });
      expect(ranged.status).toBe(200);
      expect(await ranged.text()).toBe(body);

      for (const value of [etag ?? '', `W/${etag}`, '*']) {
        const same = await get(token, '', { headers: { 'if-none-match': value } });
        expect(same.status, value).toBe(304);
        expect(same.headers.get('etag')).toBe(etag);
        expect(await same.text()).toBe('');
      }
      const other = await get(token, '', { headers: { 'if-none-match': '"other"' } });
      expect(other.status).toBe(200);

      const head = await get(token, '', { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('etag')).toBe(etag);
      expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
      expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await head.text()).toBe('');
    });

    test('raw HTML in a served page is kept', async () => {
      const { token } = await grantFor({
        'index.md': '<details><summary>x</summary>y</details>\n',
      });
      expect(await (await get(token, '')).text()).toContain(
        '<details><summary>x</summary>y</details>',
      );
    });

    test('a Markdown file over the cap is served as preformatted text with a notice', async () => {
      const big = `# Big <b>\n\n${'line\n'.repeat(MARKDOWN_RENDER_MAX_BYTES / 4)}`;
      const { token } = await grantFor({ 'index.md': big });
      const page = await get(token, '');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const body = await page.text();
      expect(body).toContain('<p class="pw-md-notice" role="note">');
      expect(body).toContain('<pre class="pw-md-source"># Big &lt;b&gt;');
      expect(body).not.toContain('<h1');
      expect(page.headers.get('etag')).toBe(`"${sha256(body)}"`);
      // The source itself is still there for ?source.
      expect(await (await get(token, '?source')).text()).toBe(big);
    });

    test('a review grant passes the rendered page through transformReviewHtml, a raw grant does not', async () => {
      const seen: { html: string; path: string; baseUrl: string }[] = [];
      const hooks: ContentHooks = {
        ...contentHooks,
        transformReviewHtml: (html, { path, baseUrl }) => {
          seen.push({ html: html.toString(), path, baseUrl });
          return Buffer.from(html.toString().replace('</body>', '<!--annotated--></body>'));
        },
      };
      const hooked = withContentHooks(ctx, hooks);
      const files = { 'index.html': '<p>root</p>', 'docs/a.md': '# A\n\ntext' };

      const review = await grantFor(files, 'review');
      const page = await fetchContent(hooked, review.token, 'docs/a.md');
      const body = await page.text();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.path).toBe('docs/a.md');
      expect(seen[0]?.html).toContain('<article class="pw-md-body">');
      expect(seen[0]?.html).not.toContain('<!--annotated-->');
      expect(seen[0]?.baseUrl).toContain(review.token);
      expect(body).toContain('<!--annotated--></body>');
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('etag')).toBe(`"${sha256(body)}"`);
      expect(page.headers.get('accept-ranges')).toBeNull();

      // ?source is the stored file, never transformed.
      const source = await fetchContent(hooked, review.token, 'docs/a.md?source');
      expect(await source.text()).toBe('# A\n\ntext');
      expect(seen).toHaveLength(1);

      const raw = await grantFor(files, 'raw');
      const plain = await fetchContent(hooked, raw.token, 'docs/a.md');
      expect(await plain.text()).not.toContain('<!--annotated-->');
      expect(seen).toHaveLength(1);
    });
  });
});
