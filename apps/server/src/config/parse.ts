const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  kib: 1_024,
  mib: 1_024 ** 2,
  gib: 1_024 ** 3,
};

function parseQuantity(text: string, units: Record<string, number>, bare: string, what: string) {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text.trim());
  const unit = match ? (match[2] || bare).toLowerCase() : '';
  const factor = units[unit];
  if (!match || factor === undefined) {
    throw new Error(
      `"${text}" is not a valid ${what}; use a number with one of: ${Object.keys(units).join(', ')}`,
    );
  }
  return Math.round(Number(match[1]) * factor);
}

/** Milliseconds from `500`, `500ms`, `30s`, `15m`, `12h` or `7d`. A bare number is milliseconds. */
export function parseDuration(text: string): number {
  return parseQuantity(text, DURATION_UNITS, 'ms', 'duration');
}

/** Bytes from `1024`, `95MB`, `2GB` (decimal) or `2MiB`, `1GiB` (binary). A bare number is bytes. */
export function parseSize(text: string): number {
  return parseQuantity(text, SIZE_UNITS, 'b', 'size');
}

/** Splits a comma- or whitespace-separated list, trimming entries and dropping empty ones. */
export function parseList(text?: string): string[] {
  return (text ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
