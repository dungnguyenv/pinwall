import type { CommentThread } from '@pinwall/shared';
import type { Anchor, Quote } from '@pinwall/shared/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  LOCATE_MAX_BYTES,
  locateInHtml,
  locateInMarkdown,
  locateThreads,
} from '../../src/content/locate.ts';
import { MARKDOWN_RENDER_MAX_BYTES } from '../../src/content/markdown.ts';
import type { UserRow, VersionRow } from '../../src/db/schema.ts';
import { createThread } from '../../src/domain/comments.ts';
import { createSignedInUser } from '../helpers/auth.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';
import { publishFiles } from '../helpers/publish.ts';

const base = { page: '', position: { x: 0.1, y: 0.2 }, viewport: { width: 1280 } };
const elementAnchorAt = (path: string, page = ''): Anchor => ({
  ...base,
  page,
  kind: 'element',
  dom: { path },
});
const textAnchor = (quote: Quote, page = ''): Anchor => ({ ...base, page, kind: 'text', quote });
const pointAnchor = (page = ''): Anchor => ({ ...base, page, kind: 'point' });

/** Line 1 opens the body, line 3 the table, lines 4 to 8 are its rows. */
const page = [
  '<html><body>',
  '<h1 id="t0">Kế hoạch</h1>',
  '<table id="t">',
  ...[1, 2, 3, 4, 5].map((i) => `<tr><td>row ${i}</td></tr>`),
  '</table>',
  '</body></html>',
].join('\n');
const row5 = '#t > tbody > tr:nth-of-type(5) > td';

describe('locateInHtml', () => {
  test('an element path through an implicit tbody finds row 5', () => {
    expect(locateInHtml(page, elementAnchorAt(row5))).toEqual({
      start: 8,
      end: 8,
      unverified: false,
    });
    // From body, and with a tbody the source writes.
    expect(locateInHtml(page, elementAnchorAt('body > table > tbody > tr:nth-of-type(2)'))).toEqual(
      { start: 5, end: 5, unverified: false },
    );
    const explicit = page.replace('<table id="t">', '<table id="t"><tbody>');
    expect(locateInHtml(explicit, elementAnchorAt(row5))).toMatchObject({ start: 8 });
    // A table has one implicit tbody, not two.
    expect(
      locateInHtml(page, elementAnchorAt('#t > tbody:nth-of-type(2) > tr:nth-of-type(5)')),
    ).toBe('not_found');
  });

  test('a text quote maps to its source line', () => {
    expect(
      locateInHtml(page, textAnchor({ exact: 'row 3', prefix: 'row 2 ', suffix: ' row 4' })),
    ).toMatchObject({ start: 6 });
    // A quote across lines spans them, and is never unverified.
    expect(
      locateInHtml(page, textAnchor({ exact: 'row 2 row 3', prefix: 'row 1 ', suffix: '' })),
    ).toEqual({ start: 5, end: 6, unverified: false });
    // The page's text is as the browser shows it: entities decoded.
    const entities = '<body>\n<p>Tom</p>\n<p>Tom &amp; Jerry</p>\n</body>';
    expect(
      locateInHtml(entities, textAnchor({ exact: 'Tom & Jerry', prefix: 'Tom ', suffix: '' })),
    ).toEqual({ start: 3, end: 3, unverified: false });
  });

  test('a page without <body> walks from the document', () => {
    const bare = '<h1>A</h1>\n<p>one</p>\n<p>two</p>\n';
    expect(locateInHtml(bare, elementAnchorAt('body > p:nth-of-type(2)'))).toEqual({
      start: 3,
      end: 3,
      unverified: false,
    });
    expect(
      locateInHtml(bare, textAnchor({ exact: 'two', prefix: 'one ', suffix: '' })),
    ).toMatchObject({ start: 3 });
    // An <html> without a <body>: the browser puts what follows the head in the body.
    const wrapped = '<html><head><title>x</title></head>\n<p>one</p>\n<p>two</p></html>';
    expect(locateInHtml(wrapped, elementAnchorAt('body > p:nth-of-type(2)'))).toEqual({
      start: 3,
      end: 3,
      unverified: false,
    });
  });

  test('element locations on a page with a script are unverified; text ones are not', () => {
    const quote = textAnchor({ exact: 'row 3', prefix: 'row 2 ', suffix: ' row 4' });
    for (const script of [
      '<script>document.title = "x";</script>',
      '<script src="app.js"></script>',
      '<script type="module">import "./app.js";</script>',
      '<script type="text/template"><p>row 9</p></script>',
    ]) {
      const scripted = page.replace('<html>', `<html><head>${script}</head>`);
      expect(locateInHtml(scripted, elementAnchorAt(row5)), script).toEqual({
        start: 8,
        end: 8,
        unverified: true,
      });
      expect(locateInHtml(scripted, quote), script).toEqual({
        start: 6,
        end: 6,
        unverified: false,
      });
    }
    // Scripts that hold data run nothing.
    for (const type of ['application/json', 'application/ld+json', 'importmap', ' ImportMap ']) {
      const data = page.replace('</body>', `<script type="${type}">{}</script></body>`);
      expect(locateInHtml(data, elementAnchorAt(row5)), type).toMatchObject({ unverified: false });
    }
  });

  test('a path past the last sibling is not_found', () => {
    expect(locateInHtml(page, elementAnchorAt('#t > tbody > tr:nth-of-type(6) > td'))).toBe(
      'not_found',
    );
    // A missing id, a step whose name is not unique, a child that is not there.
    expect(locateInHtml(page, elementAnchorAt('#nope > td'))).toBe('not_found');
    expect(locateInHtml(page, elementAnchorAt('#t > tbody > tr'))).toBe('not_found');
    expect(locateInHtml(page, elementAnchorAt('body > main'))).toBe('not_found');
    // The body itself, and a selector the annotator never writes.
    expect(locateInHtml(page, elementAnchorAt('body'))).toBe('not_found');
    expect(locateInHtml(page, elementAnchorAt('main > .hero'))).toBe('not_found');
    // A quote that is not on the page.
    expect(locateInHtml(page, textAnchor({ exact: 'row 9', prefix: '', suffix: '' }))).toBe(
      'not_found',
    );
  });

  test('a point anchor is not located', () => {
    expect(locateInHtml(page, pointAnchor())).toBeNull();
  });

  test('a minified one-line page gives line 1', () => {
    const minified = page.replaceAll('\n', '');
    expect(locateInHtml(minified, elementAnchorAt(row5))).toEqual({
      start: 1,
      end: 1,
      unverified: false,
    });
  });

  test('ids and names are read as the annotator escapes them', () => {
    const html = '<body>\n<p id="1st">a</p>\n<p id="a.b">b</p>\n<x-card.v2>c</x-card.v2>\n</body>';
    expect(locateInHtml(html, elementAnchorAt(String.raw`#\31 st`))).toMatchObject({ start: 2 });
    expect(locateInHtml(html, elementAnchorAt(String.raw`#a\.b`))).toMatchObject({ start: 3 });
    expect(locateInHtml(html, elementAnchorAt(String.raw`body > x-card\.v2`))).toMatchObject({
      start: 4,
    });
  });

  test('an element spans the lines from its start tag to its end tag', () => {
    const html = '<body>\n<section>\n  <p>a</p>\n</section>\n<ul>\n<li>one\n<li>two\n</ul></body>';
    expect(locateInHtml(html, elementAnchorAt('body > section'))).toEqual({
      start: 2,
      end: 4,
      unverified: false,
    });
    // An end the source leaves out ends with the element's last content.
    expect(locateInHtml(html, elementAnchorAt('body > ul > li:nth-of-type(1)'))).toEqual({
      start: 6,
      end: 6,
      unverified: false,
    });
  });

  test('what the browser does not show as page text or as children is left out', () => {
    const html = [
      '<body>',
      '<script>var row = "row 3";</script><style>p::after { content: "row 3" }</style>',
      '<template><p>row 3</p></template><noscript><p>row 3</p></noscript>',
      '<textarea>row 3</textarea>',
      '<p>row 3</p>',
      '</body>',
    ].join('\n');
    expect(locateInHtml(html, textAnchor({ exact: 'row 3', prefix: '', suffix: '' }))).toEqual({
      start: 5,
      end: 5,
      unverified: false,
    });
    // The <p> of the template and of noscript are not the body's children.
    expect(locateInHtml(html, elementAnchorAt('body > p'))).toMatchObject({ start: 5 });
  });

  test('elements after </body> are the body’s, as the browser parses them', () => {
    const html = '<html><body>\n<p>a</p>\n</body>\n<p>b</p>\n</html>';
    expect(locateInHtml(html, elementAnchorAt('body > p:nth-of-type(2)'))).toMatchObject({
      start: 4,
    });
  });
});

describe('locateInMarkdown', () => {
  test('a Markdown heading anchor maps to its source line', () => {
    const src = '# A\n\nPara one.\n\n## B\n\nPara two.\n';
    expect(
      locateInMarkdown(
        src,
        'index.md',
        textAnchor({ exact: 'Para two.', prefix: 'B ', suffix: '' }),
      ),
    ).toEqual({ start: 7, end: 7 });
    expect(locateInMarkdown(src, 'index.md', elementAnchorAt('#b'))).toEqual({ start: 5, end: 5 });
  });

  /** Two level-2 headings, so the served page has a table of contents before the article. */
  const doc = [
    '# Guide', // 1
    '',
    '## Install', // 3
    '',
    '- one', // 5
    '- two', // 6
    '',
    '```js', // 8
    'const x = 1;',
    '```', // 10
    '',
    '## Prices', // 12
    '',
    '| Plan | Price |', // 14
    '| --- | --- |',
    '| Basic | 10 |', // 16
    '| Pro | 20 |', // 17
    '',
  ].join('\r\n');
  const article = 'body > div > article';

  test('element paths walk the page as it is served', () => {
    const at = (path: string) => locateInMarkdown(doc, 'docs/guide.md', elementAnchorAt(path));
    expect(at('#install')).toEqual({ start: 3, end: 3 });
    expect(at(`${article} > ul > li:nth-of-type(2)`)).toMatchObject({ start: 6 });
    expect(at(`${article} > pre`)).toEqual({ start: 8, end: 10 });
    expect(at(`${article} > pre > code`)).toEqual({ start: 8, end: 10 });
    expect(at(`${article} > table > tbody > tr:nth-of-type(2) > td:nth-of-type(2)`)).toEqual({
      start: 17,
      end: 17,
    });
    // The table of contents is not in the source.
    expect(at('body > div > nav')).toBe('not_found');
    expect(at(`${article} > p`)).toBe('not_found');
  });

  test('a quote is found in the text the served page shows', () => {
    const at = (quote: Quote) => locateInMarkdown(doc, 'docs/guide.md', textAnchor(quote));
    expect(at({ exact: 'Prices', prefix: 'const x = 1;\n', suffix: '\nPlan' })).toEqual({
      start: 12,
      end: 12,
    });
    expect(at({ exact: 'Basic', prefix: 'Price\n', suffix: '' })).toEqual({ start: 16, end: 16 });
    // The same word in the table of contents.
    expect(at({ exact: 'Prices', prefix: 'Install', suffix: 'Guide' })).toBe('not_found');
  });

  test('a byte order mark changes no line', () => {
    expect(locateInMarkdown(`\uFEFF${doc}`, 'guide.md', elementAnchorAt('#install'))).toEqual({
      start: 3,
      end: 3,
    });
  });

  test('a document of repeated headings is located in linear time', () => {
    const src = '# a\n\n'.repeat(39_800);
    const started = performance.now();
    expect(locateInMarkdown(src, 'index.md', elementAnchorAt('#a-39799'))).toEqual({
      start: 79_599,
      end: 79_599,
    });
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test('a point anchor, and a document served unrendered, are not located', () => {
    expect(locateInMarkdown(doc, 'guide.md', pointAnchor())).toBeNull();
    const big = `# Big\n\n${'word '.repeat(MARKDOWN_RENDER_MAX_BYTES / 5)}\n`;
    expect(locateInMarkdown(big, 'guide.md', elementAnchorAt('#big'))).toBeNull();
  });
});

describe.each(dialects)('locateThreads on %s', (dialect) => {
  /** A Markdown document whose `## Prices` is on line 3. */
  const notes = '# Notes\n\n## Prices\n\nSome text.\n';
  let ctx: TestContext;
  let ada: UserRow;

  beforeEach(async () => {
    ctx = await createTestContext({ dialect });
    ada = (await createSignedInUser(ctx, { kind: 'oidc', name: 'Ada' })).user;
  });
  afterEach(async () => {
    await ctx.close();
  });

  /** Publishes `files` and opens a thread on the new version for each anchor, in order. */
  async function threadsOn(
    files: Record<string, string | Buffer>,
    anchors: Anchor[],
  ): Promise<{ version: VersionRow; threads: CommentThread[] }> {
    const { artifact, version } = await publishFiles(ctx, ada, files);
    const threads: CommentThread[] = [];
    for (const anchor of anchors) {
      threads.push(
        await createThread(ctx.deps, { kind: 'member', user: ada }, artifact.id, {
          body: 'Sửa',
          anchor,
          versionId: null,
        }),
      );
    }
    return { version, threads };
  }

  test('each thread gets its file, lines and snippet', async () => {
    const docs = '<!doctype html>\n<body>\n<h1>Docs</h1>\n<p>Xem\n  Bảng giá\n  mới</p>\n</body>\n';
    const { version, threads } = await threadsOn({ 'index.html': page, 'docs/index.html': docs }, [
      elementAnchorAt(row5),
      textAnchor({ exact: 'Bảng giá', prefix: 'Xem ', suffix: ' mới' }, 'docs/'),
      elementAnchorAt('body > section'),
      pointAnchor(),
      textAnchor({ exact: 'x', prefix: '', suffix: '' }, 'gone/'),
    ]);
    const [row, quote, missing, point, gone] = threads.map((th) => th.id);
    const located = await locateThreads(ctx.deps, version, threads, ada);
    expect(located.get(row ?? '')).toEqual({
      path: 'index.html',
      start: 8,
      end: 8,
      snippet: ['<tr><td>row 5</td></tr>'],
      unverified: false,
    });
    expect(located.get(quote ?? '')).toEqual({
      path: 'docs/index.html',
      start: 5,
      end: 5,
      snippet: ['  Bảng giá'],
      unverified: false,
    });
    expect(located.get(missing ?? '')).toBe('not_found');
    expect(located.get(point ?? '')).toBeNull();
    expect(located.get(gone ?? '')).toBe('not_found');
  });

  test('a snippet is at most 3 lines from the start, as data', async () => {
    const html = [
      '<body>',
      '<section>',
      '  <p>one\u001b[2J\u2028two\tthree</p>',
      '  <p>four</p>',
      '  <p>five</p>',
      '</section>',
      '</body>',
    ].join('\r\n');
    const { version, threads } = await threadsOn({ 'index.html': html }, [
      elementAnchorAt('body > section'),
    ]);
    expect(
      (await locateThreads(ctx.deps, version, threads, ada)).get(threads[0]?.id ?? ''),
    ).toEqual({
      path: 'index.html',
      start: 2,
      end: 6,
      snippet: ['<section>', '  <p>one[2J two\tthree</p>', '  <p>four</p>'],
      unverified: false,
    });
  });

  test('a minified one-line page gives line 1 and a snippet of 160 characters', async () => {
    const filler = '<p>filler</p>'.repeat(40);
    const minified = `<!doctype html><html><head><title>x</title></head><body>${filler}<p id="x">target ${'y'.repeat(300)}</p></body></html>`;
    const { version, threads } = await threadsOn({ 'index.html': minified }, [
      elementAnchorAt('#x'),
    ]);
    const at = (await locateThreads(ctx.deps, version, threads, ada)).get(threads[0]?.id ?? '');
    expect(at).toMatchObject({ path: 'index.html', start: 1, end: 1 });
    const [line] = typeof at === 'object' && at !== null ? at.snippet : [];
    // The line is shown from the element, with a mark at each end where text was left out.
    expect(line).toHaveLength(160);
    expect(line).toMatch(/^…<p id="x">target y+…$/);
  });

  test('Markdown pages are located in the page they are served as', async () => {
    const { version, threads } = await threadsOn({ 'notes.md': notes }, [
      elementAnchorAt('#prices', 'notes.md'),
      elementAnchorAt('#prices', ''),
    ]);
    const located = await locateThreads(ctx.deps, version, threads, ada);
    for (const th of threads) {
      expect(located.get(th.id)).toEqual({
        path: 'notes.md',
        start: 3,
        end: 3,
        snippet: ['## Prices'],
        unverified: false,
      });
    }
  });

  test('files that are not pages, not text or too large are not located', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const huge = `<body><p id="x">x</p>${' '.repeat(LOCATE_MAX_BYTES)}</body>`;
    const { version, threads } = await threadsOn(
      { 'index.html': page, 'logo.png': png, 'style.css': 'p {}', 'huge.html': huge },
      [
        textAnchor({ exact: 'x', prefix: '', suffix: '' }, 'logo.png'),
        textAnchor({ exact: 'p', prefix: '', suffix: '' }, 'style.css'),
        elementAnchorAt('#x', 'huge.html'),
      ],
    );
    const located = await locateThreads(ctx.deps, version, threads, ada);
    expect(threads.map((th) => located.get(th.id))).toEqual([null, null, null]);
  });

  test('one call reads a bounded amount of Markdown', async () => {
    // Three documents of 190 KB: the third would take the call past its Markdown budget.
    const big = `## Prices\n\n${'Lorem ipsum dolor sit amet.\n'.repeat(190_000 / 28)}`;
    const files = { 'index.html': page, 'a.md': big, 'b.md': big, 'c.md': big };
    const { version, threads } = await threadsOn(files, [
      elementAnchorAt('#prices', 'a.md'),
      elementAnchorAt('#prices', 'b.md'),
      elementAnchorAt('#prices', 'c.md'),
    ]);
    const located = await locateThreads(ctx.deps, version, threads, ada);
    expect(threads.map((th) => located.get(th.id))).toEqual([
      expect.objectContaining({ path: 'a.md', start: 1 }),
      expect.objectContaining({ path: 'b.md', start: 1 }),
      null,
    ]);
  });

  test('each file is read once, however many threads it has', async () => {
    const { version, threads } = await threadsOn({ 'index.html': page }, [
      elementAnchorAt(row5),
      elementAnchorAt('#t0'),
      textAnchor({ exact: 'row 1', prefix: '', suffix: '' }),
    ]);
    const get = vi.spyOn(ctx.deps.blobs, 'get');
    const located = await locateThreads(ctx.deps, version, threads, ada);
    expect(threads.map((th) => (located.get(th.id) as { start: number }).start)).toEqual([8, 2, 4]);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
