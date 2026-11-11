const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** `value` rounded to one decimal place; whole numbers print without a decimal point. */
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;

/**
 * A byte count for tool text, in decimal units with at most one decimal: 999 → "999 bytes",
 * 1_500 → "1.5 KB", 2_000_000 → "2 MB". A value that rounds up to 1000 of a unit is written in
 * the next one.
 */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} bytes`;
  let value = n / 1000;
  let unit = 0;
  while (oneDecimal(value) >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${oneDecimal(value)} ${UNITS[unit]}`;
}
