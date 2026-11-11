import { expect, test } from 'vitest';
import indexCss from '../index.css?raw';
import tokensCss from './tokens.css?raw';

/** The text between the first `{` at or after `from` and its matching `}`. */
function blockAt(css: string, from: number): string {
  const open = css.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces');
}

function tokenNames(css: string): string[] {
  return [...css.matchAll(/(--pw-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string);
}

const lightRoot = blockAt(tokensCss, tokensCss.indexOf(':root'));
const darkStart = tokensCss.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = darkStart === -1 ? '' : blockAt(tokensCss, darkStart);
const lightNames = tokenNames(lightRoot);

test('the light root declares both color schemes and the full color set', () => {
  expect(lightRoot).toMatch(/color-scheme:\s*light dark/);
  for (const name of ['canvas', 'fg', 'primary', 'accent', 'danger-soft', 'overlay']) {
    expect(lightNames).toContain(`--pw-${name}`);
  }
});

test('every light token is redefined for dark mode', () => {
  expect(darkStart).toBeGreaterThan(-1);
  const darkNames = tokenNames(darkBlock);
  expect(new Set(darkNames)).toEqual(new Set(lightNames));
  expect(darkNames).toHaveLength(lightNames.length);
});

test('index.css maps every token to a Tailwind color and turns the default palette off', () => {
  expect(indexCss).toContain('@import "./styles/tokens.css"');
  expect(indexCss).toContain('--color-*: initial');
  for (const name of lightNames) {
    expect(indexCss).toContain(`--color-${name.slice('--pw-'.length)}: var(${name});`);
  }
});

/** The value of `--pw-<name>` inside one theme block, which must be a 6-digit hex. */
function tokenHex(block: string, name: string): string {
  const match = new RegExp(`--pw-${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i').exec(block);
  if (!match) throw new Error(`--pw-${name} is not a hex color in this block`);
  return match[1] as string;
}

/** WCAG 2.x relative luminance of an sRGB hex color. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

/** WCAG 2.x contrast ratio between two hex colors (1 to 21). */
function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
}

test('the contrast helper agrees with the WCAG reference values', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
});

test.each([
  ['light', lightRoot],
  ['dark', darkBlock],
])(
  '%s theme: control edges (border-strong) reach 3:1 on the surfaces controls sit on',
  (_, block) => {
    // WCAG 1.4.11 non-text contrast: the edge of an input or an outlined button.
    const edge = tokenHex(block, 'border-strong');
    for (const surface of ['canvas', 'sidebar', 'surface', 'surface-muted']) {
      expect(
        contrast(edge, tokenHex(block, surface)),
        `border-strong on ${surface}`,
      ).toBeGreaterThanOrEqual(3);
    }
  },
);
