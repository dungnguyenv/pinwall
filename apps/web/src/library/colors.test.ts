import { expect, test } from 'vitest';
import { generatedCardColors, parseColor } from './colors.ts';

test('parses the theme colors the server accepts', () => {
  expect(parseColor('#0ea5e9')).toEqual({ r: 14, g: 165, b: 233 });
  expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3 });
  expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0 });
  for (const bad of ['rebeccapurple', 'red;background:url(x)', 'rgb(1,2)', '', null]) {
    expect(parseColor(bad)).toBeNull();
  }
});

test('parses the other forms and ignores alpha', () => {
  expect(parseColor('#0EA5E980')).toEqual({ r: 14, g: 165, b: 233 });
  expect(parseColor('#f008')).toEqual({ r: 255, g: 0, b: 0 });
  expect(parseColor('  RGBA(10, 20, 30, 0.5) ')).toEqual({ r: 10, g: 20, b: 30 });
  expect(parseColor('rgb(100%, 0%, 50%)')).toEqual({ r: 255, g: 0, b: 128 });
  expect(parseColor('rgb(10 20 30)')).toEqual({ r: 10, g: 20, b: 30 });
  expect(parseColor('rgb(300, -4, 12.6)')).toEqual({ r: 255, g: 0, b: 13 });
  expect(parseColor('hsla(120, 100%, 25%, 1)')).toEqual({ r: 0, g: 128, b: 0 });
  expect(parseColor('hsl(-120 100% 50%)')).toEqual({ r: 0, g: 0, b: 255 });
  for (const bad of [
    '#ff',
    '#fffff',
    '#ggg',
    'rgb(1, 2, 3, 4, 5)',
    'rgb(1,,2,3)',
    'rgb(a, b, c)',
    'hsl(0, 100%)',
    'rgb(1, 2, 3',
    'var(--x)',
    'rgb(1 2 3) red',
  ]) {
    expect(parseColor(bad)).toBeNull();
  }
});

test('generated cards use only computed colors and readable text', () => {
  const dark = generatedCardColors('art_1', '#111111');
  expect(dark.foreground).toBe('#ffffff');
  expect(generatedCardColors('art_1', '#fafafa').foreground).toBe('#0d0d0d');
  const a = generatedCardColors('art_1', 'url(x)');
  expect(a).toEqual(generatedCardColors('art_1', null)); // deterministic fallback
  for (const v of Object.values(a)) expect(v).toMatch(/^(rgb\(\d+ \d+ \d+\)|#0d0d0d|#ffffff)$/);
});

test('a theme color is used as the background, and the accent leans toward the text', () => {
  expect(generatedCardColors('x', '#0ea5e9').background).toBe('rgb(14 165 233)');
  // 18 % of the way from #111111 to white.
  expect(generatedCardColors('x', '#111111').accent).toBe('rgb(60 60 60)');
  // 18 % of the way from #fafafa to #0d0d0d.
  expect(generatedCardColors('x', '#fafafa').accent).toBe('rgb(207 207 207)');
});

test('artifacts without a theme color spread over several hues', () => {
  const backgrounds = new Set(
    Array.from({ length: 60 }, (_, i) => generatedCardColors(`art_${i}`, null).background),
  );
  expect(backgrounds.size).toBeGreaterThanOrEqual(6);
  expect(backgrounds.size).toBeLessThanOrEqual(10);
});
