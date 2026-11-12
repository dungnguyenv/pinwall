import { expect, test } from 'vitest';
import { CUSTOM_WIDTH, clampCustomWidth, type Device, frameBox } from './device.ts';

test.each([
  [
    'desktop',
    1440,
    { width: 1000, height: 800 },
    { width: 1000, height: 800, scale: 1, framed: false },
  ],
  [
    'tablet',
    1440,
    { width: 1000, height: 800 },
    { width: 768, height: 752, scale: 1, framed: true },
  ],
  [
    'phone',
    1440,
    { width: 1000, height: 800 },
    { width: 390, height: 752, scale: 1, framed: true },
  ],
  [
    'custom',
    1904,
    { width: 1000, height: 800 },
    { width: 1904, height: 1504, scale: 0.5, framed: true },
  ],
])('frameBox(%s)', (d, w, stage, out) => expect(frameBox(d as Device, w, stage)).toEqual(out));

test('custom widths are clamped', () => {
  expect([
    clampCustomWidth(100),
    clampCustomWidth(5000),
    clampCustomWidth(Number.NaN),
    clampCustomWidth(1023.6),
  ]).toEqual([240, 3840, 1440, 1024]);
  expect(clampCustomWidth(Number.POSITIVE_INFINITY)).toBe(CUSTOM_WIDTH.max);
});

test('a custom width outside the range is clamped before it is scaled', () => {
  expect(frameBox('custom', 9000, { width: 1000, height: 800 })).toEqual({
    width: 3840,
    height: 3033,
    scale: 0.2479,
    framed: true,
  });
});

test('a stage not measured yet gives a usable box', () => {
  for (const device of ['desktop', 'tablet', 'phone', 'custom'] as const) {
    const box = frameBox(device, 1440, { width: 0, height: 0 });
    expect(box.scale).toBeGreaterThan(0);
    expect(box.width).toBeGreaterThanOrEqual(0);
    expect(box.height).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(box.height)).toBe(true);
  }
});
