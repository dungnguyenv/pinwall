/**
 * The Pinwall mark: a push-pin pressed into a wall, drawn from three shapes on
 * a 24-unit grid. A domed cap, a rounded flange and a tapered needle, tilted
 * 22 degrees so it reads as pushed in rather than standing. The shapes overlap
 * so a single fill leaves no seam.
 *
 * This file holds only data, so the icon renderer (scripts/render-icons.ts,
 * which runs under plain Node) can import it. favicon.svg and the app icons are
 * generated from these strings; logo.tsx draws the same strings in the app.
 */
export const PIN_MARK_VIEWBOX = '0 0 24 24';

export const PIN_MARK_PATHS: readonly string[] = [
  // Cap
  'M5.29 9.75A5.75 5.75 0 0 1 8.47 2.26L8.47 2.26A5.75 5.75 0 0 1 15.95 5.44L17.36 8.92L6.69 13.23Z',
  // Flange
  'M3.68 14.44A1.5 1.5 0 0 1 4.51 12.49L18.42 6.87A1.5 1.5 0 0 1 20.37 7.7L20.37 7.7A1.5 1.5 0 0 1 19.54 9.65L5.63 15.27A1.5 1.5 0 0 1 3.68 14.44Z',
  // Needle
  'M10.73 11.6L13.32 10.55L16.85 21.77A0.3 0.3 0 0 1 16.68 22.13L16.36 22.26A0.3 0.3 0 0 1 15.98 22.12Z',
];
