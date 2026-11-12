import { MessageSquare, MessageSquarePlus } from 'lucide-react';
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

/**
 * Comments, with the open count after it; pressed while they show. The count is part of the
 * name, so the name holds every word the button shows (WCAG 2.5.3).
 */
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
        aria-label={
          count === null ? t('web.review.comments') : t('web.review.commentsCount', { count })
        }
        aria-pressed={open}
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
      </Button>
    </Tooltip>
  );
}
