import { expect, test } from 'vitest';
import { grantBase, pageOf } from '../src/page.ts';

test('pages are paths relative to the grant base', () => {
  const b = 'http://localhost:8080/c/tok/';
  expect([
    pageOf(b, b),
    pageOf(`${b}index.html?x=1#top`, b),
    pageOf(`${b}docs/`, b),
    pageOf(`${b}docs/index.html`, b),
  ]).toEqual(['', '', 'docs/', 'docs/']);
  expect(pageOf(`${b}a%20b/T%C3%A0i.html`, b)).toBe('a b/Tài.html');
  expect(pageOf(`${b}${encodeURIComponent('Tài'.normalize('NFD'))}.html`, b)).toBe('Tài.html');
  expect(pageOf('http://localhost:8080/c/other/x.html', b)).toBeNull();
  expect(grantBase('https://tok.pw-content.test/__pinwall/annotator.js')).toBe(
    'https://tok.pw-content.test/',
  );
  expect(grantBase(`${b}__pinwall/annotator.js`)).toBe(b);
  expect(grantBase('http://localhost:8080/app.js')).toBeNull();
});

test('odd URLs keep what cannot be decoded and never throw', () => {
  const b = 'http://localhost:8080/c/tok/';
  expect(pageOf(`${b}%E0%A4%A/x.html`, b)).toBe('%E0%A4%A/x.html');
  expect(pageOf(`${b}docs/index.html/`, b)).toBe('docs/index.html/');
  expect(pageOf(`${b}docs/INDEX.html`, b)).toBe('docs/INDEX.html');
  expect(pageOf('http://localhost:8080/c/tok', b)).toBeNull();
  for (const href of ['about:srcdoc', 'not a url', '', 'blob:http://localhost:8080/1234']) {
    expect(pageOf(href, b)).toBeNull();
  }
  expect(pageOf(`${b}a.html`, 'not a url')).toBeNull();
  expect(grantBase(`${b}__pinwall/annotator.js?v=1#x`)).toBe(b);
  expect(grantBase(`${b}x__pinwall/annotator.js`)).toBeNull();
  expect(grantBase('/__pinwall/annotator.js')).toBeNull();
  expect(grantBase('')).toBeNull();
});
