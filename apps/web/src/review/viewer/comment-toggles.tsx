import { MessageSquare, MessageSquarePlus } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ariaKeyShortcuts, Button, cn, IconButton, Kbd, Tooltip } from '../../ui/index.ts';
import { keysOf } from './shortcuts.ts';

/*
 * The two comment controls of a viewer's bar, shared by the review screen and
 * the share viewer: comment mode, and the comments with their open count.
 */

/** Comment mode, with its key in the tooltip; pressed, and filled with the accent, while on. */
export function CommentModeToggle({ on, onToggle }: { on: boolean; onToggle(): void }) {
  const { t } = useTranslation();
  return (
    <IconButton
      label={t('web.review.commentMode')}
      icon={<MessageSquarePlus />}
      size="sm"
      tooltipSide="bottom"
      shortcut={keysOf('commentMode')}
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        'text-fg-muted hover:text-fg',
        on && 'bg-accent text-primary-fg hover:bg-accent/90 hover:text-primary-fg',
      )}
    />
  );
}

/** Comments, with the open count after it; pressed while they show. */
export function CommentsToggle({
  open,
  count,
  onToggle,
}: {
  open: boolean;
  count: number | null;
  onToggle(): void;
}) {
  const { t } = useTranslation();
  const countId = useId();
  const keys = keysOf('togglePanel');
  return (
    <Tooltip
      side="bottom"
      content={
        <>
          <span>{t('web.review.comments')}</span>
          <Kbd keys={keys} />
        </>
      }
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('web.review.comments')}
        aria-pressed={open}
        aria-describedby={count === null ? undefined : countId}
        aria-keyshortcuts={ariaKeyShortcuts(keys)}
        leadingIcon={<MessageSquare />}
        onClick={onToggle}
        className="gap-1.5 px-2.5 text-fg-muted hover:text-fg aria-pressed:bg-selected aria-pressed:text-fg"
      >
        {count === null ? null : (
          <span className="tabular-nums" aria-hidden="true">
            {count}
          </span>
        )}
        {count === null ? null : (
          <span id={countId} className="sr-only">
            {t('web.review.openCount', { count })}
          </span>
        )}
      </Button>
    </Tooltip>
  );
}
