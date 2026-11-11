import { type JSX, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { PublicConfig } from '../api/dto.ts';
import { Badge, cn } from '../ui/index.ts';

const MODES = [
  {
    value: 'single-domain',
    title: 'web.isolation.single.title',
    body: 'web.isolation.single.body',
  },
  {
    value: 'content-domain',
    title: 'web.isolation.content.title',
    body: 'web.isolation.content.body',
  },
] as const satisfies readonly { value: PublicConfig['isolation']; title: string; body: string }[];

/**
 * The two ways Pinwall keeps artifact pages away from the app, in plain
 * words, with the mode in use marked Current, then the trade-off between
 * them. `compact` fits it inside a form, such as setup: one quiet panel,
 * modes stacked. Otherwise the modes sit side by side on wide screens.
 */
export function IsolationExplainer({
  current,
  compact = false,
}: {
  current: PublicConfig['isolation'];
  compact?: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(compact && 'rounded-lg bg-surface-muted px-4 py-4 text-sm')}
    >
      <h2 id={headingId} className={cn('font-semibold text-fg', compact ? 'text-base' : 'text-lg')}>
        {t('web.isolation.title')}
      </h2>
      <ul
        className={cn(
          'mt-3',
          compact ? 'flex flex-col divide-y divide-border' : 'grid gap-3 sm:grid-cols-2',
        )}
      >
        {MODES.map((mode) => {
          const isCurrent = mode.value === current;
          return (
            <li
              key={mode.value}
              className={cn(
                compact
                  ? 'py-3 first:pt-0 last:pb-0'
                  : 'rounded-lg border bg-surface p-4 text-base',
                !compact && (isCurrent ? 'border-accent' : 'border-border'),
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="font-medium text-fg">{t(mode.title)}</h3>
                {isCurrent ? <Badge tone="accent">{t('web.isolation.current')}</Badge> : null}
              </div>
              <p className="mt-1 text-pretty text-fg-muted">{t(mode.body)}</p>
            </li>
          );
        })}
      </ul>
      <p className={cn('text-pretty text-fg-muted', compact ? 'mt-3' : 'mt-4 text-base')}>
        {t('web.isolation.tradeoff')}
      </p>
    </section>
  );
}
