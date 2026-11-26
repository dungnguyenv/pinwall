import { expect, test } from 'vitest';
import { linkify, type TextPart } from './linkify.ts';

/** The parts as one string, each link's text in ⟦ ⟧, after checking they spell the input. */
function show(input: string): string {
  const parts = linkify(input);
  expect(parts.map((part) => part.text).join('')).toBe(input);
  for (const [i, part] of parts.entries()) {
    expect(part.text).not.toBe('');
    // Two text parts in a row would be one.
    if (i > 0) expect(part.kind === 'text' && parts[i - 1]?.kind === 'text').toBe(false);
  }
  return parts.map((part) => (part.kind === 'link' ? `⟦${part.text}⟧` : part.text)).join('');
}

const links = (input: string) =>
  linkify(input).filter(
    (part): part is Extract<TextPart, { kind: 'link' }> => part.kind === 'link',
  );

test('text without a URL is one text part, and no text is none', () => {
  expect(linkify('Bigger heading')).toEqual([{ kind: 'text', text: 'Bigger heading' }]);
  expect(linkify('')).toEqual([]);
});

test('a URL becomes a link to the URL it parses as', () => {
  expect(linkify('https://example.com/a?b=c#d')).toEqual([
    { kind: 'link', text: 'https://example.com/a?b=c#d', href: 'https://example.com/a?b=c#d' },
  ]);
  expect(linkify('http://example.com')).toEqual([
    { kind: 'link', text: 'http://example.com', href: 'http://example.com/' },
  ]);
  expect(linkify('see http://localhost:5173/a/art_1 now')).toEqual([
    { kind: 'text', text: 'see ' },
    { kind: 'link', text: 'http://localhost:5173/a/art_1', href: 'http://localhost:5173/a/art_1' },
    { kind: 'text', text: ' now' },
  ]);
});

test('the scheme may be in any letter case', () => {
  expect(linkify('HTTPS://EXAMPLE.COM/Path')).toEqual([
    { kind: 'link', text: 'HTTPS://EXAMPLE.COM/Path', href: 'https://example.com/Path' },
  ]);
  expect(show('Http://example.com')).toBe('⟦Http://example.com⟧');
});

test.each([
  'javascript:alert(1)',
  'JavaScript://%0aalert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'mailto:ada@example.com',
  'ftp://example.com/file',
  'www.example.com',
  'example.com/page',
  'https:example.com',
  'https:/example.com',
  'https://',
  'https:// example.com',
  'https://.',
  'https://?',
  'https://#top',
])('%j stays text', (input) => {
  expect(linkify(input)).toEqual([{ kind: 'text', text: input }]);
});

test('a scheme glued to the end of a word is not a URL', () => {
  expect(show('xhttps://example.com')).toBe('xhttps://example.com');
  expect(show('ahttp://example.com')).toBe('ahttp://example.com');
  expect(show('1https://example.com')).toBe('1https://example.com');
});

test('only the http(s) URL after another scheme or a sign is linked', () => {
  expect(show('git+https://github.com/a/b')).toBe('git+⟦https://github.com/a/b⟧');
  expect(show('javascript:https://example.com')).toBe('javascript:⟦https://example.com⟧');
  expect(links('javascript:alert("https://example.com")')).toEqual([
    { kind: 'link', text: 'https://example.com', href: 'https://example.com/' },
  ]);
});

test('URLs at the start, in the middle and at the end, several of them', () => {
  expect(show('https://a.example/1 then https://b.example/2 and http://c.example')).toBe(
    '⟦https://a.example/1⟧ then ⟦https://b.example/2⟧ and ⟦http://c.example⟧',
  );
  expect(show('https://a.example https://b.example')).toBe(
    '⟦https://a.example⟧ ⟦https://b.example⟧',
  );
});

test.each(['.', ',', ';', ':', '!', '?', '...', '?!', ':)'])(
  'punctuation %j that ends a sentence stays out of the link',
  (end) => {
    expect(show(`Look at https://example.com/page${end}`)).toBe(
      `Look at ⟦https://example.com/page⟧${end}`,
    );
  },
);

test('punctuation inside a URL stays in it', () => {
  expect(show('https://example.com/a.b,c;d:e!f?g=h.')).toBe(
    '⟦https://example.com/a.b,c;d:e!f?g=h⟧.',
  );
  expect(show('https://example.com:8443/x')).toBe('⟦https://example.com:8443/x⟧');
  expect(show('https://example.com/a/')).toBe('⟦https://example.com/a/⟧');
});

test('a closing bracket stays in the URL only when the URL opened it', () => {
  expect(show('(see https://a.com/x_(y))')).toBe('(see ⟦https://a.com/x_(y)⟧)');
  expect(show('https://a.com/x).')).toBe('⟦https://a.com/x⟧).');
  expect(show('(https://a.com)')).toBe('(⟦https://a.com⟧)');
  expect(show('[https://a.com/x]')).toBe('[⟦https://a.com/x⟧]');
  expect(show('{https://a.com/x}')).toBe('{⟦https://a.com/x⟧}');
  expect(show('https://a.com/list[0]')).toBe('⟦https://a.com/list[0]⟧');
  expect(show('https://en.wikipedia.org/wiki/Pinwall_(disambiguation)')).toBe(
    '⟦https://en.wikipedia.org/wiki/Pinwall_(disambiguation)⟧',
  );
  expect(show('((https://a.com/(x)))')).toBe('((⟦https://a.com/(x)⟧))');
  expect(show('https://a.com/x))))')).toBe('⟦https://a.com/x⟧))))');
});

test('quotes around a URL stay out of it', () => {
  expect(show('"https://a.com/x"')).toBe('"⟦https://a.com/x⟧"');
  expect(show("'https://a.com/x'.")).toBe("'⟦https://a.com/x⟧'.");
  expect(show('“https://a.com/x”')).toBe('“⟦https://a.com/x⟧”');
  expect(show('‘https://a.com/x’')).toBe('‘⟦https://a.com/x⟧’');
  expect(show('«https://a.com/x»')).toBe('«⟦https://a.com/x⟧»');
  expect(show('<https://a.com/x>')).toBe('<⟦https://a.com/x⟧>');
  expect(show('`https://a.com/x`')).toBe('`⟦https://a.com/x⟧`');
  // An apostrophe the URL holds is kept.
  expect(show("https://en.wikipedia.org/wiki/Hitchhiker's_Guide")).toBe(
    "⟦https://en.wikipedia.org/wiki/Hitchhiker's_Guide⟧",
  );
});

test('line breaks, tabs and spaces around URLs are kept as written', () => {
  const body = 'First line\nhttps://a.com/x\n\n\tindented https://b.com/y  \n  last';
  expect(show(body)).toBe(
    'First line\n⟦https://a.com/x⟧\n\n\tindented ⟦https://b.com/y⟧  \n  last',
  );
  expect(show('https://a.com/x\r\nnext')).toBe('⟦https://a.com/x⟧\r\nnext');
  expect(show('https://a.com/x next')).toBe('⟦https://a.com/x⟧ next');
});

test('unicode text around a URL, and in it', () => {
  expect(show('Xem https://vi.wikipedia.org/wiki/Việt_Nam nhé.')).toBe(
    'Xem ⟦https://vi.wikipedia.org/wiki/Việt_Nam⟧ nhé.',
  );
  expect(links('https://vi.wikipedia.org/wiki/Việt_Nam')[0]?.href).toBe(
    'https://vi.wikipedia.org/wiki/Vi%E1%BB%87t_Nam',
  );
  expect(links('https://ví-dụ.vn/trang')[0]?.href).toMatch(/^https:\/\/xn--/);
  expect(show('Màu nền tối quá, xem https://a.com/x!')).toBe(
    'Màu nền tối quá, xem ⟦https://a.com/x⟧!',
  );
  expect(show('请看https://a.com/x。')).toBe('请看⟦https://a.com/x⟧。');
  expect(show('🎉 https://a.com/x 🎉')).toBe('🎉 ⟦https://a.com/x⟧ 🎉');
  expect(show('Đã sửa (https://a.com/x…)')).toBe('Đã sửa (⟦https://a.com/x⟧…)');
});

test('a very long URL is one link', () => {
  const url = `https://example.com/${'a'.repeat(9_000)}?q=${'b'.repeat(900)}`;
  expect(show(`Long: ${url}.`)).toBe(`Long: ⟦${url}⟧.`);
});

test('a body full of closing brackets takes linear time', () => {
  const body = `https://a.com/${')'.repeat(9_970)}`;
  const start = performance.now();
  expect(show(body)).toBe(`⟦https://a.com/⟧${')'.repeat(9_970)}`);
  expect(performance.now() - start).toBeLessThan(500);
});
