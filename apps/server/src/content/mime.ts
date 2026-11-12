import { htmlCharset } from './html-charset.ts';

const UTF8 = '; charset=utf-8';

/** Lower-case extension → Content-Type. Text types carry their charset. */
const TYPES: Readonly<Record<string, string>> = {
  html: `text/html${UTF8}`,
  htm: `text/html${UTF8}`,
  css: `text/css${UTF8}`,
  js: `text/javascript${UTF8}`,
  mjs: `text/javascript${UTF8}`,
  json: `application/json${UTF8}`,
  map: `application/json${UTF8}`,
  md: `text/markdown${UTF8}`,
  txt: `text/plain${UTF8}`,
  csv: `text/csv${UTF8}`,
  xml: `application/xml${UTF8}`,
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};

const FALLBACK = 'application/octet-stream';

const TEXT_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/xml',
  'image/svg+xml',
]);

const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

/** The Content-Type for a stored path, from the extension of its last segment. */
export function contentTypeFor(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return FALLBACK;
  const extension = basename.slice(dot + 1).toLowerCase();
  return Object.hasOwn(TYPES, extension) ? (TYPES[extension] ?? FALLBACK) : FALLBACK;
}

/**
 * The Content-Type a stored file is served with: `contentTypeFor` its path, except that an HTML
 * file's charset is the one its bytes declare (`htmlCharset`), UTF-8 when they declare none.
 */
export function contentTypeOf(path: string, bytes: Buffer): string {
  const type = contentTypeFor(path);
  return isHtmlType(type) ? `text/html; charset=${htmlCharset(bytes)}` : type;
}

/** Types whose bytes are text: `text/*`, JavaScript, JSON, XML and SVG. */
export function isTextType(contentType: string): boolean {
  const type = mediaType(contentType);
  return type.startsWith('text/') || TEXT_TYPES.has(type);
}

/** `text/html`, whatever its parameters. */
export function isHtmlType(contentType: string): boolean {
  return mediaType(contentType) === 'text/html';
}

/** `text/markdown`, whatever its parameters. */
export function isMarkdownType(contentType: string): boolean {
  return mediaType(contentType) === 'text/markdown';
}

/** PNG, JPEG, WebP, GIF and AVIF: the images a browser decodes to pixels. */
export function isRasterImage(contentType: string): boolean {
  return RASTER_TYPES.has(mediaType(contentType));
}

/** How many leading bytes of a file `hasRasterSignature` looks at. */
export const RASTER_SIGNATURE_BYTES = 64;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Whether `head`, the first bytes of a file (`RASTER_SIGNATURE_BYTES` are enough), starts the way
 * the raster image type `contentType` says it does. A file named `.png` that holds HTML, SVG or
 * any other kind of image is false, and so is every type `isRasterImage` refuses.
 */
export function hasRasterSignature(contentType: string, head: Buffer): boolean {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1');
  switch (mediaType(contentType)) {
    case 'image/png':
      return head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    case 'image/jpeg':
      return head.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
    case 'image/gif':
      return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
    case 'image/webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/avif':
      return isAvif(head);
    default:
      return false;
  }
}

/**
 * An ISO media file whose leading `ftyp` box names `avif` (image) or `avis` (sequence) as its
 * major brand or one of its compatible brands. The box is size, `ftyp`, major brand, minor
 * version, then the compatible brands, four bytes each.
 */
function isAvif(head: Buffer): boolean {
  if (head.length < 16 || head.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
  const boxSize = head.readUInt32BE(0);
  if (boxSize < 16) return false;
  const brands = [head.subarray(8, 12).toString('latin1')];
  for (let at = 16; at + 4 <= Math.min(boxSize, head.length); at += 4) {
    brands.push(head.subarray(at, at + 4).toString('latin1'));
  }
  return brands.some((brand) => brand === 'avif' || brand === 'avis');
}

/** `type/subtype` without parameters, lower-cased. */
function mediaType(contentType: string): string {
  return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
}
