import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge knows Tailwind's default scales; teach it Pinwall's named
// shadows and animations so `cn('shadow-card', 'shadow-popover')` keeps one.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['card', 'popover', 'dialog'],
      animate: [
        'fade-in',
        'fade-out',
        'pop-in',
        'pop-out',
        'dialog-in',
        'dialog-out',
        'sheet-in',
        'sheet-out',
        'drawer-in',
        'drawer-out',
        'shimmer',
      ],
    },
  },
});

/** Joins class names and lets later Tailwind classes override earlier ones. */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
