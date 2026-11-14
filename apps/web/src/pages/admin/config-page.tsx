import { Lock, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminConfig } from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import { type ConfigEntry, ConfigSection } from '../../api/dto.ts';
import { IsolationExplainer } from '../../app/isolation-explainer.tsx';
import { SpacesExplainer } from '../../app/spaces-explainer.tsx';
import { formatBytes } from '../../lib/format.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { ErrorState, LoadingRegion, Skeleton } from '../../ui/index.ts';

/** The settings where 0 means no limit. */
const QUOTAS: ReadonlySet<string> = new Set([
  'PINWALL_QUOTA_BYTES',
  'PINWALL_QUOTA_ARTIFACTS',
  'PINWALL_QUOTA_FILES',
]);

/** The sections in the order the server lists them, each with its entries; empty ones are left out. */
function groupBySection(
  entries: ConfigEntry[],
): { section: ConfigSection; entries: ConfigEntry[] }[] {
  return ConfigSection.options
    .map((section) => ({ section, entries: entries.filter((e) => e.section === section) }))
    .filter((group) => group.entries.length > 0);
}

/**
 * `/admin/config`: the settings Pinwall runs with, read-only. They come from
 * environment variables, so this page explains them and changes nothing.
 */
export function ConfigPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.config.title'));
  const config = useAdminConfig();

  if (config.isPending) return <ConfigSkeleton />;
  if (config.isError) {
    return (
      <ErrorState message={errorMessage(config.error, t)} onRetry={() => void config.refetch()} />
    );
  }
  const { isolation, content_origin, entries, warnings } = config.data;
  const settingOf = (env: string) => entries.find((entry) => entry.env === env)?.value ?? null;
  const visibility = settingOf('PINWALL_VISIBILITY');
  const shareLinks = settingOf('PINWALL_SHARE_LINKS');

  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-prose text-pretty text-base text-fg-muted">{t('web.config.envNote')}</p>

      {warnings.length > 0 ? (
        <ul aria-label={t('web.config.warnings')} className="flex flex-col gap-2">
          {warnings.map((warning) => (
            <li
              key={warning}
              className="flex items-start gap-2.5 rounded-lg bg-warning-soft px-3.5 py-3 text-fg text-sm"
            >
              <TriangleAlert aria-hidden="true" className="mt-px size-4 shrink-0 text-warning" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-4">
        <IsolationExplainer current={isolation} />
        {content_origin ? (
          <p className="flex flex-wrap items-baseline gap-x-2 text-base">
            <span className="text-fg-muted">{t('web.config.contentOrigin')}</span>
            <code className="font-mono text-fg text-sm [overflow-wrap:anywhere]">
              {content_origin}
            </code>
          </p>
        ) : null}
      </div>

      {/* A server without these settings (before 1.1) has nothing to explain. */}
      {visibility !== null || shareLinks !== null ? (
        <SpacesExplainer visibility={visibility} shareLinks={shareLinks} />
      ) : null}

      {groupBySection(entries).map((group) => (
        <ConfigGroup key={group.section} section={group.section} entries={group.entries} />
      ))}
    </div>
  );
}

function ConfigGroup({ section, entries }: { section: ConfigSection; entries: ConfigEntry[] }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-lg border border-border bg-surface"
    >
      <h2
        id={headingId}
        className="border-border border-b px-4 py-3 font-semibold text-fg text-md sm:px-5"
      >
        {t(`web.config.section.${section}`)}
      </h2>
      <dl className="divide-y divide-border">
        {entries.map((entry) => (
          <ConfigRow key={entry.env} entry={entry} />
        ))}
      </dl>
    </section>
  );
}

/**
 * One setting: the variable that sets it and what it does on the left, the
 * value on the right from 768 px and under them on narrower screens.
 */
function ConfigRow({ entry }: { entry: ConfigEntry }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-x-8 gap-y-1.5 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
      <dt className="min-w-0">
        <code className="font-medium font-mono text-fg text-sm [overflow-wrap:anywhere]">
          {entry.env}
        </code>
      </dt>
      <dd className="min-w-0 text-base md:col-start-2 md:row-span-2 md:row-start-1">
        <ConfigValue entry={entry} />
      </dd>
      <dd className="min-w-0 text-pretty text-fg-muted text-sm md:col-start-1">
        {t(`web.config.help.${entry.env}`)}
      </dd>
    </div>
  );
}

function ConfigValue({ entry }: { entry: ConfigEntry }) {
  const { t } = useTranslation();
  const notSet = <span className="text-fg-muted">{t('web.config.notSet')}</span>;

  if (entry.secret) {
    // The server never sends a secret, only whether there is one.
    return entry.set ? (
      <span className="inline-flex items-center gap-1.5 text-fg">
        <Lock aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
        {t('web.config.secretSet')}
      </span>
    ) : (
      notSet
    );
  }
  if (entry.value === null) return notSet;
  // For a quota, 0 is a choice (no limit), not a size of zero bytes.
  if (QUOTAS.has(entry.env) && entry.value === '0') {
    return <span className="text-fg">{t('web.config.noLimit')}</span>;
  }

  const bytes = entry.env.endsWith('_BYTES') ? Number(entry.value) : Number.NaN;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <code className="font-mono text-fg text-sm [overflow-wrap:anywhere]">{entry.value}</code>
      {Number.isFinite(bytes) ? (
        <span className="text-fg-muted text-sm">
          {t('web.config.approx', { size: formatBytes(bytes) })}
        </span>
      ) : null}
    </span>
  );
}

function ConfigSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.config.loading')}>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-4 w-full max-w-prose" />
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    </LoadingRegion>
  );
}
