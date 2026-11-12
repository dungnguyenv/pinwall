import { describe, expect, test } from 'vitest';
import { htmlCharset } from '../../src/content/html-charset.ts';

const latin1 = (text: string) => Buffer.from(text, 'latin1');

describe('htmlCharset', () => {
  test('a page with no declaration is UTF-8', () => {
    expect(htmlCharset(latin1('<!doctype html><title>x</title><p>hi'))).toBe('utf-8');
    expect(htmlCharset(Buffer.alloc(0))).toBe('utf-8');
  });

  test('a meta charset names the encoding, by its standard name', () => {
    expect(htmlCharset(latin1('<!doctype html><meta charset="windows-1258"><p>x'))).toBe(
      'windows-1258',
    );
    expect(htmlCharset(latin1("<meta charset='Shift_JIS'>"))).toBe('shift_jis');
    expect(htmlCharset(latin1('<META CHARSET=latin1>'))).toBe('windows-1252');
    expect(htmlCharset(latin1('<meta charset=" gb2312 ">'))).toBe('gbk');
    expect(htmlCharset(latin1('<meta charset="utf-8">'))).toBe('utf-8');
  });

  test('an http-equiv Content-Type declaration counts only with its pragma', () => {
    expect(
      htmlCharset(latin1('<meta http-equiv="Content-Type" content="text/html; charset=EUC-KR">')),
    ).toBe('euc-kr');
    expect(
      htmlCharset(latin1('<meta content=\'text/html;charset="koi8-r"\' http-equiv=content-type>')),
    ).toBe('koi8-r');
    // A content attribute without the pragma is not a declaration.
    expect(htmlCharset(latin1('<meta name="x" content="charset=windows-1251">'))).toBe('utf-8');
  });

  test('a BOM wins over any declaration', () => {
    const page = latin1('<meta charset="windows-1258">');
    expect(htmlCharset(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), page]))).toBe('utf-8');
    expect(htmlCharset(Buffer.concat([Buffer.from([0xff, 0xfe]), page]))).toBe('utf-16le');
    expect(htmlCharset(Buffer.concat([Buffer.from([0xfe, 0xff]), page]))).toBe('utf-16be');
  });

  test('declarations in comments, other tags and attribute values are passed over', () => {
    expect(htmlCharset(latin1('<!-- <meta charset="windows-1251"> --><p>x'))).toBe('utf-8');
    expect(htmlCharset(latin1('<!--><meta charset="koi8-r">'))).toBe('koi8-r');
    expect(htmlCharset(latin1('<div title="<meta charset=windows-1251>">x</div>'))).toBe('utf-8');
    expect(htmlCharset(latin1('<!doctype html charset=windows-1251><p>'))).toBe('utf-8');
    expect(htmlCharset(latin1('<metadata charset="windows-1251">'))).toBe('utf-8');
    // A `>` in a quoted value does not end the tag; bytes that end inside a tag end the scan.
    expect(htmlCharset(latin1('<a title="1 > 0"><meta charset=koi8-r>'))).toBe('koi8-r');
    expect(htmlCharset(latin1('<a title="<meta charset=koi8-r>'))).toBe('utf-8');
  });

  test('only the first 1024 bytes are scanned, as a browser does', () => {
    const late = `<!doctype html><!--${'x'.repeat(1024)}--><meta charset="windows-1258">`;
    expect(htmlCharset(latin1(late))).toBe('utf-8');
  });

  test('UTF-16 and unknown labels fall back the way the HTML standard says', () => {
    // A page that is read as ASCII cannot be UTF-16, so the standard reads it as UTF-8.
    expect(htmlCharset(latin1('<meta charset="utf-16">'))).toBe('utf-8');
    expect(htmlCharset(latin1('<meta charset="x-user-defined">'))).toBe('windows-1252');
    // An unknown label is ignored and the scan goes on.
    expect(htmlCharset(latin1('<meta charset="bogus"><meta charset="koi8-r">'))).toBe('koi8-r');
    expect(htmlCharset(latin1('<meta charset="bogus">'))).toBe('utf-8');
  });
});
