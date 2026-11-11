/**
 * Renders favicon.svg and the PNG app icons from the pin mark in
 * src/ui/pin-mark.ts. Run it from the repository root after changing the mark,
 * and commit the output:
 *
 *   node apps/web/scripts/render-icons.ts
 *
 * Node strips the types itself, so there is nothing to install. PNGs are drawn
 * by Playwright's Chromium, which the repository already depends on. If that
 * browser is not installed, run `pnpm exec playwright install chromium`, or
 * point PLAYWRIGHT_CHROMIUM_PATH at any Chromium executable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { PIN_MARK_PATHS, PIN_MARK_VIEWBOX } from '../src/ui/pin-mark.ts';

// Same values as the --pw-accent token in src/styles/tokens.css.
const ACCENT = '#4b56e3';
const ACCENT_DARK = '#8c95ff';
const WHITE = '#ffffff';

const publicDir = resolve(import.meta.dirname, '../public');
const iconsDir = resolve(publicDir, 'icons');

/** The mark's own grid, from PIN_MARK_VIEWBOX, which is square. */
const MARK_UNITS = Number(PIN_MARK_VIEWBOX.split(' ')[2]);
/** Every icon keeps the mark inside this radius, in percent of the tile: the maskable safe zone. */
const SAFE_RADIUS = 40;

const pathElements = PIN_MARK_PATHS.map((d) => `<path d="${d}"/>`);
const paths = pathElements.join('');

/** The favicon follows the tab: accent on light, a lighter accent on dark. */
function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${PIN_MARK_VIEWBOX}">
  <title>Pinwall</title>
  <style>
    path { fill: ${ACCENT}; }
    @media (prefers-color-scheme: dark) {
      path { fill: ${ACCENT_DARK}; }
    }
  </style>
  ${pathElements.join('\n  ')}
</svg>
`;
}

type Tile = {
  /** Output file name inside public/icons. */
  file: string;
  /** Output size in pixels. */
  px: number;
  /** Corner radius as a percentage of the tile; 0 draws a full-bleed square. */
  radius: number;
  /** Width of the mark's grid as a percentage of the tile. */
  mark: number;
};

// Maskable icons are cropped by the OS to a circle, square or squircle. Only the
// circle of radius 40% around the centre is guaranteed to survive, so the mark
// stays inside it. The iOS touch icon is a full-bleed square because iOS rounds
// it and paints transparent corners black.
const TILES: readonly Tile[] = [
  { file: 'icon-192.png', px: 192, radius: 22, mark: 72 },
  { file: 'icon-512.png', px: 512, radius: 22, mark: 72 },
  { file: 'icon-maskable-512.png', px: 512, radius: 0, mark: 68 },
  { file: 'apple-touch-icon.png', px: 180, radius: 0, mark: 72 },
];

/** An accent tile with the white mark centred on it, on a 100-unit canvas. */
function tileSvg(tile: Tile, reach: number): string {
  const scale = tile.mark / MARK_UNITS;
  const offset = (100 - tile.mark) / 2;
  if (reach * scale > SAFE_RADIUS) {
    throw new Error(
      `${tile.file}: the mark reaches ${(reach * scale).toFixed(1)}% from the centre, past the ${SAFE_RADIUS}% safe zone`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">
  <rect width="100" height="100" rx="${tile.radius}" fill="${ACCENT}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="${WHITE}">${paths}</g>
</svg>`;
}

/** How far the mark's outline gets from the centre of its grid, in grid units. */
async function markReach(page: Page): Promise<number> {
  await page.setContent(`<svg viewBox="${PIN_MARK_VIEWBOX}">${paths}</svg>`);
  const reach = await page.$$eval(
    'path',
    (elements, centre) => {
      let farthest = 0;
      for (const shape of elements as SVGPathElement[]) {
        const length = shape.getTotalLength();
        for (let step = 0; step <= 400; step += 1) {
          const point = shape.getPointAtLength((length * step) / 400);
          farthest = Math.max(farthest, Math.hypot(point.x - centre, point.y - centre));
        }
      }
      return farthest;
    },
    MARK_UNITS / 2,
  );
  await page.close();
  return reach;
}

mkdirSync(iconsDir, { recursive: true });
writeFileSync(resolve(publicDir, 'favicon.svg'), faviconSvg());

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH });
try {
  const reach = await markReach(await browser.newPage());
  for (const tile of TILES) {
    const page = await browser.newPage({ viewport: { width: tile.px, height: tile.px } });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${tileSvg(tile, reach)}`,
    );
    // omitBackground keeps the rounded corners transparent.
    const png = await page.screenshot({ type: 'png', omitBackground: true });
    writeFileSync(resolve(iconsDir, tile.file), png);
    await page.close();
    console.log(`${tile.file} ${tile.px}x${tile.px}`);
  }
} finally {
  await browser.close();
}
