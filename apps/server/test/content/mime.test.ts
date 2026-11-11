import { expect, test } from 'vitest';
import {
  contentTypeFor,
  hasRasterSignature,
  isRasterImage,
  isTextType,
} from '../../src/content/mime.ts';

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

/** An ISO media `ftyp` box: size, type, major brand, minor version, compatible brands. */
function ftyp(major: string, compatible: string[], size?: number): Buffer {
  const box = Buffer.alloc(16 + 4 * compatible.length);
  box.writeUInt32BE(size ?? box.length, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(major, 8, 'latin1');
  compatible.forEach((brand, i) => {
    box.write(brand, 16 + 4 * i, 'latin1');
  });
  return box;
}

test('raster signatures must match the claimed type', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  const gif = Buffer.from('GIF89a\x01\x00', 'latin1');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const avif = ftyp('avif', ['mif1', 'miaf']);
  const good: [string, Buffer][] = [
    ['image/png', png],
    ['image/jpeg', jpeg],
    ['image/gif', gif],
    ['image/gif', Buffer.from('GIF87a', 'latin1')],
    ['image/webp', webp],
    ['image/avif', avif],
    ['image/avif', ftyp('mif1', ['miaf', 'avif'])],
    ['image/avif', ftyp('avis', [])],
    ['IMAGE/PNG; x=y', png],
  ];
  for (const [type, head] of good) expect(hasRasterSignature(type, head), type).toBe(true);

  const html = Buffer.from('<!doctype html><script>alert(1)</script>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const bad: [string, Buffer][] = [
    ['image/png', html],
    ['image/png', svg],
    ['image/png', jpeg],
    ['image/png', png.subarray(0, 7)],
    ['image/jpeg', png],
    ['image/gif', Buffer.from('GIF90a', 'latin1')],
    ['image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])],
    ['image/avif', ftyp('heic', ['mif1', 'heic'])],
    // A compatible brand past the end of the box is not one of its brands.
    ['image/avif', ftyp('mif1', ['miaf', 'avif'], 20)],
    ['image/avif', ftyp('avif', [], 12)],
    ['image/svg+xml', svg],
    ['text/html', html],
    ['image/png', Buffer.alloc(0)],
  ];
  for (const [type, head] of bad) expect(hasRasterSignature(type, head), type).toBe(false);
});
