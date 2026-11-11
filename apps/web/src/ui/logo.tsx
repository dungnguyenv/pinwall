import { useTranslation } from 'react-i18next';
import { cn } from './cn.ts';
import { PIN_MARK_PATHS, PIN_MARK_VIEWBOX } from './pin-mark.ts';

export { PIN_MARK_PATHS, PIN_MARK_VIEWBOX };

/**
 * The pin, filled with the current text color (accent by default). Hidden from
 * assistive tech unless a `title` names it: next to the product name it is
 * decoration, and on its own it needs a label.
 */
export function PinMark({
  size = 24,
  title,
  className,
}: {
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox={PIN_MARK_VIEWBOX}
      width={size}
      height={size}
      fill="currentColor"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={cn('shrink-0 text-accent', className)}
    >
      {PIN_MARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const SIZES = {
  sm: { mark: 20, text: 'text-md' },
  md: { mark: 24, text: 'text-lg' },
  lg: { mark: 32, text: 'text-2xl' },
} as const;

/** The mark and the product name. The name labels the link or heading around it. */
export function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation();
  const { mark, text } = SIZES[size];
  return (
    <span className="inline-flex items-center gap-2 text-fg">
      <PinMark size={mark} />
      <span className={cn('font-semibold leading-none tracking-tight', text)}>{t('app.name')}</span>
    </span>
  );
}
