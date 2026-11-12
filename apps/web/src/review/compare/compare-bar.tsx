import { ArrowLeft, ArrowLeftRight } from 'lucide-react';
import { useContext, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';
import type { ArtifactSummary, VersionSummary } from '../../api/dto.ts';
import { reviewPath } from '../../api/versions.ts';
import { HeadingFocusContext } from '../../app/shell/page-header.tsx';
import { IconButton, Segmented, Select, Switch } from '../../ui/index.ts';
import type { CompareView } from './defaults.ts';

/**
 * The page's heading, for screen readers: the bar's own words already say
 * where you are. It takes focus on arrival, as every page's heading does.
 */
export function CompareHeading({ name }: { name: string }) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useContext(HeadingFocusContext);
  const { pathname } = useLocation();
  useEffect(() => {
    if (pending === null || pending.current !== pathname) return;
    pending.current = null;
    heading.current?.focus({ preventScroll: true });
  }, [pending, pathname]);
  return (
    <h1 ref={heading} tabIndex={-1} className="sr-only">
      {t('web.compare.heading', { name })}
    </h1>
  );
}

/** A link back to the artifact's review, under its name. */
export function BackLink({ artifact, compact }: { artifact: ArtifactSummary; compact: boolean }) {
  const { t } = useTranslation();
  const label = t('web.compare.back', { name: artifact.name });
  return (
    <Link
      to={reviewPath(artifact.id)}
      aria-label={label}
      title={label}
      className="flex h-8 min-w-0 shrink items-center gap-1.5 rounded-full px-2 text-fg-muted transition-colors duration-(--duration-fast) hover:bg-surface-muted hover:text-fg [&_svg]:size-4 [&_svg]:shrink-0"
    >
      <ArrowLeft aria-hidden="true" />
      {compact ? null : (
        <span className="min-w-0 truncate font-semibold text-fg text-md">{artifact.name}</span>
      )}
    </Link>
  );
}

export interface CompareBarProps {
  artifact: ArtifactSummary;
  phone: boolean;
  /** The versions read so far, newest first. */
  versions: VersionSummary[];
  pair: { from: number; to: number };
  view: CompareView;
  views: CompareView[];
  /** Whether scrolling is kept in step; null where the view has no such choice. */
  sync: boolean | null;
  onFrom(n: number): void;
  onTo(n: number): void;
  onSwap(): void;
  onView(view: CompareView): void;
  onSync(on: boolean): void;
}

/**
 * The compare screen's bar: back to the artifact, the two versions with a
 * swap between them, the view, and on the side-by-side view the scroll sync.
 * On a phone the view switch takes a row of its own.
 */
export function CompareBar(p: CompareBarProps) {
  const { t } = useTranslation();
  const options = p.versions.map((v) => ({
    value: String(v.number),
    label: t('web.compare.version', { number: v.number }),
    detail: v.is_current ? t('web.review.current') : undefined,
  }));
  return (
    <header className="flex min-h-(--topbar-height) shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-border border-b bg-canvas px-2 py-2 md:gap-x-3 md:px-3">
      <CompareHeading name={p.artifact.name} />
      <BackLink artifact={p.artifact} compact={p.phone} />
      <div className="flex shrink-0 items-center gap-1">
        <Select
          inline
          hideLabel={p.phone}
          label={t('web.compare.from')}
          value={String(p.pair.from)}
          onValueChange={(v) => p.onFrom(Number(v))}
          options={options}
        />
        <IconButton
          size="sm"
          label={t('web.compare.swap')}
          icon={<ArrowLeftRight />}
          onClick={p.onSwap}
          className="text-fg-muted hover:text-fg"
        />
        <Select
          inline
          hideLabel={p.phone}
          label={t('web.compare.to')}
          value={String(p.pair.to)}
          onValueChange={(v) => p.onTo(Number(v))}
          options={options}
        />
      </div>
      <div className="min-w-0 max-md:order-last max-md:basis-full max-md:overflow-x-auto">
        <Segmented
          label={t('web.compare.viewLabel')}
          value={p.view}
          onValueChange={p.onView}
          items={p.views.map((v) => ({ value: v, label: t(`web.compare.view.${v}`) }))}
        />
      </div>
      {p.sync === null ? null : (
        <div className="ml-auto shrink-0 max-md:[&_label]:block max-md:[&_label]:max-w-14 max-md:[&_label]:text-xs max-md:[&_label]:leading-tight">
          <Switch label={t('web.compare.sync')} checked={p.sync} onCheckedChange={p.onSync} />
        </div>
      )}
    </header>
  );
}
