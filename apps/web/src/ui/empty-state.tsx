import type { ReactNode } from 'react';

/**
 * What a list shows when it has nothing yet: the icon sits on a dashed tile,
 * an empty slot waiting for its first pin, then the title, a line on how to
 * fill it, and the action that does.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-4 py-12 text-center">
      <div
        aria-hidden="true"
        className="mb-4 grid size-12 place-items-center rounded-xl border border-border-strong border-dashed text-fg-muted [&_svg]:size-5"
      >
        {icon}
      </div>
      <p className="font-semibold text-fg text-md">{title}</p>
      {description ? <div className="mt-1 text-base text-fg-muted">{description}</div> : null}
      {action ? <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
