import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import tokensCss from '../styles/tokens.css?raw';
import { Logo, PIN_MARK_PATHS, PIN_MARK_VIEWBOX, PinMark } from './index.ts';

const webRoot = resolve(import.meta.dirname, '../..');
const publicPath = (file: string) => resolve(webRoot, 'public', file);

// The first --pw-accent in tokens.css is the light value, the second the dark one.
const [accentLight, accentDark] = [...tokensCss.matchAll(/--pw-accent:\s*#([0-9a-f]{6})/g)].map(
  (match) => match[1] as string,
);
const TILE = [...Buffer.from(accentLight as string, 'hex'), 255];

test('the mark is at most three shapes', () => {
  expect(PIN_MARK_PATHS.length).toBeGreaterThan(0);
  expect(PIN_MARK_PATHS.length).toBeLessThanOrEqual(3);
});

test('favicon draws the same mark and adapts to dark tabs', () => {
  const svg = readFileSync(publicPath('favicon.svg'), 'utf8');
  for (const d of PIN_MARK_PATHS) expect(svg).toContain(`d="${d}"`);
  expect(svg).toContain('prefers-color-scheme: dark');
  expect(svg).toContain(`viewBox="${PIN_MARK_VIEWBOX}"`);
});

test('favicon colors come from the accent tokens', () => {
  const svg = readFileSync(publicPath('favicon.svg'), 'utf8');
  expect(svg).toContain(`fill: #${accentLight};`);
  expect(svg).toContain(`fill: #${accentDark};`);
});

test('manifest names Pinwall and lists the icons', () => {
  const manifest = JSON.parse(readFileSync(publicPath('manifest.webmanifest'), 'utf8'));
  expect(manifest).toMatchObject({
    name: 'Pinwall',
    short_name: 'Pinwall',
    start_url: '/',
    display: 'standalone',
    theme_color: '#ffffff',
    background_color: '#ffffff',
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }),
      expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512' }),
      expect.objectContaining({
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        purpose: 'maskable',
      }),
    ]),
  );
});

test.each([
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
])('%s is a %ipx PNG', (file, size) => {
  // PNG signature, then the IHDR chunk: width and height are big-endian u32 at bytes 16 and 20.
  const bytes = readFileSync(publicPath(`icons/${file}`));
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  expect(bytes.readUInt32BE(16)).toBe(size);
  expect(bytes.readUInt32BE(20)).toBe(size);
});

test('index.html links the icons and the manifest', () => {
  const html = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
  expect(html).toContain('rel="icon" href="/favicon.svg" type="image/svg+xml"');
  expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
  expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  expect(html).toContain('<meta name="color-scheme" content="light dark"');
  expect(html).toMatch(
    /<meta name="theme-color" content="#ffffff" media="\(prefers-color-scheme: light\)"/,
  );
  expect(html).toMatch(
    /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)"/,
  );
});

test('PinMark is hidden from assistive tech unless titled', () => {
  const { container, rerender } = render(<PinMark />);
  const decorative = container.querySelector('svg');
  expect(decorative).toHaveAttribute('aria-hidden', 'true');
  expect(decorative).not.toHaveAttribute('role');
  expect(decorative).toHaveAttribute('viewBox', PIN_MARK_VIEWBOX);
  expect(container.querySelectorAll('path')).toHaveLength(PIN_MARK_PATHS.length);

  rerender(<PinMark title="Pinwall" size={40} />);
  const named = screen.getByRole('img', { name: 'Pinwall' });
  expect(named).not.toHaveAttribute('aria-hidden');
  expect(named).toHaveAttribute('width', '40');
});

test('Logo shows the product name next to a decorative mark', () => {
  const { container } = render(<Logo size="lg" />);
  expect(screen.getByText('Pinwall')).toBeInTheDocument();
  expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG into RGBA pixels. */
function decodePng(bytes: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const depth = bytes[24];
  const colorType = bytes[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (depth !== 8 || channels === 0 || bytes[28] !== 0) {
    throw new Error('only 8-bit RGB/RGBA, non-interlaced PNGs are supported');
  }
  const idat: Buffer[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.subarray(at + 4, at + 8).toString() === 'IDAT') {
      idat.push(bytes.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x] as number;
      const left = x >= channels ? (out[y * stride + x - channels] as number) : 0;
      const up = y > 0 ? (out[(y - 1) * stride + x] as number) : 0;
      const upLeft = y > 0 && x >= channels ? (out[(y - 1) * stride + x - channels] as number) : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + x] = (value + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    for (let c = 0; c < 3; c += 1) rgba[i * 4 + c] = out[i * channels + c] as number;
    rgba[i * 4 + 3] = channels === 4 ? (out[i * 4 + 3] as number) : 255;
  }
  return { width, height, rgba };
}

function pixelAt(image: ReturnType<typeof decodePng>, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.rgba.subarray(at, at + 4)];
}

/** Largest distance from the centre to any near-white pixel, as a fraction of the width. */
function markRadius(image: ReturnType<typeof decodePng>): number {
  let farthest = 0;
  const centre = image.width / 2;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b, a] = pixelAt(image, x, y) as [number, number, number, number];
      if (a > 0 && r > 200 && g > 200 && b > 200) {
        farthest = Math.max(farthest, Math.hypot(x + 0.5 - centre, y + 0.5 - centre));
      }
    }
  }
  return farthest / image.width;
}

test('the maskable icon is full-bleed and keeps the white mark inside the 80% safe zone', () => {
  const image = decodePng(readFileSync(publicPath('icons/icon-maskable-512.png')));
  const last = image.width - 1;
  for (const [x, y] of [
    [0, 0],
    [last, 0],
    [0, last],
    [last, last],
  ] as const) {
    expect(pixelAt(image, x, y)).toEqual(TILE);
  }
  const radius = markRadius(image);
  expect(radius).toBeGreaterThan(0.2); // the white mark is really there
  expect(radius).toBeLessThanOrEqual(0.4); // inside the safe circle
});

test('the any-purpose icons sit on a rounded accent tile with a white mark', () => {
  for (const file of ['icon-192.png', 'icon-512.png']) {
    const image = decodePng(readFileSync(publicPath(`icons/${file}`)));
    expect(pixelAt(image, 0, 0)[3]).toBe(0); // rounded corner is transparent
    expect(pixelAt(image, 10, Math.floor(image.height / 2))).toEqual(TILE);
    expect(markRadius(image)).toBeGreaterThan(0.2);
  }
});

test('the touch icon is an opaque square for the OS to round', () => {
  const image = decodePng(readFileSync(publicPath('icons/apple-touch-icon.png')));
  expect(pixelAt(image, 0, 0)).toEqual(TILE);
  expect(pixelAt(image, image.width - 1, image.height - 1)).toEqual(TILE);
});
