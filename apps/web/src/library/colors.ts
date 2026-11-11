/*
 * Colors for an artifact's generated card. A theme color comes from the
 * artifact's own page, so it is parsed here into numbers and only ever written
 * back out as `rgb(r g b)` that this file computed: a crafted value can never
 * reach a style attribute as text.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION = /^(rgba?|hsla?)\(([^()]*)\)$/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function parseHex(digits: string): Rgb {
  const full =
    digits.length <= 4
      ? [...digits.slice(0, 3)].map((digit) => digit + digit).join('')
      : digits.slice(0, 6);
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** A plain number, or a percentage with `percent` set. `null` for anything else. */
function parseComponent(text: string): { value: number; percent: boolean } | null {
  const percent = text.endsWith('%');
  const number = percent ? text.slice(0, -1) : text;
  if (!NUMBER.test(number)) return null;
  return { value: Number(number), percent };
}

/**
 * The comma-separated or space-separated arguments of `rgb()` or `hsl()`:
 * three, plus an optional alpha that is checked and then ignored.
 */
function parseArguments(body: string): { value: number; percent: boolean }[] | null {
  const trimmed = body.trim();
  const parts = trimmed.includes(',')
    ? trimmed.split(',').map((part) => part.trim())
    : trimmed.split(/\s+/);
  if (parts.length < 3 || parts.length > 4) return null;
  const parsed = parts.map(parseComponent);
  if (parsed.some((part) => part === null)) return null;
  return parsed as { value: number; percent: boolean }[];
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const sector = Math.floor(h);
  const [r, g, b] =
    sector === 0
      ? [chroma, x, 0]
      : sector === 1
        ? [x, chroma, 0]
        : sector === 2
          ? [0, chroma, x]
          : sector === 3
            ? [0, x, chroma]
            : sector === 4
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = l - chroma / 2;
  return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255) };
}

/**
 * A theme color as numbers: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()`/`rgba()` and `hsl()`/`hsla()`, alpha ignored. Named colors and
 * anything else give `null`, and the card falls back to a fixed hue.
 */
export function parseColor(input: string | null): Rgb | null {
  if (input === null) return null;
  const text = input.trim();
  const hex = HEX.exec(text);
  if (hex?.[1]) return parseHex(hex[1]);

  const call = FUNCTION.exec(text);
  if (!call?.[1] || call[2] === undefined) return null;
  const args = parseArguments(call[2]);
  if (!args) return null;
  const [first, second, third] = args as [
    { value: number; percent: boolean },
    { value: number; percent: boolean },
    { value: number; percent: boolean },
  ];

  if (call[1].toLowerCase().startsWith('rgb')) {
    const channel = (c: { value: number; percent: boolean }) =>
      clampByte(c.percent ? (c.value / 100) * 255 : c.value);
    return { r: channel(first), g: channel(second), b: channel(third) };
  }
  if (first.percent) return null;
  return hslToRgb(first.value, second.value / 100, third.value / 100);
}

/*
 * The hues a card gets when its page names no theme color: seven deep ones
 * that carry white text and three pale ones that carry dark text, so a wall of
 * cards reads as a varied set of prints rather than one flat color.
 */
const FALLBACK_HUES: readonly Rgb[] = [
  { r: 47, g: 79, b: 184 }, // ink blue
  { r: 30, g: 107, b: 92 }, // pine
  { r: 163, g: 50, b: 79 }, // berry
  { r: 90, g: 70, b: 176 }, // iris
  { r: 93, g: 122, b: 46 }, // moss
  { r: 61, g: 74, b: 92 }, // slate
  { r: 196, g: 138, b: 29 }, // ochre
  { r: 230, g: 220, b: 198 }, // sand
  { r: 201, g: 220, b: 203 }, // sage
  { r: 217, g: 211, b: 239 }, // lilac
];

const DARK_TEXT = '#0d0d0d';
const LIGHT_TEXT = '#ffffff';
const DARK_RGB: Rgb = { r: 13, g: 13, b: 13 };
const LIGHT_RGB: Rgb = { r: 255, g: 255, b: 255 };
const ACCENT_SHIFT = 0.18;

/** 32-bit FNV-1a over the UTF-16 code units of `text`. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** WCAG 2.x relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function css({ r, g, b }: Rgb): string {
  return `rgb(${r} ${g} ${b})`;
}

/**
 * The colors of a generated card: the theme color when it parses, else one of
 * ten fixed hues picked by `seed`; the text color, near-black or white,
 * whichever contrasts more; and an accent 18 % of the way from the
 * background toward the text, for the kind glyph's tile.
 */
export function generatedCardColors(
  seed: string,
  themeColor: string | null,
): { background: string; foreground: string; accent: string } {
  const background =
    parseColor(themeColor) ?? (FALLBACK_HUES[fnv1a(seed) % FALLBACK_HUES.length] as Rgb);
  const dark = contrast(background, DARK_RGB) >= contrast(background, LIGHT_RGB);
  const text = dark ? DARK_RGB : LIGHT_RGB;
  const mix = (from: number, to: number) => clampByte(from + (to - from) * ACCENT_SHIFT);
  return {
    background: css(background),
    foreground: dark ? DARK_TEXT : LIGHT_TEXT,
    accent: css({
      r: mix(background.r, text.r),
      g: mix(background.g, text.g),
      b: mix(background.b, text.b),
    }),
  };
}
