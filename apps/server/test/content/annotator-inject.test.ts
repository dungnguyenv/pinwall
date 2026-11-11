import { describe, expect, test } from 'vitest';
import {
  annotatorTag,
  HEAD_SCAN_MAX_BYTES,
  injectAnnotator,
  injectionOffset,
} from '../../src/content/annotator-inject.ts';
import type { ContentGrantRow, VersionRow } from '../../src/db/schema.ts';

const BASE = 'http://localhost:8080/c/tok/';
const T = annotatorTag(BASE);

/** What `serveFile` passes; the injection reads only `baseUrl`. */
function transformContext(baseUrl = BASE) {
  return {
    grant: {} as ContentGrantRow,
    version: {} as VersionRow,
    path: 'index.html',
    baseUrl,
  };
}

/** Runs the transform on the bytes of `s` (one byte per character) and reads them back so. */
async function inject(s: string): Promise<string> {
  return (await injectAnnotator(Buffer.from(s, 'latin1'), transformContext())).toString('latin1');
}

const CSP = '<meta http-equiv="Content-Security-Policy" content="x">';

test('the tag is the verbatim script element under the grant base', () => {
  expect(T).toBe(
    '<script src="http://localhost:8080/c/tok/__pinwall/annotator.js" data-pinwall-annotator></script>',
  );
});

test.each([
  [
    'head',
    '<!doctype html><html><head><title>x</title>',
    `<!doctype html><html><head>${T}<title>x</title>`,
  ],
  [
    'capitals and attributes',
    '<!DOCTYPE html><HTML lang="vi"><HEAD data-x="1"><TITLE>x',
    `<!DOCTYPE html><HTML lang="vi"><HEAD data-x="1">${T}<TITLE>x`,
  ],
  [
    'the last CSP meta of the head',
    `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="img-src *"><meta http-equiv="content-security-policy" content="script-src 'none'"><title>`,
    `<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="img-src *"><meta http-equiv="content-security-policy" content="script-src 'none'">${T}<title>`,
  ],
  [
    'a CSP meta without a head tag',
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="x"><p>y`,
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="x">${T}<p>y`,
  ],
  ['no head: after <html>', '<!doctype html><html><body>x', `<!doctype html><html>${T}<body>x`],
  [
    'no html: after the doctype',
    '<!doctype html><title>x</title><p>y',
    `<!doctype html>${T}<title>x</title><p>y`,
  ],
  ['a fragment', '<p>x</p>', `${T}<p>x</p>`],
  ['a UTF-8 BOM', '\xef\xbb\xbf<p>x', `\xef\xbb\xbf${T}<p>x`],
  [
    'head in a comment',
    '<!-- <head> --><!doctype html><html><head><title>',
    `<!-- <head> --><!doctype html><html><head>${T}<title>`,
  ],
  ['header is not head', '<html><header>x', `<html>${T}<header>x`],
  [
    'a meta inside a script',
    `<head><script>document.write('<meta http-equiv="content-security-policy" content="x">')</script></head>`,
    `<head>${T}<script>document.write('<meta http-equiv="content-security-policy" content="x">')</script></head>`,
  ],
  [
    'a CSP meta in the body is ignored',
    `<head></head><body><meta http-equiv="Content-Security-Policy" content="x">`,
    `<head>${T}</head><body><meta http-equiv="Content-Security-Policy" content="x">`,
  ],
  // The HTML parser still puts these in the head, so the page's policy covers what follows them.
  [
    'a CSP meta between </head> and <body>',
    `<head><title>x</title></head>\r\n${CSP}\r\n<body>`,
    `<head><title>x</title></head>\r\n${CSP}${T}\r\n<body>`,
  ],
  [
    'a self-closing CSP meta in capitals',
    '<HEAD><META HTTP-EQUIV="CONTENT-SECURITY-POLICY" CONTENT="x" /><TITLE>',
    `<HEAD><META HTTP-EQUIV="CONTENT-SECURITY-POLICY" CONTENT="x" />${T}<TITLE>`,
  ],
  [
    'a CSP meta after a noscript image',
    `<head><noscript><img src="p.gif"></noscript>${CSP}<title>`,
    `<head><noscript><img src="p.gif"></noscript>${CSP}${T}<title>`,
  ],
  [
    'a BOM before the doctype',
    '\xef\xbb\xbf<!doctype html><html><head><title>',
    `\xef\xbb\xbf<!doctype html><html><head>${T}<title>`,
  ],
  ['an empty file', '', T],
  // Nothing here is a policy the browser applies, so the tag stays where the head begins.
  [
    'a CSP meta inside noscript',
    `<head><noscript>${CSP}</noscript><title>`,
    `<head>${T}<noscript>${CSP}</noscript><title>`,
  ],
  [
    'a CSP meta inside a template',
    `<head><template><p>y</p>${CSP}</template><title>`,
    `<head>${T}<template><p>y</p>${CSP}</template><title>`,
  ],
  ['a CSP meta after text', `<head>Hi${CSP}`, `<head>${T}Hi${CSP}`],
  ['a meta in a comment', `<head><!-- ${CSP} --><title>`, `<head>${T}<!-- ${CSP} --><title>`],
  [
    'an http-equiv of another kind',
    '<head><meta http-equiv="refresh" content="5"><title>',
    `<head>${T}<meta http-equiv="refresh" content="5"><title>`,
  ],
])('injects %s', async (_n, input, expected) => expect(await inject(input)).toBe(expected));

test('bytes outside the insertion are untouched', async () => {
  // windows-1252 (é, en dash), UTF-8 (Bảng giá) and CRLF line ends, none of them valid UTF-8 all together.
  const before = Buffer.from('<!DOCTYPE html>\r\n<html lang="fr">\r\n<head>', 'latin1');
  const after = Buffer.concat([
    Buffer.from('\r\n<title>Caf', 'latin1'),
    Buffer.from([0xe9, 0x20, 0x96, 0x20]),
    Buffer.from('Bảng giá</title>\r\n</head>\r\n<body>\r\n<p>'),
    Buffer.from([0xe9, 0x96, 0x00, 0xff]),
    Buffer.from('</p>\r\n', 'latin1'),
  ]);
  const input = Buffer.concat([before, after]);
  const output = await injectAnnotator(input, transformContext());
  expect(injectionOffset(input)).toBe(before.length);
  expect(output.equals(Buffer.concat([before, Buffer.from(T), after]))).toBe(true);
});

test('UTF-16 documents are left unchanged', async () => {
  const page = '<!doctype html><html><head><title>x</title></head>';
  const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(page, 'utf16le')]);
  const big = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(page, 'utf16le').swap16()]);
  for (const input of [little, big]) {
    const copy = Buffer.from(input);
    expect(injectionOffset(input)).toBeNull();
    expect(await injectAnnotator(input, transformContext())).toBe(input);
    expect(input.equals(copy)).toBe(true);
  }
});

test('the tag uses the grant base in each mode', async () => {
  const token = '0123456789abcdefghjkmnpqrstvwxyz';
  const contentBase = `https://${token}.pw-content.test/`;
  const output = await injectAnnotator(
    Buffer.from('<html><head><title>x'),
    transformContext(contentBase),
  );
  expect(output.toString()).toBe(
    `<html><head><script src="https://${token}.pw-content.test/__pinwall/annotator.js" data-pinwall-annotator></script><title>x`,
  );
});

describe('large documents', () => {
  test('tags split across the chunks the scan reads are found', () => {
    // The CSP meta (and the head's end) land on every alignment around the 64 KiB and 128 KiB marks.
    for (const mark of [65_536, 131_072]) {
      for (let shift = -70; shift <= 10; shift += 3) {
        const head = `<head><script>${' '.repeat(mark + shift - 14)}</script>${CSP}`;
        const html = Buffer.from(`${head}<title>x</title></head><body>`, 'latin1');
        expect(injectionOffset(html), `${mark}${shift}`).toBe(head.length);
      }
    }
  });

  test('the scan stops where the body starts', () => {
    // Had the scan gone on through the body, the CSP meta at its end would have moved the tag.
    const head = '<!doctype html><html><head><title>x</title></head>';
    const body = `<body>${'<p>y</p>'.repeat(125_000)}${CSP}`;
    const html = Buffer.from(head + body);
    expect(injectionOffset(html)).toBe('<!doctype html><html><head>'.length);
  });

  test('a head longer than the scan reads is left unchanged', async () => {
    const script = (n: number) => `<!doctype html><html><head><script>${'x'.repeat(n)}</script>`;
    const within = Buffer.from(`${script(HEAD_SCAN_MAX_BYTES - 200)}${CSP}</head><body>`);
    expect(injectionOffset(within)).toBe(
      Buffer.byteLength(`${script(HEAD_SCAN_MAX_BYTES - 200)}${CSP}`),
    );

    // The policy may come after what the scan reads: with no tag, the page keeps it whole.
    const beyond = Buffer.from(`${script(HEAD_SCAN_MAX_BYTES)}${CSP}</head><body>`);
    expect(injectionOffset(beyond)).toBeNull();
    expect(await injectAnnotator(beyond, transformContext())).toBe(beyond);
  });
});
