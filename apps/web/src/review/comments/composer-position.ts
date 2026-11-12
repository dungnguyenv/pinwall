import type { PickedAnchor } from '../frame/use-frame-bridge.ts';

/** The gap between the picked point and the composer's nearest corner. */
const OFFSET = 12;
/** The least room kept between the composer and each edge of the viewport. */
const GUTTER = 8;
/** The floating composer's width, and its usual height before its text grows. */
export const COMPOSER_SIZE = { width: 320, height: 196 };

/** Where along one axis the composer starts: after the point, or before it when it would not fit. */
function place(point: number, size: number, room: number): number {
  const after = point + OFFSET;
  const start = after + size > room - GUTTER ? point - OFFSET - size : after;
  // Clamped inside the gutters; a viewport narrower than the composer pins it to the first one.
  return Math.max(GUTTER, Math.min(start, room - GUTTER - size));
}

/**
 * Where the floating composer goes for a pick at `client` (CSS pixels in the
 * frame's own viewport) in a frame whose box starts at `frame` in the app's
 * viewport and is drawn at `scale`. The composer sits 12 px right of and below
 * the point, flips to the left or above it when it would overflow, and always
 * stays 8 px inside the viewport.
 */
export function composerPosition(
  client: { x: number; y: number },
  frame: { left: number; top: number },
  scale: number,
  viewport: { width: number; height: number },
  size: { width: number; height: number } = COMPOSER_SIZE,
): { left: number; top: number } {
  const x = frame.left + client.x * scale;
  const y = frame.top + client.y * scale;
  return {
    left: place(x, size.width, viewport.width),
    top: place(y, size.height, viewport.height),
  };
}

/**
 * Whether a pick's composer floats beside the point: only for a pick in the
 * top frame, which is the only one with a point the app can place, and only
 * in the docked desktop layout. Anywhere else it heads the panel or sheet.
 */
export function composerFloats(pick: PickedAnchor, layout: 'dock' | 'sheet'): boolean {
  return layout === 'dock' && pick.topFrame && pick.client !== null;
}
