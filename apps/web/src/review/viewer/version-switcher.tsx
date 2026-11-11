import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { type ApiError, errorMessage } from '../../api/client.ts';
import type { VersionList, VersionSummary } from '../../api/dto.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import {
  Badge,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
} from '../../ui/index.ts';
import { keysOf } from './shortcuts.ts';

/** Who made a version, in words: the version records the publisher's id and how it came in. */
function byLine(v: VersionSummary, meId: string): string {
  return `web.review.versionBy.${v.created_by === meId ? 'mine' : 'other'}.${v.source}`;
}

/**
 * The version chip of the top bar and its menu: a step to the older and the
 * newer version ([ and ]), then every version, the newest first, with the one
 * shown checked and the current one marked, and Load more at the end.
 */
export function VersionSwitcher({
  shown,
  versions,
  list,
  meId,
  older,
  newer,
  onChoose,
}: {
  shown: number;
  versions: UseInfiniteQueryResult<InfiniteData<VersionList>, ApiError>;
  /** Every version read so far, the newest first. */
  list: VersionSummary[];
  meId: string;
  older: number | null;
  newer: number | null;
  onChoose(n: number): void;
}) {
  const { t } = useTranslation();
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('web.review.versionTrigger', { number: shown })}
          className="gap-1 px-2.5 font-semibold tabular-nums [&_svg]:text-fg-muted"
        >
          {t('web.artifact.versionShort', { number: shown })}
          <ChevronDown />
        </Button>
      </MenuTrigger>
      <MenuContent className="w-80">
        <MenuItem
          icon={<ChevronLeft />}
          shortcut={keysOf('prevVersion')}
          disabled={older === null}
          onSelect={() => older !== null && onChoose(older)}
        >
          {t('web.review.olderVersionAction')}
        </MenuItem>
        <MenuItem
          icon={<ChevronRight />}
          shortcut={keysOf('nextVersion')}
          disabled={newer === null}
          onSelect={() => newer !== null && onChoose(newer)}
        >
          {t('web.review.newerVersionAction')}
        </MenuItem>
        <MenuSeparator />
        <VersionItems
          shown={shown}
          versions={versions}
          list={list}
          meId={meId}
          onChoose={onChoose}
        />
      </MenuContent>
    </Menu>
  );
}

function VersionItems({
  shown,
  versions,
  list,
  meId,
  onChoose,
}: {
  shown: number;
  versions: UseInfiniteQueryResult<InfiniteData<VersionList>, ApiError>;
  list: VersionSummary[];
  meId: string;
  onChoose(n: number): void;
}) {
  const { t } = useTranslation();

  if (versions.data === undefined) {
    if (versions.isError) {
      return (
        <>
          <p role="alert" className="px-2.5 py-2 text-fg-muted text-sm">
            {errorMessage(versions.error, t)}
          </p>
          <MenuItem
            icon={<RotateCw />}
            onSelect={(event) => {
              event.preventDefault();
              void versions.refetch();
            }}
          >
            {t('web.common.retry')}
          </MenuItem>
        </>
      );
    }
    return (
      <div role="status" aria-label={t('web.review.versionsLoading')} className="p-2.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-3.5 w-44" />
      </div>
    );
  }

  return (
    <>
      <DropdownMenu.RadioGroup value={String(shown)}>
        {list.map((v) => (
          <DropdownMenu.RadioItem
            key={v.id}
            value={String(v.number)}
            onSelect={() => onChoose(v.number)}
            className="grid cursor-pointer select-none grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-md px-2.5 py-2 outline-offset-[-2px] data-highlighted:bg-surface-muted"
          >
            <span className="flex h-5 items-center text-accent-text">
              <DropdownMenu.ItemIndicator>
                <Check aria-hidden="true" className="size-4" />
              </DropdownMenu.ItemIndicator>
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className="font-semibold text-base text-fg tabular-nums">
                  {t('web.artifact.versionShort', { number: v.number })}
                </span>
                {v.is_current ? <Badge tone="accent">{t('web.review.current')}</Badge> : null}
              </span>
              <span className="truncate text-fg-muted text-sm">
                {t('web.review.versionMeta', {
                  time: formatRelativeTime(v.created_at),
                  by: t(byLine(v, meId)),
                })}
              </span>
              {v.message ? (
                <span className="line-clamp-2 text-fg text-sm [overflow-wrap:anywhere]">
                  {v.message}
                </span>
              ) : null}
            </span>
          </DropdownMenu.RadioItem>
        ))}
      </DropdownMenu.RadioGroup>
      {versions.hasNextPage ? (
        <>
          <MenuSeparator />
          <MenuItem
            disabled={versions.isFetchingNextPage}
            onSelect={(event) => {
              // The menu stays open, so the older versions appear in it.
              event.preventDefault();
              void versions.fetchNextPage();
            }}
            className="justify-center text-fg-muted"
          >
            {t('web.library.loadMore')}
          </MenuItem>
        </>
      ) : null}
    </>
  );
}
