import type { UseQueryResult } from '@tanstack/react-query';
import { CircleCheck, MessageSquare, X } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type ApiError, errorMessage } from '../../api/client.ts';
import type { ArtifactSummary, CommentThread } from '../../api/dto.ts';
import { reviewPath } from '../../api/versions.ts';
import { formatDate, formatRelativeTime } from '../../lib/format.ts';
import { usePref } from '../../lib/storage.ts';
import {
  Badge,
  cn,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingRegion,
  Segmented,
  Skeleton,
} from '../../ui/index.ts';
import { memberBackend } from '../comments/backend.ts';
import { QuoteText } from '../comments/parts.tsx';
import {
  commentFilterPref,
  countThreads,
  filterThreads,
  THREAD_FILTERS,
  type ThreadFilter,
} from '../comments/threads.ts';
import { useThreads } from '../comments/use-threads.ts';
import { PinBadge } from '../frame/pin.tsx';
import { compareThreads, resolvedBetween, type VersionThreads } from './compare-threads.ts';

const NO_THREADS: CommentThread[] = [];
const NOTHING: ReadonlySet<string> = new Set();

/** The comments of a comparison, as its panel and the bar's count need them. */
export interface CompareComments {
  query: UseQueryResult<CommentThread[], ApiError>;
  filter: ThreadFilter;
  setFilter(f: ThreadFilter): void;
  /** The two versions' threads; null while there is no pair to compare. */
  groups: { older: VersionThreads; newer: VersionThreads } | null;
  /** Of both versions' threads together. */
  counts: { open: number; resolved: number };
}

/**
 * The threads of the versions compared, read like the review page reads them
 * (the two share the cache), with the review page's filter: one choice, kept
 * for the member under the same key. Nothing is read without a pair.
 */
export function useCompareComments(
  artifactId: string,
  pair: { from: number; to: number } | null,
  userId: string | null,
): CompareComments {
  const backend = useMemo(() => memberBackend(artifactId), [artifactId]);
  const query = useThreads(backend, pair !== null);
  const [filter, setFilter] = usePref<ThreadFilter>(
    userId === null ? null : commentFilterPref(userId),
    THREAD_FILTERS,
    'open',
  );
  const list = query.data ?? NO_THREADS;
  const from = pair?.from ?? null;
  const to = pair?.to ?? null;
  const groups = useMemo(
    () => (from === null || to === null ? null : compareThreads(list, { from, to })),
    [list, from, to],
  );
  const counts = useMemo(
    () =>
      groups === null
        ? { open: 0, resolved: 0 }
        : countThreads([...groups.older.threads, ...groups.newer.threads]),
    [groups],
  );
  return { query, filter, setFilter, groups, counts };
}

/**
 * The compared versions' comments: the filter with its counts, then the older
 * version's threads and those the newer one adds, each under its version.
 * A thread is a link to its version's review page, which selects it and
 * shows its pin. Nothing is written here. `dock` is the column at the right
 * of the desktop layout, with its own title and close button; `sheet` goes
 * inside `CommentSheet`, which has them.
 */
export function CompareCommentsPanel({
  c,
  artifact,
  variant,
  onClose,
}: {
  c: CompareComments;
  artifact: ArtifactSummary;
  variant: 'dock' | 'sheet';
  onClose(): void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const dock = variant === 'dock';
  const Root = dock ? 'section' : 'div';
  const filterItems = [
    { value: 'open' as const, label: t('web.comments.filter.open'), count: c.counts.open },
    {
      value: 'resolved' as const,
      label: t('web.comments.filter.resolved'),
      count: c.counts.resolved,
    },
    { value: 'all' as const, label: t('web.comments.filter.all') },
  ];

  return (
    <Root
      aria-labelledby={dock ? headingId : undefined}
      className={cn(
        'flex min-h-0 min-w-0 flex-col bg-canvas',
        dock ? 'h-full border-border border-l' : 'flex-1',
      )}
    >
      <div className="flex shrink-0 flex-col gap-2.5 border-border border-b px-4 pt-3 pb-3">
        {dock ? (
          <div className="flex items-center gap-2">
            <h2 id={headingId} className="mr-auto font-semibold text-fg text-md">
              {t('web.comments.title')}
            </h2>
            <IconButton
              label={t('web.comments.close')}
              icon={<X />}
              size="sm"
              tooltipSide="left"
              onClick={onClose}
              className="-mr-1.5 text-fg-muted hover:text-fg"
            />
          </div>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <Segmented
            label={t('web.comments.filterLabel')}
            value={c.filter}
            onValueChange={c.setFilter}
            items={filterItems}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <Threads c={c} artifact={artifact} />
      </div>
    </Root>
  );
}

/** Both versions' threads, or what stands in for them: loading, failure, none at all. */
function Threads({ c, artifact }: { c: CompareComments; artifact: ArtifactSummary }) {
  const { t } = useTranslation();
  const { query, groups } = c;

  // A failed refresh keeps the threads already read on screen.
  if (query.data === undefined) {
    if (query.isError) {
      return (
        <ErrorState
          compact
          title={t('web.comments.loadFailed')}
          message={errorMessage(query.error, t)}
          onRetry={() => void query.refetch()}
        />
      );
    }
    return (
      <LoadingRegion label={t('web.comments.loading')}>
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-2.5 rounded-lg border border-border p-3">
              <Skeleton className="size-6 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3.5 w-full" />
              </div>
            </div>
          ))}
        </div>
      </LoadingRegion>
    );
  }
  if (groups === null) return null;

  if (groups.older.threads.length === 0 && groups.newer.threads.length === 0) {
    return (
      <EmptyState
        icon={<MessageSquare />}
        title={t('web.compare.comments.empty.title')}
        description={t('web.compare.comments.empty.body')}
      />
    );
  }

  const range = { older: groups.older.version, newer: groups.newer.version };
  return (
    <div className="flex flex-col gap-5">
      <VersionGroup
        group={groups.older}
        note={t('web.compare.comments.olderNote', { number: range.older })}
        filter={c.filter}
        range={range}
        artifact={artifact}
      />
      <VersionGroup
        group={groups.newer}
        note={t('web.compare.comments.newerNote', { number: range.older })}
        filter={c.filter}
        range={range}
        artifact={artifact}
      />
    </div>
  );
}

const NONE: Record<ThreadFilter, string> = {
  open: 'web.comments.noneOpen',
  resolved: 'web.comments.noneResolved',
  all: 'web.compare.comments.none',
};

/** One version's threads under its number, with which ones those are. */
function VersionGroup({
  group,
  note,
  filter,
  range,
  artifact,
}: {
  group: VersionThreads;
  note: string;
  filter: ThreadFilter;
  range: { older: number; newer: number };
  artifact: ArtifactSummary;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const visible = filterThreads(group.threads, filter, NOTHING);
  // The current version's page is the artifact's own address, as everywhere else.
  const page = reviewPath(
    artifact.id,
    group.version === artifact.current_version?.number ? null : group.version,
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="px-1">
        <h3 id={headingId} className="font-semibold text-fg text-sm">
          {t('web.compare.version', { number: group.version })}
        </h3>
        <p className="text-fg-muted text-xs">{note}</p>
      </div>
      {visible.length === 0 ? (
        <p className="px-1 py-2 text-fg-muted text-sm">{t(NONE[filter])}</p>
      ) : (
        <ol aria-labelledby={headingId} className="flex flex-col gap-2">
          {visible.map((thread) => (
            <li key={thread.id}>
              <ThreadRow
                thread={thread}
                number={group.numbers.get(thread.id) ?? 0}
                version={group.version}
                href={`${page}?${new URLSearchParams({ comment: thread.id })}`}
                marked={resolvedBetween(thread, range)}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * One thread, read only: its pin as numbered on `version`'s page, who wrote it
 * on which version and when, the words it points at, its text, and where it
 * stands. `marked` when the change compared resolved it. The whole row is the
 * link; its name says which comment, its description what it says.
 */
function ThreadRow({
  thread,
  number,
  version,
  href,
  marked,
}: {
  thread: CommentThread;
  number: number;
  version: number;
  href: string;
  marked: boolean;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const statusId = useId();
  const name = thread.author.name ?? t('web.comments.formerMember');
  const resolved = thread.status === 'resolved';
  const replies = thread.replies.length;
  const written = thread.version.number;
  const resolvedText = thread.resolved_in_version
    ? t('web.comments.resolvedIn', { number: thread.resolved_in_version.number })
    : t('web.comments.resolved');
  const hasStatus = resolved || replies > 0;

  return (
    <Link
      to={href}
      aria-label={t('web.compare.comments.label', { number, version, name })}
      aria-describedby={hasStatus ? `${bodyId} ${statusId}` : bodyId}
      className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5 rounded-lg border border-border bg-surface p-3 transition-colors duration-(--duration-fast) hover:border-border-strong hover:bg-surface-muted/40"
    >
      <div className="row-span-2 self-start">
        <PinBadge number={number} resolved={resolved} />
      </div>
      <div className="col-start-2 flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium text-fg text-sm">{name}</span>
        {thread.author.type === 'guest' ? <Badge>{t('web.comments.guest')}</Badge> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-fg-muted text-xs">
          <span title={t('web.comments.versionTitle', { number: written })}>
            <Badge>{t('web.comments.version', { number: written })}</Badge>
          </span>
          <time
            dateTime={new Date(thread.created_at).toISOString()}
            title={formatDate(thread.created_at)}
          >
            {formatRelativeTime(thread.created_at)}
          </time>
        </span>
      </div>
      <div className="col-start-2 mt-1.5 flex min-w-0 flex-col gap-1.5">
        {thread.anchor.kind === 'text' && thread.anchor.quote ? (
          <QuoteText text={thread.anchor.quote.exact} />
        ) : null}
        <p
          id={bodyId}
          className="line-clamp-3 whitespace-pre-wrap text-fg text-sm [overflow-wrap:anywhere]"
        >
          {thread.body}
        </p>
      </div>
      {hasStatus ? (
        <div
          id={statusId}
          className="col-start-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-muted text-xs"
        >
          {resolved && marked ? (
            <mark className="inline-flex h-5 items-center gap-1 rounded-sm bg-success-soft px-1.5 font-medium text-success [&_svg]:size-3">
              <CircleCheck aria-hidden="true" />
              {resolvedText}
            </mark>
          ) : resolved ? (
            <span className="inline-flex items-center gap-1 [&_svg]:size-3">
              <CircleCheck aria-hidden="true" />
              {resolvedText}
            </span>
          ) : null}
          {replies > 0 ? (
            <span>{t('web.compare.comments.replies', { count: replies })}</span>
          ) : null}
        </div>
      ) : null}
    </Link>
  );
}
