import { Link as LinkIcon, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ArtifactSummary } from '../api/dto.ts';
import { formatRelativeTime } from '../lib/format.ts';
import { Badge, cn } from '../ui/index.ts';

/** "v3 · 2 hours ago", with the project in front when one is given. */
export function useArtifactMeta(artifact: ArtifactSummary, projectName?: string): string {
  const { t } = useTranslation();
  const time = formatRelativeTime(artifact.updated_at);
  const version = artifact.current_version;
  const meta = version
    ? t('web.artifact.meta', {
        version: t('web.artifact.versionShort', { number: version.number }),
        time,
      })
    : time;
  return projectName ? t('web.artifact.inProject', { project: projectName, meta }) : meta;
}

/**
 * Open comment threads and sharing, each shown only when it is above zero. Members-only, the default, gets nothing.
 */
export function ArtifactSignals({
  artifact,
  className,
}: {
  artifact: ArtifactSummary;
  className?: string;
}) {
  const { t } = useTranslation();
  const threads = artifact.open_thread_count;
  const shared = artifact.share_link_count > 0;
  if (threads === 0 && !shared) return null;
  const comments = t('web.artifact.comments', { count: threads });
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-2', className)}>
      {threads > 0 ? (
        <span title={comments} className="inline-flex items-center gap-1 text-fg-muted text-sm">
          <MessageSquare aria-hidden="true" className="size-3.5 shrink-0" />
          <span aria-hidden="true" className="tabular-nums">
            {threads}
          </span>
          <span className="sr-only">{comments}</span>
        </span>
      ) : null}
      {/* Spaces between the parts, so a screen reader does not run them together. */}{' '}
      {shared ? (
        <Badge tone="accent" icon={<LinkIcon />}>
          {t('web.artifact.shared')}
        </Badge>
      ) : null}
    </span>
  );
}
