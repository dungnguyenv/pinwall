import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  extractMetadata,
  extractVersionText,
  HTML_MAX_ATTRIBUTES,
  MARKDOWN_BUDGET_BYTES,
  MARKDOWN_MAX_BYTES,
  MAX_WARNINGS,
  type MetadataFile,
  resolveRef,
  SCAN_BUDGET_BYTES,
  SCAN_MAX_BYTES,
  SEARCH_TEXT_MAX_CHARS,
} from '../../src/content/metadata.ts';
import { contentTypeFor } from '../../src/content/mime.ts';
import { t } from '../../src/lib/i18n.ts';
import { newId } from '../../src/lib/ids.ts';
import { createTestContext, type TestContext } from '../helpers/context.ts';
import { dialects } from '../helpers/db.ts';

/** Builds the files of a version from a path → content record; paths get their usual type. */
function files(record: Record<string, string | Buffer>): MetadataFile[] {
  return Object.entries(record).map(([path, body]) => {
    const bytes = Buffer.from(body);
    return { path, contentType: contentTypeFor(path), size: bytes.length, read: async () => bytes };
  });
}

/** No unpaired surrogate: a string that survives being encoded as UTF-8 unchanged. */
const wellFormed = (text: string) =>
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

const html = (body: string, entry = 'index.html') =>
  extractMetadata(files({ [entry]: body }), entry);

/**
 * A small entry and five pages, each a word and a root-absolute link followed by more than
 * `SCAN_MAX_BYTES` of comment: the budget runs out inside p4.html, so p5.html is never read.
 */
function budgetSite(): Record<string, string> {
  const site: Record<string, string> = { 'index.html': '<title>T</title>' };
  for (let n = 1; n <= 5; n++) {
    site[`p${n}.html`] =
      `<p>word${n}</p><a href="/abs${n}">x</a><!--${'x'.repeat(SCAN_MAX_BYTES)}-->`;
  }
  return site;
}

/**
 * An entry and six Markdown pages of 300 KB, each a word and blank lines: the per-file cap cuts
 * every page, and the Markdown budget runs out inside the third, so the fourth on are not read.
 */
function markdownBudgetSite(): Record<string, string> {
  const site: Record<string, string> = { 'index.html': '<p>entry</p>' };
  for (let n = 1; n <= 6; n++) site[`p${n}.md`] = `word${n}\n${'\n'.repeat(300_000)}`;
  return site;
}

/** A tag with `count` distinct attributes (about 7 bytes each), then a paragraph after it. */
function attributeFlood(count: number): string {
  const names = Array.from({ length: count }, (_, i) => `a${i}`).join(' ');
  return `<p>before</p><a ${names}><p>after</p>`;
}

describe('title', () => {
  test('title from <title>, else the first heading', async () => {
    expect((await html('<title> Bảng  giá </title><h1>Other</h1>')).title).toBe('Bảng giá');
    expect((await html('<h2>Hi <b>there</b></h2><h1>Later</h1>')).title).toBe('Hi there');
    expect((await html('<p>no heading</p>')).title).toBeNull();
  });

  test('an empty <title> falls through to the heading', async () => {
    expect((await html('<title>  </title><h1>Heading</h1>')).title).toBe('Heading');
    expect((await html('<h1> </h1><h2>Second</h2>')).title).toBe('Second');
  });

  test('a <title> inside inline SVG is not the page title', async () => {
    expect((await html('<svg><title>Icon</title></svg><h1>Real</h1>')).title).toBe('Real');
  });

  test('entities are decoded and the title is NFC', async () => {
    const m = await html('<title>Tom &amp; Jerry café</title>');
    expect(m.title).toBe('Tom & Jerry café');
  });

  test('markdown title from the first heading', async () => {
    const m = await extractMetadata(
      files({ 'index.md': 'intro\n\n## Báo cáo *quý*\n\n# Later\n' }),
      'index.md',
    );
    expect(m.title).toBe('Báo cáo quý');
  });

  test('titles are capped at 200 characters', async () => {
    expect((await html(`<title>${'x'.repeat(500)}</title>`)).title).toHaveLength(200);
    expect((await html(`<title>${'😀'.repeat(300)}</title>`)).title).toBe('😀'.repeat(200));
    const md = await extractMetadata(files({ 'a.md': `# ${'y'.repeat(500)}` }), 'a.md');
    expect(md.title).toHaveLength(200);
  });

  test('control characters never reach the title', async () => {
    expect((await html('<title>a\u0000b\u0007c</title>')).title).toBe('a b c');
  });

  test('only the entry names the version', async () => {
    const m = await extractMetadata(
      files({ 'index.html': '<p>x</p>', 'other.html': '<title>Other</title>' }),
      'index.html',
    );
    expect(m.title).toBeNull();
  });
});

describe('theme color', () => {
  const color = async (content: string) =>
    (await html(`<meta name="theme-color" content="${content}">`)).themeColor;

  test('is kept only when it looks like a color', async () => {
    expect(await color('#0ea5e9')).toBe('#0ea5e9');
    expect(await color('rebeccapurple')).toBe('rebeccapurple');
    expect(await color('rgb(1, 2, 3)')).toBe('rgb(1, 2, 3)');
    expect(await color(' hsl(10 20% 30%) ')).toBe('hsl(10 20% 30%)');
    expect(await color('hsla(10, 20%, 30%, 0.5)')).toBe('hsla(10, 20%, 30%, 0.5)');
    expect(await color('red;background:url(x)')).toBeNull();
    expect(await color('url(x)')).toBeNull();
    expect(await color('#12')).toBeNull();
    expect(await color(`rgb(${'1,'.repeat(40)}1)`)).toBeNull();
    const md = await extractMetadata(files({ 'a.md': '# T' }), 'a.md');
    expect(md.themeColor).toBeNull();
  });

  test('only the first theme-color tag counts, and the name is case-insensitive', async () => {
    const bad = await html(
      '<meta name="theme-color" content="no(pe)"><meta name="theme-color" content="#fff">',
    );
    expect(bad.themeColor).toBeNull();
    expect((await html('<META NAME="Theme-Color" CONTENT="#fff">')).themeColor).toBe('#fff');
  });
});

describe('thumbnail', () => {
  test('from og:image, then the first image, raster only', async () => {
    const entry = (head: string) => `<html><head>${head}</head><body></body></html>`;
    const withFiles = (head: string, extra: Record<string, string>) =>
      extractMetadata(files({ 'index.html': entry(head), ...extra }), 'index.html');

    expect(
      (
        await withFiles('<meta property="og:image" content="img/cover.png">', {
          'img/cover.png': '',
        })
      ).thumbnailPath,
    ).toBe('img/cover.png');
    expect(
      (await withFiles('<meta name="og:image" content="img/cover.png">', { 'img/cover.png': '' }))
        .thumbnailPath,
    ).toBe('img/cover.png');
    expect(
      (
        await withFiles(
          '<meta property="og:image" content="https://cdn.example/x.png"><img src="a%20b.jpg">',
          { 'a b.jpg': '' },
        )
      ).thumbnailPath,
    ).toBe('a b.jpg');
    expect(
      (await withFiles('<img src="logo.svg">', { 'logo.svg': '<svg/>' })).thumbnailPath,
    ).toBeNull();
    // A cover that is not in the version falls through to the first image that is.
    expect(
      (
        await withFiles('<meta property="og:image" content="missing.png"><img src="here.webp">', {
          'here.webp': '',
        })
      ).thumbnailPath,
    ).toBe('here.webp');
  });

  test('the first usable image wins, not the first image tag', async () => {
    const m = await extractMetadata(
      files({
        'index.html':
          '<img src="logo.svg"><img src="https://x.example/a.png"><img src="photo.jpg">',
        'logo.svg': '<svg/>',
        'photo.jpg': '',
      }),
      'index.html',
    );
    expect(m.thumbnailPath).toBe('photo.jpg');
  });

  test('a file that is not a raster image is not a thumbnail whatever its name', async () => {
    const m = await extractMetadata(
      [
        ...files({ 'index.html': '<img src="photo.jpg">' }),
        {
          path: 'photo.jpg',
          contentType: 'text/plain',
          size: 0,
          read: async () => Buffer.alloc(0),
        },
      ],
      'index.html',
    );
    expect(m.thumbnailPath).toBeNull();
  });

  test('paths resolve relative to the entry', async () => {
    const at = (src: string) =>
      extractMetadata(
        files({ 'docs/index.html': `<img src="${src}">`, 'img/x.webp': '', 'x.png': '' }),
        'docs/index.html',
      );
    expect((await at('../img/x.webp')).thumbnailPath).toBe('img/x.webp');
    expect((await at('../../x.png')).thumbnailPath).toBeNull();
    expect((await at('/x.png')).thumbnailPath).toBeNull();
    expect((await at('../x.png?v=2#top')).thumbnailPath).toBe('x.png');
  });

  test('macOS names: NFD in a link finds the NFC file, percent-encoded or not', async () => {
    const stored = 'ảnh đẹp.png'.normalize('NFC');
    const at = (src: string) =>
      extractMetadata(files({ 'index.html': `<img src="${src}">`, [stored]: '' }), 'index.html');
    expect((await at(encodeURIComponent(stored))).thumbnailPath).toBe(stored);
    expect((await at(stored.normalize('NFD'))).thumbnailPath).toBe(stored);
    expect((await at(encodeURIComponent(stored.normalize('NFD')))).thumbnailPath).toBe(stored);
  });

  test('markdown thumbnail is the first image', async () => {
    const m = await extractMetadata(
      files({
        'index.md': 'text ![a](pics/one.png) and ![b](pics/two.png)',
        'pics/one.png': '',
        'pics/two.png': '',
      }),
      'index.md',
    );
    expect(m.thumbnailPath).toBe('pics/one.png');
  });

  test('markdown images with non-ASCII names are found', async () => {
    const stored = 'hình/ảnh đẹp.png'.normalize('NFC');
    const m = await extractMetadata(
      files({ 'index.md': '![ảnh](hình/ảnh đẹp.png)\n\n![x](<hình/ảnh đẹp.png>)', [stored]: '' }),
      'index.md',
    );
    expect(m.thumbnailPath).toBe(stored);
  });
});

describe('search text', () => {
  test('skips scripts, styles and templates, spans pages and is capped', async () => {
    const m = await extractMetadata(
      files({
        'index.html':
          '<p>Dịch vụ chụp ảnh</p><script>var secret=1</script><style>.x{}</style><template>tmpl</template>',
        'b.md': '# Giá',
      }),
      'index.html',
    );
    expect(m.text).toContain('chụp ảnh');
    expect(m.text).toContain('Giá');
    expect(m.text).not.toContain('secret');
    expect(m.text).not.toContain('.x{');
    expect(m.text).not.toContain('tmpl');
    // The entry's text comes first.
    expect(m.text.indexOf('chụp')).toBeLessThan(m.text.indexOf('Giá'));

    const long = await html(`<p>${'word '.repeat(60_000)}</p>`);
    expect(long.text).toHaveLength(SEARCH_TEXT_MAX_CHARS);
    const spread = await extractMetadata(
      files({ 'index.html': `<p>${'a '.repeat(120_000)}</p>`, 'z.md': 'tail '.repeat(100_000) }),
      'index.html',
    );
    expect(spread.text).toHaveLength(SEARCH_TEXT_MAX_CHARS);
    expect(spread.text).not.toContain('tail');
  });

  test('other pages come in path order after the entry', async () => {
    const m = await extractMetadata(
      files({
        'z.html': 'zeta',
        'a.md': 'alpha',
        'docs/index.html': 'entry',
        'b.htm': 'beta',
        'c.css': 'cssword',
      }),
      'docs/index.html',
    );
    expect(m.text).toBe('entry alpha beta zeta');
  });

  test('whitespace collapses; block boundaries split words, inline ones do not', async () => {
    expect((await html('<p>a \n\t b</p>\n\n<p>c</p>')).text).toBe('a b c');
    expect((await html('<table><tr><td>Gi</td><td>á</td></tr></table>')).text).toBe('Gi á');
    expect((await html('<b>Gi</b>á <i>trị</i>')).text).toBe('Giá trị');
    expect(
      (
        await html(
          '<nav><a href="a.html">Trang chủ</a><a href="b.html">Bảng giá</a><span>x</span></nav>',
        )
      ).text,
    ).toBe('Trang chủ Bảng giá x');
    expect((await html('a<br>b')).text).toBe('a b');
  });

  test('entities are decoded; control characters become spaces', async () => {
    expect((await html('<p>Tom &amp; Jerry&nbsp;&#x41;</p>')).text).toBe('Tom & Jerry A');
    expect((await html('<p>a\u0000b\u001fc</p>')).text).toBe('a b c');
  });

  test('markdown text covers text, inline code and fences, not markup or html tags', async () => {
    const m = await extractMetadata(
      files({
        'a.md':
          '# Head\n\nSome *emphasis* and `inline_code` here.\n\n```js\nconst fenced = 1;\n```\n\n    indented\n\n[link text](http://x.example/u)\n\n- item one\n- item two\n',
      }),
      'a.md',
    );
    expect(m.text).toBe(
      'Head Some emphasis and inline_code here. const fenced = 1; indented link text item one item two',
    );
  });

  test('the text of a version counts only its own files and html/htm/md ones', async () => {
    const m = await extractMetadata(
      files({
        'index.html': 'page',
        'data.json': '{"secret":1}',
        'x.txt': 'plain',
        'a.js': 'code()',
      }),
      'index.html',
    );
    expect(m.text).toBe('page');
  });
});

describe('root-absolute URL warnings', () => {
  test('are raised once per file and URL', async () => {
    const m = await extractMetadata(
      files({
        'index.html':
          '<link href="/x.css"><img src="/x.css"><a href="//cdn.example/x"><img srcset="/a.png 1x, b.png 2x">',
        'style.css': 'body{background:url(/bg.png)} @import "/base.css";',
      }),
      'index.html',
    );
    expect(m.warnings.map((w) => [w.file, w.url])).toEqual([
      ['index.html', '/x.css'],
      ['index.html', '/a.png'],
      ['style.css', '/bg.png'],
      ['style.css', '/base.css'],
    ]);
    expect(m.warnings[0]?.code).toBe('root_absolute_url');
    expect(m.warnings[0]?.message).toBe(
      t('publish.warning.rootAbsolute', { file: 'index.html', url: '/x.css' }),
    );
  });

  test('the same URL in two files is two warnings', async () => {
    const m = await extractMetadata(
      files({ 'index.html': '<img src="/x.png">', 'sub/page.html': '<img src="/x.png">' }),
      'index.html',
    );
    expect(m.warnings.map((w) => w.file)).toEqual(['index.html', 'sub/page.html']);
  });

  test('every URL attribute is checked, and relative or external ones are not', async () => {
    const m = await extractMetadata(
      files({
        'index.html': [
          '<a href="/a">',
          '<img src="/b">',
          '<form action="/c" ><button formaction="/d">',
          '<video poster="/e"><object data="/f">',
          '<a href=" /g">',
          '<a href="/\\h">',
          '<a href="\\i">',
          '<a href="rel/i"><a href="./j"><a href="../k"><a href="#/l"><a href="?q=/m">',
          '<a href="//n.example/x"><a href="\\\\o.example/x"><a href="https://p.example/x"><a href="data:text/plain,/q">',
          '<a title="/r"><a href="">',
        ].join(''),
      }),
      'index.html',
    );
    expect(m.warnings.map((w) => w.url)).toEqual(['/a', '/b', '/c', '/d', '/e', '/f', '/g', '\\i']);
  });

  test('srcset candidates are parsed one by one', async () => {
    const m = await extractMetadata(
      files({
        'index.html':
          '<img srcset="  /a.png 1x,/b.png 2x , c.png 3x, /d.png,,  /e.png  100w"><img srcset="data:image/png;base64,AAAA 1x, /f.png 2x">',
      }),
      'index.html',
    );
    expect(m.warnings.map((w) => w.url)).toEqual([
      '/a.png',
      '/b.png',
      '/d.png',
      '/e.png',
      '/f.png',
    ]);
  });

  test('<style> content and .css files are scanned like CSS', async () => {
    const css = [
      'a{background:url(/one.png)}',
      "b{background:url( '/two.png' )}",
      'c{background:URL("/three.png")}',
      '@import "/four.css";',
      "@IMPORT url('/five.css');",
      "@import '/six.css' screen;",
      'd{background:url(rel.png) url(//cdn.example/x.png) url(data:image/png;base64,/9j/4AAQ)}',
      '/* url(/commented.png) */',
      'e{content:"url(/in-a-string.png)"}',
      'f{background:url(/seven.png)}',
      'g{background:curl(/not-a-url.png)}',
    ].join('\n');
    const m = await extractMetadata(
      files({ 'index.html': `<style>${css}</style>`, 'css/site.css': css }),
      'index.html',
    );
    const expected = [
      '/one.png',
      '/two.png',
      '/three.png',
      '/four.css',
      '/five.css',
      '/six.css',
      '/seven.png',
    ];
    expect(m.warnings.filter((w) => w.file === 'index.html').map((w) => w.url)).toEqual(expected);
    expect(m.warnings.filter((w) => w.file === 'css/site.css').map((w) => w.url)).toEqual(expected);
  });

  test('at most 50 warnings', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `<img src="/img/${i}.png">`).join('');
    const m = await html(many);
    expect(m.warnings).toHaveLength(MAX_WARNINGS);
    expect(m.warnings[0]?.url).toBe('/img/0.png');
    expect(m.warnings.at(-1)?.url).toBe('/img/49.png');

    const spread = await extractMetadata(
      files({
        'index.html': many,
        'a.css': 'a{background:url(/css.png)}',
        'z.html': '<img src="/z.png">',
      }),
      'index.html',
    );
    expect(spread.warnings).toHaveLength(MAX_WARNINGS);
  });

  test('a long URL is cut in the warning and the message quotes at most 100 characters', async () => {
    const url = `/${'u'.repeat(5000)}`;
    const m = await html(`<img src="${url}">`);
    expect(m.warnings).toHaveLength(1);
    const warning = m.warnings[0];
    expect(warning?.url.length).toBeLessThanOrEqual(201);
    expect(warning?.url.endsWith('…')).toBe(true);
    expect(warning?.message.length).toBeLessThan(300);
    expect(warning?.message).toContain(`/${'u'.repeat(99)}…`);
    expect(warning?.message).not.toContain('u'.repeat(101));
  });

  test('a markdown entry has no warnings; its other pages are not scanned', async () => {
    const m = await extractMetadata(files({ 'index.md': '![x](/x.png) [y](/y)' }), 'index.md');
    expect(m.warnings).toEqual([]);
  });
});

describe('untrusted input never throws and stays bounded', () => {
  test('broken markup', async () => {
    const broken = [
      '<<<>>><div <p a=">text',
      '<a href=/x.png title=><img src=>',
      '<!-- never closed <title>t</title>',
      '<script>never closed <h1>x</h1>',
      '<title>never closed <p>body',
      '</p></div></b></br></form>',
      '<![CDATA[ x ]]><?php echo 1 ?><!DOCTYPE>',
      '<h1><h2><h3>unclosed headings',
      '<form><form><form>',
      '&#xD800;&#0;&#x110000;&bogus;&amp',
      '<img src="a',
      '\u0000\u0001<\u0000>',
    ];
    for (const source of broken) {
      const m = await html(source);
      expect(m.warnings.length).toBeLessThanOrEqual(MAX_WARNINGS);
      expect(m.text.length).toBeLessThanOrEqual(SEARCH_TEXT_MAX_CHARS);
    }
    expect((await html('<a href=/x.png title=>')).warnings.map((w) => w.url)).toEqual(['/x.png']);
    expect((await html('<h1><h2><h3>unclosed headings')).title).toBe('unclosed headings');
  });

  test('bytes that are not UTF-8', async () => {
    const bytes = Buffer.concat([
      Buffer.from('<title>Gi\xe1 </title><p>'),
      Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xe2, 0x82, 0x00, 0xf0, 0x9f]),
      Buffer.from('</p>'),
    ]);
    const m = await extractMetadata(files({ 'index.html': bytes }), 'index.html');
    expect(typeof m.title).toBe('string');
    expect(m.text).toContain('�');
    // Lone surrogates would make a later INSERT fail on Postgres.
    expect(wellFormed(m.text)).toBe(true);
    expect(wellFormed(m.title ?? '')).toBe(true);
    const md = await extractMetadata(
      files({ 'a.md': Buffer.from([0xff, 0xfe, 0x23, 0x20, 0xc3]) }),
      'a.md',
    );
    expect(wellFormed(md.text)).toBe(true);
  });

  test('a byte-order mark does not leak into the title or text', async () => {
    const m = await extractMetadata(
      files({
        'index.html': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<h1>Hi</h1>')]),
      }),
      'index.html',
    );
    expect(m.title).toBe('Hi');
    expect(m.text).toBe('Hi');
  });

  test('a 5 MB attribute value', async () => {
    const started = performance.now();
    const m = await html(
      `<title>T</title><img src="${'x'.repeat(2_000_000)}"><a href="/${'y'.repeat(2_000_000)}">`,
    );
    expect(m.title).toBe('T');
    expect(m.warnings).toHaveLength(1);
    expect(m.warnings[0]?.url.length).toBeLessThanOrEqual(201);
    // A value that runs past the scan limit is cut mid-attribute.
    const cut = await html(`<title>T</title><img src="${'x'.repeat(SCAN_MAX_BYTES * 2)}">`);
    expect(cut.title).toBe('T');
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test('a million unclosed tags does not make the parser quadratic', async () => {
    const started = performance.now();
    const m = await html(
      `<title>Kept</title><p>before</p>${'<div>'.repeat(1_000_000)}<p>after</p>`,
    );
    expect(m.title).toBe('Kept');
    expect(m.text).toContain('before');
    expect(performance.now() - started).toBeLessThan(3000);
    const spans = await html(`${'<span>'.repeat(500_000)}x`);
    expect(spans.title).toBeNull();
    expect(performance.now() - started).toBeLessThan(6000);
  });

  test('pathological CSS, srcset and references stay linear', async () => {
    const started = performance.now();
    const css = await extractMetadata(
      files({
        'a.css': '/*'.repeat(2_000_000),
        'b.css': 'url('.repeat(1_000_000),
        'c.css': `a{b:"${'\\'.repeat(1_000_000)}`,
        'd.css': '@import '.repeat(500_000),
        'index.html': `<img srcset="${','.repeat(4_000_000)}x,"><img srcset="${'a ,'.repeat(1_000_000)}">`,
      }),
      'index.html',
    );
    expect(css.warnings).toEqual([]);
    expect(resolveRef('a.html', '../'.repeat(100_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('pathological markdown stays bounded', async () => {
    const started = performance.now();
    const m = await extractMetadata(
      files({ 'index.md': `${'![['.repeat(2_000_000)}\n`, 'b.md': '*'.repeat(6_000_000) }),
      'index.md',
    );
    expect(m.text.length).toBeLessThanOrEqual(SEARCH_TEXT_MAX_CHARS);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('only the first SCAN_MAX_BYTES of a file are read for text and warnings', async () => {
    const filler = ' '.repeat(SCAN_MAX_BYTES);
    const m = await extractMetadata(
      files({
        'index.html': `<p>early</p>${filler}<p>late</p><img src="/late.png">`,
        'b.css': `${filler}a{background:url(/late.png)}`,
      }),
      'index.html',
    );
    expect(m.text).toBe('early');
    expect(m.warnings).toEqual([]);
  });

  test('a document is read the same whatever the write boundaries fall on', async () => {
    // The parser is fed in chunks; nothing may be lost or doubled at a boundary.
    for (let offset = 0; offset < 130; offset++) {
      const pad = 16_384 - offset;
      const m = await html(
        `${'a'.repeat(pad)}<h1>Heading 😀 giá</h1><img src="/s${'x'.repeat(40)}.png"><p>Tom &amp; &#x1F600; end</p>`,
      );
      expect(m.title).toBe('Heading 😀 giá');
      expect(m.warnings.map((w) => w.url)).toEqual([`/s${'x'.repeat(40)}.png`]);
      expect(m.text.endsWith('Heading 😀 giá Tom & 😀 end')).toBe(true);
    }
  });

  test('stopping at a write boundary never leaves half an emoji', async () => {
    // Nesting this deep ends the scan after the first write; its last unit would be the high
    // surrogate of the emoji if the write were cut at a fixed size.
    const m = await html(`${'<div>'.repeat(600)}${'a'.repeat(16_383 - 3_000)}😀 after`);
    expect(wellFormed(m.text)).toBe(true);
    expect(m.text.endsWith('😀')).toBe(true);
  });

  test('Markdown is read up to MARKDOWN_MAX_BYTES a file and MARKDOWN_BUDGET_BYTES a version', async () => {
    const site = markdownBudgetSite();
    const reads: { path: string; bytes: number }[] = [];
    const watched = files(site).map(
      (file): MetadataFile => ({
        ...file,
        read: async (max) => {
          const bytes = (await file.read(max)).subarray(0, max);
          reads.push({ path: file.path, bytes: bytes.length });
          return bytes;
        },
      }),
    );
    const m = await extractMetadata(watched, 'index.html');

    expect(m.text).toBe('entry word1 word2 word3');
    const markdown = reads.filter((r) => r.path.endsWith('.md'));
    expect(markdown.map((r) => r.path)).toEqual(['p1.md', 'p2.md', 'p3.md']);
    expect(Math.max(...markdown.map((r) => r.bytes))).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
    expect(markdown.reduce((sum, r) => sum + r.bytes, 0)).toBe(MARKDOWN_BUDGET_BYTES);
  });

  test('hostile Markdown costs a bounded time per version', async () => {
    // Empty headings: no text, so the text cap never stops the scan, and the most tokens a byte.
    const page = Buffer.from('#\n'.repeat(250_000));
    const site: MetadataFile[] = Array.from({ length: 45 }, (_, n) => ({
      path: `p${String(n).padStart(2, '0')}.md`,
      contentType: 'text/markdown; charset=utf-8',
      size: page.length,
      read: async (max) => page.subarray(0, max),
    }));
    const started = performance.now();
    await extractMetadata(site, 'p00.md');
    // About 0.5 s here; reading 500 KB of each page took about 18 s.
    expect(performance.now() - started).toBeLessThan(4000);
  }, 60_000);

  test('a tag with more than HTML_MAX_ATTRIBUTES attributes ends the scan of its page', async () => {
    const flood = attributeFlood(600_000); // about 4.7 MB, under SCAN_MAX_BYTES
    expect(flood.length).toBeGreaterThan(4_500_000);
    const site: Record<string, string> = { 'index.html': flood, 'z.html': '<p>other</p>' };
    for (let n = 1; n <= 3; n++) site[`p${n}.html`] = flood;
    const started = performance.now();
    const m = await extractMetadata(files(site), 'index.html');
    // About 10 ms here; building the attributes of four such tags took about 1.7 s.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(m.text).toBe('before before before before other');

    // A tag at the limit is still read through.
    const limit = await html(attributeFlood(HTML_MAX_ATTRIBUTES));
    expect(limit.text).toBe('before after');
  });

  test('an entry is scanned by its extension: a single non-HTML file is not read as HTML', async () => {
    const pdf = '<title>Fake</title><p>pdf words</p>';
    for (const path of ['report.pdf', 'photo.png', 'notes']) {
      const m = await extractMetadata(files({ [path]: pdf }), path);
      expect(m, path).toEqual({
        title: null,
        themeColor: null,
        thumbnailPath: null,
        text: '',
        warnings: [],
      });
    }
    expect((await extractMetadata(files({ 'page.HTM': pdf }), 'page.HTM')).title).toBe('Fake');
  });

  test('a missing entry yields only what the other files give', async () => {
    const m = await extractMetadata(files({ 'a.md': 'alpha' }), 'index.html');
    expect(m).toEqual({
      title: null,
      themeColor: null,
      thumbnailPath: null,
      text: 'alpha',
      warnings: [],
    });
  });

  test('at most SCAN_BUDGET_BYTES are read across a version; later files are skipped', async () => {
    const site = budgetSite();
    const reads: { path: string; max: number }[] = [];
    const watched = files(site).map(
      (file): MetadataFile => ({
        ...file,
        read: (max) => {
          reads.push({ path: file.path, max });
          return file.read(max);
        },
      }),
    );
    const m = await extractMetadata(watched, 'index.html');

    expect(m.text).toContain('word4');
    expect(m.text).not.toContain('word5');
    // Skipped files add no warning of their own.
    expect(m.warnings.map((w) => w.url)).toEqual(['/abs1', '/abs2', '/abs3', '/abs4']);
    expect(reads.map((r) => r.path)).toEqual([
      'index.html',
      'p1.html',
      'p2.html',
      'p3.html',
      'p4.html',
    ]);
    expect(reads.every((r) => r.max <= SCAN_MAX_BYTES)).toBe(true);
    const total = reads.reduce(
      (sum, r) => sum + Math.min(r.max, Buffer.byteLength(site[r.path] ?? '')),
      0,
    );
    expect(total).toBe(SCAN_BUDGET_BYTES);
  });

  test('files are read at most once, and skipped when nothing more is needed', async () => {
    const reads: string[] = [];
    const counted = (path: string, body: string): MetadataFile => ({
      path,
      contentType: contentTypeFor(path),
      size: body.length,
      read: async () => {
        reads.push(path);
        return Buffer.from(body);
      },
    });
    const flood = `<p>${'word '.repeat(60_000)}</p>${Array.from({ length: 60 }, (_, i) => `<img src="/${i}.png">`).join('')}`;
    await extractMetadata(
      [
        counted('index.html', flood),
        counted('b.html', '<p>b</p>'),
        counted('c.md', 'c'),
        counted('d.css', 'a{}'),
        counted('e.png', 'png'),
      ],
      'index.html',
    );
    expect(reads).toEqual(['index.html']);
  });
});

describe('resolveRef', () => {
  test.each([
    ['index.html', 'a.png', 'a.png'],
    ['docs/index.html', 'a.png', 'docs/a.png'],
    ['docs/index.html', './a.png', 'docs/a.png'],
    ['docs/index.html', '../a.png', 'a.png'],
    ['a/b/c.html', '../../x/y.png', 'x/y.png'],
    ['docs/index.html', 'img/a.png?v=1#frag', 'docs/img/a.png'],
    ['docs/index.html', ' img/a.png ', 'docs/img/a.png'],
    ['index.html', 'a%20b.png', 'a b.png'],
    ['index.html', 'đ%E1%BA%A3nh.png', 'đảnh.png'],
    ['index.html', 'café.png', 'café.png'],
    ['index.html', 'cafe%CC%81.png', 'café.png'],
    ['docs/index.html', 'sub\\a.png', 'docs/sub/a.png'],
    ['docs/index.html', '%2e%2e/a.png', 'a.png'],
    ['index.html', 'a/./b/../c.png', 'a/c.png'],
  ])('%s + %s → %s', (from, ref, expected) => {
    expect(resolveRef(from, ref)).toBe(expected);
  });

  test.each([
    ['index.html', 'https://cdn.example/a.png'],
    ['index.html', 'HTTP://cdn.example/a.png'],
    ['index.html', '//cdn.example/a.png'],
    ['index.html', '\\\\cdn.example/a.png'],
    ['index.html', '/a.png'],
    ['index.html', 'data:image/png;base64,AAAA'],
    ['index.html', 'javascript:alert(1)'],
    ['index.html', 'mailto:a@b.example'],
    ['index.html', '#top'],
    ['index.html', '?q=1'],
    ['index.html', ''],
    ['index.html', '   '],
    ['index.html', '.'],
    ['index.html', 'docs/'],
    ['index.html', '../a.png'],
    ['docs/index.html', '../../a.png'],
    ['docs/index.html', '%2e%2e/%2e%2e/a.png'],
    ['index.html', 'a//b.png'],
    ['index.html', 'a%2Fb.png'],
    ['index.html', 'a%5Cb.png'],
    ['index.html', 'bad%zzescape.png'],
    ['index.html', 'bad%E1%BAescape.png'],
    ['index.html', `${'a/'.repeat(5000)}b.png`],
  ])('%s + %j → null', (from, ref) => {
    expect(resolveRef(from, ref)).toBeNull();
  });
});

describe.each(dialects)('extractVersionText on %s', (dialect) => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext({ dialect });
  });
  afterEach(() => ctx.close());

  /** A committed-looking version whose files are stored for real: rows with true sizes, and bytes. */
  async function version(
    entryPath: string,
    record: Record<string, string | Buffer>,
    opts: { skipBlobs?: string[] } = {},
  ): Promise<string> {
    const { db } = ctx.deps.db;
    const now = ctx.deps.clock.now();
    const projectId = newId('prj');
    const artifactId = newId('art');
    const versionId = newId('ver');
    await db
      .insertInto('projects')
      .values({
        id: projectId,
        name: 'P',
        instructions: '',
        is_default: 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('artifacts')
      .values({
        id: artifactId,
        project_id: projectId,
        name: 'A',
        kind: 'html',
        latest_number: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('versions')
      .values({
        id: versionId,
        artifact_id: artifactId,
        number: 1,
        entry_path: entryPath,
        file_count: Object.keys(record).length,
        total_bytes: 0,
        source: 'api',
        meta: '{}',
        created_at: now,
      })
      .execute();
    for (const [path, body] of Object.entries(record)) {
      const bytes = Buffer.from(body);
      const key = createHash('sha256').update(bytes).digest('hex');
      await db
        .insertInto('blobs')
        .values({ sha256: key, size: bytes.length, created_at: now })
        .onConflict((c) => c.column('sha256').doNothing())
        .execute();
      if (!opts.skipBlobs?.includes(path)) await ctx.deps.blobs.put(key, bytes, bytes.length);
      await db
        .insertInto('version_files')
        .values({
          version_id: versionId,
          path,
          sha256: key,
          size: bytes.length,
          content_type: contentTypeFor(path),
        })
        .execute();
    }
    return versionId;
  }

  test('applies the same text rule to stored files: entry first, then html and md by path', async () => {
    const id = await version('docs/index.html', {
      'z.html': 'zeta',
      'a.md': '# Alpha *beta*',
      'docs/index.html': '<p>Dịch vụ</p><script>secret()</script>',
      'b.css': 'cssword',
      'logo.png': 'png',
    });
    expect(await extractVersionText(ctx.deps, id)).toBe('Dịch vụ Alpha beta zeta');
  });

  test('gives the text extractMetadata gives', async () => {
    const record = {
      'index.md': '# Giá\n\nbảng `code` here',
      'about.html': '<h1>About</h1><p>us &amp; them</p>',
      'x.js': 'nope',
    };
    const meta = await extractMetadata(files(record), 'index.md');
    const id = await version('index.md', record);
    expect(await extractVersionText(ctx.deps, id)).toBe(meta.text);
  });

  test('is capped, and stops reading once it is', async () => {
    const id = await version('index.html', {
      'index.html': `<p>${'word '.repeat(60_000)}</p>`,
      'b.html': 'late',
    });
    const text = await extractVersionText(ctx.deps, id);
    expect(text).toHaveLength(SEARCH_TEXT_MAX_CHARS);
    expect(text).not.toContain('late');
  });

  test('reads only the head of a file bigger than SCAN_MAX_BYTES', async () => {
    const id = await version('index.html', {
      'index.html': `<p>early</p>${' '.repeat(SCAN_MAX_BYTES)}<p>late</p>`,
    });
    expect(await extractVersionText(ctx.deps, id)).toBe('early');
  });

  test('stops at SCAN_BUDGET_BYTES as extractMetadata does', async () => {
    const site = budgetSite();
    const text = await extractVersionText(ctx.deps, await version('index.html', site));
    expect(text).toContain('word4');
    expect(text).not.toContain('word5');
    expect(text).toBe((await extractMetadata(files(site), 'index.html')).text);
  });

  test('applies the same Markdown and attribute bounds as extractMetadata', async () => {
    const site = { ...markdownBudgetSite(), 'p0.html': attributeFlood(5_000) };
    const get = vi.spyOn(ctx.deps.blobs, 'get');
    const text = await extractVersionText(ctx.deps, await version('index.html', site));
    expect(text).toBe('entry before word1 word2 word3');
    expect(text).toBe((await extractMetadata(files(site), 'index.html')).text);
    const markdownBytes = get.mock.calls
      .map(([, range]) => (range?.end ?? -1) + 1 - (range?.start ?? 0))
      .slice(2); // index.html and p0.html come first
    expect(markdownBytes).toHaveLength(3);
    expect(Math.max(...markdownBytes)).toBeLessThanOrEqual(MARKDOWN_MAX_BYTES);
    expect(markdownBytes.reduce((sum, n) => sum + n, 0)).toBe(MARKDOWN_BUDGET_BYTES);
  });

  test('a single non-HTML entry gives no text, as at publish', async () => {
    const record = { 'report.pdf': '<title>Fake</title><p>pdf words</p>' };
    const id = await version('report.pdf', record);
    expect(await extractVersionText(ctx.deps, id)).toBe('');
    expect((await extractMetadata(files(record), 'report.pdf')).text).toBe('');
  });

  test('a file whose blob is gone is skipped, not fatal', async () => {
    const id = await version(
      'index.html',
      { 'index.html': '<p>kept</p>', 'b.html': '<p>lost</p>', 'c.md': 'also kept' },
      { skipBlobs: ['b.html'] },
    );
    expect(await extractVersionText(ctx.deps, id)).toBe('kept also kept');
  });

  test('a version with no files, or one that does not exist, has no text', async () => {
    expect(await extractVersionText(ctx.deps, await version('index.html', {}))).toBe('');
    expect(await extractVersionText(ctx.deps, newId('ver'))).toBe('');
    const empty = await version('index.html', { 'index.html': '' });
    expect(await extractVersionText(ctx.deps, empty)).toBe('');
  });

  test('non-UTF-8 stored bytes give well-formed text', async () => {
    const id = await version('index.html', {
      'index.html': Buffer.from([0x3c, 0x70, 0x3e, 0xff, 0xfe, 0xc3]),
    });
    const text = await extractVersionText(ctx.deps, id);
    expect(wellFormed(text)).toBe(true);
  });
});
