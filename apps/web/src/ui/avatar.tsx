import { cn } from './cn.ts';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function firstGrapheme(word: string): string {
  for (const { segment } of segmenter.segment(word)) return segment;
  return '';
}

/**
 * Up to two initials: the first and last word's first grapheme, upper-cased.
 * Graphemes keep 'đ', emoji and combined marks whole. A blank name gives '?'.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return [first, last]
    .filter((word): word is string => Boolean(word))
    .map((word) => firstGrapheme(word).toLocaleUpperCase())
    .join('');
}

// Full class names, so Tailwind finds them when it scans this file.
const HUES = [
  'bg-avatar-1 text-avatar-1-fg',
  'bg-avatar-2 text-avatar-2-fg',
  'bg-avatar-3 text-avatar-3-fg',
  'bg-avatar-4 text-avatar-4-fg',
  'bg-avatar-5 text-avatar-5-fg',
  'bg-avatar-6 text-avatar-6-fg',
  'bg-avatar-7 text-avatar-7-fg',
  'bg-avatar-8 text-avatar-8-fg',
] as const;

/** FNV-1a over the code points, so a name always lands on the same hue. */
function hueIndex(name: string): number {
  let hash = 0x811c9dc5;
  for (const char of name.trim().toLocaleLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % HUES.length;
}

const SIZES = {
  sm: 'size-6 text-xs',
  md: 'size-8 text-sm',
  lg: 'size-10 text-md',
} as const;

/**
 * Initials on a tinted disc. Decorative (aria-hidden): Pinwall always shows the
 * person's name next to it, and an icon-only use goes inside a labelled
 * IconButton. Never loads `avatar_url`: the app CSP blocks remote images.
 */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid shrink-0 select-none place-items-center rounded-full font-semibold leading-none tracking-tight',
        HUES[hueIndex(name)],
        SIZES[size],
      )}
    >
      {initials(name)}
    </span>
  );
}
