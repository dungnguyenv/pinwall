/** The screen size the artifact is shown at. */
export type Device = 'desktop' | 'tablet' | 'phone' | 'custom';

/** CSS widths of the fixed device sizes. */
export const DEVICE_WIDTH = { tablet: 768, phone: 390 } as const;
/** The range and default of a custom width, in CSS pixels. */
export const CUSTOM_WIDTH = { min: 240, max: 3840, default: 1440 } as const;
/** Space kept around a framed device on the stage. */
export const STAGE_GUTTER = 24;

/**
 * The frame's size in the artifact's own CSS pixels, and the scale it is drawn
 * at to fit the stage. `framed`: a device frame centered on the stage rather
 * than the whole stage.
 */
export interface FrameBox {
  width: number;
  height: number;
  scale: number;
  framed: boolean;
}

/** A custom width as the frame uses it: whole pixels within range; not a number → the default. */
export function clampCustomWidth(n: number): number {
  if (Number.isNaN(n)) return CUSTOM_WIDTH.default;
  return Math.round(Math.min(CUSTOM_WIDTH.max, Math.max(CUSTOM_WIDTH.min, n)));
}

/**
 * The frame for `device` on a stage of `stage` pixels. Desktop fills the
 * stage. Any other device keeps its width and is scaled down (never up) to fit
 * the stage less its gutters, while its height fills the stage at that scale.
 */
export function frameBox(
  device: Device,
  customWidth: number,
  stage: { width: number; height: number },
): FrameBox {
  if (device === 'desktop') {
    return { width: stage.width, height: stage.height, scale: 1, framed: false };
  }
  const width = device === 'custom' ? clampCustomWidth(customWidth) : DEVICE_WIDTH[device];
  const room = { width: stage.width - 2 * STAGE_GUTTER, height: stage.height - 2 * STAGE_GUTTER };
  // A stage that is not measured yet (or tinier than its gutters) shows the device unscaled.
  const fit = room.width > 0 ? Math.round((room.width / width) * 10_000) / 10_000 : 1;
  const scale = Math.min(1, Math.max(fit, 0.0001));
  const height = Math.max(0, Math.round(room.height / scale));
  return { width, height, scale, framed: true };
}
