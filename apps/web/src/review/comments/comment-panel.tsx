import { ChevronDown, ChevronUp, Info, MessageSquare, Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import {
  Button,
  cn,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingRegion,
  Segmented,
  Skeleton,
  Spinner,
} from '../../ui/index.ts';
import { ariaKeyShortcuts } from '../../ui/kbd.tsx';
import type { FrameBridge } from '../frame/use-frame-bridge.ts';
import type { StreamStatus } from '../live/event-stream.ts';
import { Composer } from './composer.tsx';
import { composerFloats } from './composer-position.ts';
import { ThreadCard } from './thread-card.tsx';
import type { ReviewComments } from './use-review-comments.ts';

/** The longest guest name the server accepts. */
const GUEST_NAME_MAX = 60;

/**
 * The review's comments: a filter with counts, the composer when the spot
 * picked has no point to float beside, and the threads of the version shown.
 * `dock` is the column at the right of the desktop layout, with its own title
 * and close button; `sheet` goes inside `CommentSheet`, which has them.
 * With `onStep`, the docked title row also steps to the previous and next
 * thread (the K and J keys).
 */
export function CommentPanel({
  c,
  bridge,
  shown,
  variant,
  liveStatus,
  onAddComment,
  onClose,
  onStep,
  guestName,
}: {
  c: ReviewComments;
  bridge: FrameBridge;
  shown: number;
  variant: 'dock' | 'sheet';
  liveStatus: StreamStatus;
  onAddComment(): void;
  onClose(): void;
  onStep?(step: 1 | -1): void;
  guestName?: { value: string; onChange(v: string): void };
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const dock = variant === 'dock';
  const reconnecting = liveStatus === 'reconnecting';

  /** Selects a thread and shows its pin, on its own page if the frame shows another. */
  const show = (id: string) => {
    c.select(id);
    bridge.focus(id);
  };

  const filterItems = [
    { value: 'open' as const, label: t('web.comments.filter.open'), count: c.counts.open },
    {
      value: 'resolved' as const,
      label: t('web.comments.filter.resolved'),
      count: c.counts.resolved,
    },
    { value: 'all' as const, label: t('web.comments.filter.all') },
  ];

  const Root = dock ? 'section' : 'div';
  return (
    <Root
      aria-labelledby={dock ? headingId : undefined}
      className={cn(
        'flex min-h-0 min-w-0 flex-col bg-canvas',
        dock ? 'h-full border-border border-l' : 'flex-1',
      )}
    >
      {/* The title row carries the actions; the filter gets a row of its own below. */}
      <div className="flex shrink-0 flex-col gap-2.5 border-border border-b px-4 pt-3 pb-3">
        {dock ? (
          <div className="flex items-center gap-2">
            <h2 id={headingId} className="mr-auto font-semibold text-fg text-md">
              {t('web.comments.title')}
            </h2>
            {onStep ? (
              <div className="flex items-center">
                <IconButton
                  label={t('web.comments.previous')}
                  icon={<ChevronUp />}
                  size="sm"
                  shortcut={['k']}
                  disabled={c.visible.length === 0}
                  onClick={() => onStep(-1)}
                  className="text-fg-muted hover:text-fg"
                />
                <IconButton
                  label={t('web.comments.next')}
                  icon={<ChevronDown />}
                  size="sm"
                  shortcut={['j']}
                  disabled={c.visible.length === 0}
                  onClick={() => onStep(1)}
                  className="text-fg-muted hover:text-fg"
                />
              </div>
            ) : null}
            {c.permissions.canComment ? (
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<Plus />}
                onClick={onAddComment}
                aria-keyshortcuts={ariaKeyShortcuts(['c'])}
              >
                {t('web.comments.add')}
              </Button>
            ) : null}
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
          {/* In the sheet its title row is the sheet's own, so Add comment sits by the filter. */}
          {!dock && c.permissions.canComment ? (
            <IconButton
              label={t('web.comments.add')}
              icon={<Plus />}
              variant="secondary"
              size="sm"
              tooltip={false}
              onClick={onAddComment}
              className="ml-auto"
            />
          ) : null}
        </div>
      </div>

      {bridge.annotator === 'missing' ? (
        <p className="flex shrink-0 items-start gap-2 border-border border-b px-4 py-2.5 text-fg-muted text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('web.comments.noAnnotator')}</span>
        </p>
      ) : null}

      {guestName ? <GuestName value={guestName.value} onChange={guestName.onChange} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {c.draft !== null && !composerFloats(c.draft, variant) ? (
          <div className="mb-2">
            <Composer
              c={c}
              number={c.shownAll.length + 1}
              floating={null}
              onPosted={(thread) => bridge.focus(thread.id)}
            />
          </div>
        ) : null}
        <ThreadList c={c} bridge={bridge} shown={shown} onShow={show} />
      </div>

      <p
        role="status"
        className={
          reconnecting
            ? 'flex shrink-0 items-center gap-2 border-border border-t px-4 py-2 text-fg-muted text-sm'
            : 'sr-only'
        }
      >
        {reconnecting ? (
          <>
            <Spinner size={14} />
            {t('web.comments.reconnecting')}
          </>
        ) : null}
      </p>
    </Root>
  );
}

/** The threads the filter lists, or what stands in for them: loading, failure, nothing yet. */
function ThreadList({
  c,
  bridge,
  shown,
  onShow,
}: {
  c: ReviewComments;
  bridge: FrameBridge;
  shown: number;
  onShow(id: string): void;
}) {
  const { t } = useTranslation();
  const { query } = c;

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
                <Skeleton className="h-3.5 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </LoadingRegion>
    );
  }

  if (c.shownAll.length === 0) {
    // While the first comment is being written, the composer says it all.
    if (c.draft !== null) return null;
    return (
      <EmptyState
        icon={<MessageSquare />}
        title={t('web.comments.empty.title')}
        description={t('web.comments.empty.body')}
      />
    );
  }

  if (c.visible.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-fg-muted text-sm">
        {t(c.filter === 'resolved' ? 'web.comments.noneResolved' : 'web.comments.noneOpen')}
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {c.visible.map((thread) => (
        <li key={thread.id}>
          <ThreadCard
            thread={thread}
            number={c.numbers.get(thread.id) ?? 0}
            placement={bridge.placement(thread)}
            shown={shown}
            topPage={bridge.topPage}
            selected={c.selectedId === thread.id}
            c={c}
            onSelect={() => onShow(thread.id)}
            onOpenPage={() => onShow(thread.id)}
          />
        </li>
      ))}
    </ol>
  );
}

/**
 * The name a share-link guest signs with. What is typed stays in the field and
 * is handed on when the guest leaves it, so the name is not trimmed under the
 * cursor.
 */
function GuestName({ value, onChange }: { value: string; onChange(v: string): void }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState({ from: value, text: value });
  // A name set from elsewhere (trimmed, or another tab) replaces what the field shows.
  let text = typed.text;
  if (typed.from !== value) {
    text = value;
    setTyped({ from: value, text: value });
  }
  return (
    <div className="shrink-0 border-border border-b px-4 py-3">
      <Field label={t('web.comments.guestName')} description={t('web.comments.guestNameHint')}>
        {(control) => (
          <Input
            {...control}
            value={text}
            maxLength={GUEST_NAME_MAX}
            autoComplete="name"
            onChange={(event) => setTyped({ from: value, text: event.target.value })}
            onBlur={() => {
              if (text !== value) onChange(text);
            }}
          />
        )}
      </Field>
    </div>
  );
}
