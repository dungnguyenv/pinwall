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

/** Types whose bytes are text: `text/*`, JavaScript, JSON, XML and SVG. */
export function isTextType(contentType: string): boolean {
  const type = mediaType(contentType);
  return type.startsWith('text/') || TEXT_TYPES.has(type);
}

/** PNG, JPEG, WebP, GIF and AVIF: the images a browser decodes to pixels. */
export function isRasterImage(contentType: string): boolean {
  return RASTER_TYPES.has(mediaType(contentType));
}

/** `type/subtype` without parameters, lower-cased. */
function mediaType(contentType: string): string {
  return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
}
