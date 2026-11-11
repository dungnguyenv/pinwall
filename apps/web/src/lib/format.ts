// The UI is English only, so every formatter pins 'en' rather than the browser's locale.
const LOCALE = 'en';

const byteCount = new Intl.NumberFormat(LOCALE, {
  style: 'unit',
  unit: 'byte',
  unitDisplay: 'long',
});

const BYTE_UNITS = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte'].map(
  (unit) =>
    new Intl.NumberFormat(LOCALE, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: 1,
    }),
);

/**
 * A size in decimal units, the way the server's limits are set:
 * `999 bytes`, `1.5 MB`, `95 MB`. A value that would round to 1000 moves up a unit.
 */
export function formatBytes(n: number): string {
  let value = n;
  let unit = -1;
  while (unit < BYTE_UNITS.length - 1 && Math.round(value * 10) / 10 >= 1000) {
    value /= 1000;
    unit += 1;
  }
  const format = BYTE_UNITS[unit];
  return format ? format.format(value) : byteCount.format(n);
}

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

const MINUTE = 60_000;
const DAY = 86_400_000;
const YEAR = 365.2425 * DAY;

/** Each unit, its length, and the count from which the next unit up reads better. */
const RELATIVE_STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number, number]> = [
  ['minute', MINUTE, 60],
  ['hour', 60 * MINUTE, 24],
  ['day', DAY, 7],
  ['week', 7 * DAY, 5],
  ['month', YEAR / 12, 12],
];

/**
 * `ms` relative to `now`, rounded to the nearest unit: "now" within half a
 * minute either way (clocks differ a little), then "5 minutes ago",
 * "yesterday", "3 months ago", "2 years ago".
 */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const diff = ms - now;
  if (Math.round(diff / MINUTE) === 0) return relative.format(0, 'second');
  for (const [unit, length, limit] of RELATIVE_STEPS) {
    const amount = Math.round(diff / length);
    if (Math.abs(amount) < limit) return relative.format(amount, unit);
  }
  return relative.format(Math.round(diff / YEAR), 'year');
}

const mediumDate = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });

/** A calendar date in the viewer's time zone, such as "Nov 10, 2026". */
export function formatDate(ms: number): string {
  return mediumDate.format(ms);
}
