import { expect, test } from 'vitest';
import { contentTypeFor, isRasterImage, isTextType } from '../../src/content/mime.ts';

test('maps extensions case-insensitively', () => {
  expect(contentTypeFor('A.HTML')).toBe('text/html; charset=utf-8');
  expect(contentTypeFor('x.htm')).toBe('text/html; charset=utf-8');
  expect(contentTypeFor('x.css')).toBe('text/css; charset=utf-8');
  expect(contentTypeFor('x.js')).toBe('text/javascript; charset=utf-8');
  expect(contentTypeFor('x.mjs')).toBe('text/javascript; charset=utf-8');
  expect(contentTypeFor('x.md')).toBe('text/markdown; charset=utf-8');
  expect(contentTypeFor('x.svg')).toBe('image/svg+xml');
  expect(contentTypeFor('x.mp4')).toBe('video/mp4');
  expect(contentTypeFor('x.webm')).toBe('video/webm');
  expect(contentTypeFor('x.woff2')).toBe('font/woff2');
  expect(contentTypeFor('x.jpg')).toBe('image/jpeg');
  expect(contentTypeFor('noext')).toBe('application/octet-stream');
});

test('covers the rest of the table', () => {
  expect(contentTypeFor('data.json')).toBe('application/json; charset=utf-8');
  expect(contentTypeFor('app.js.map')).toBe('application/json; charset=utf-8');
  expect(contentTypeFor('a/b/notes.TXT')).toBe('text/plain; charset=utf-8');
  expect(contentTypeFor('t.csv')).toBe('text/csv; charset=utf-8');
  expect(contentTypeFor('feed.xml')).toBe('application/xml; charset=utf-8');
  expect(contentTypeFor('report.pdf')).toBe('application/pdf');
  expect(contentTypeFor('m.wasm')).toBe('application/wasm');
  expect(contentTypeFor('song.mp3')).toBe('audio/mpeg');
  expect(contentTypeFor('f.ttf')).toBe('font/ttf');
});

test('only the last segment decides the extension', () => {
  expect(contentTypeFor('v1.2/README')).toBe('application/octet-stream');
  expect(contentTypeFor('.htaccess')).toBe('application/octet-stream');
  expect(contentTypeFor('archive.')).toBe('application/octet-stream');
});

test('classifies text and raster types', () => {
  for (const p of ['a.html', 'a.css', 'a.js', 'a.json', 'a.md', 'a.svg'])
    expect(isTextType(contentTypeFor(p))).toBe(true);
  expect(isTextType(contentTypeFor('a.png'))).toBe(false);
  expect(isTextType(contentTypeFor('a.pdf'))).toBe(false);
  for (const p of ['a.png', 'a.jpeg', 'a.webp', 'a.gif', 'a.avif'])
    expect(isRasterImage(contentTypeFor(p))).toBe(true);
  expect(isRasterImage(contentTypeFor('a.svg'))).toBe(false);
  expect(isRasterImage('IMAGE/PNG')).toBe(true);
});
