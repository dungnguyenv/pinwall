import { type ReactNode, useId } from 'react';
import { cn } from '../../ui/index.ts';

/**
 * One section of a settings page: a titled box that holds a form or a list.
 * The title is the section's heading and its accessible name, so a screen
 * reader can jump to "Password" or "Passkeys" directly.
 */
export function SettingsCard({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="overflow-hidden rounded-lg border border-border bg-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 pt-5 pb-5 sm:px-5">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id={titleId} className="font-semibold text-fg text-md">
            {title}
          </h2>
          {description ? (
            <div className="mt-1 text-pretty text-base text-fg-muted">{description}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** The padded body of a card that holds a form or other loose content. */
export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('border-border border-t px-4 py-5 sm:px-5', className)}>{children}</div>
  );
}

/** A card's list: rows run edge to edge, separated by hairlines. */
export function CardRows({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y divide-border border-border border-t">
      {children}
    </ul>
  );
}

/**
 * Small facts about a row, such as when it was made and last used. Each is a
 * term with its value, so a screen reader hears "Created: Nov 1, 2026".
 */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-0.5 text-fg-muted text-sm">
      {items.map((item) => (
        <div key={item.label} className="flex gap-1.5">
          <dt>{item.label}</dt> <dd className="text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
