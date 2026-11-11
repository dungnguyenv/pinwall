import { cn } from './cn.ts';

/**
 * A ring with a turning arc, drawn in currentColor. With a `label` it is a
 * polite live region that names what is loading; without one it is decorative.
 */
export function Spinner({
  label,
  size = 16,
  className,
}: {
  label?: string;
  size?: number;
  className?: string;
}) {
  const ring = (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      className={cn(
        'shrink-0 animate-spin motion-reduce:animate-[spin_1.6s_linear_infinite]',
        className,
      )}
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="1.75"
      />
      <path
        d="M8 1.75A6.25 6.25 0 0 1 14.25 8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
  if (!label) return ring;
  return (
    <span role="status" className="inline-flex shrink-0">
      {ring}
      <span className="sr-only">{label}</span>
    </span>
  );
}
