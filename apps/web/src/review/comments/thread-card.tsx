import type { TFunction } from 'i18next';
import {
  Check,
  CircleCheck,
  Link as LinkIcon,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  SquareArrowOutUpRight,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import type { Comment, CommentThread } from '../../api/dto.ts';
import { formatDate, formatRelativeTime } from '../../lib/format.ts';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  cn,
  copyText,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Textarea,
  toast,
} from '../../ui/index.ts';
import { ariaKeyShortcuts } from '../../ui/kbd.tsx';
import { PinBadge } from '../frame/pin.tsx';
import type { PinPlacement } from '../frame/use-frame-bridge.ts';
import { isSendKey, QuoteText, SendError } from './parts.tsx';
import { ReplyBox } from './reply-box.tsx';
import type { ReviewComments } from './use-review-comments.ts';

/** The name a comment is signed with; a member whose account is gone has none. */
function authorName(author: Comment['author'], t: TFunction): string {
  return author.name ?? t('web.comments.formerMember');
}

/** Whether a click on the card means "show me this thread": not on a control, a portal or a selection. */
function selectsCard(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as Element;
  // Menus and dialogs are portalled elsewhere in the document; React still bubbles their clicks here.
  if (!event.currentTarget.contains(target)) return false;
  if (target.closest('button, a, input, textarea, select, label, [role="menuitem"]')) return false;
  // Selecting text to copy is not a click on the card.
  return window.getSelection()?.isCollapsed !== false;
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One comment thread in the panel: its pin, who wrote it on which version and
 * when, the words it points at, where it stands on the version shown, its
 * text and replies, and what the reader may do with it. Clicking the card
 * (or, from the keyboard, its pin) selects it and shows its pin on the page.
 */
export function ThreadCard({
  thread,
  number,
  placement,
  shown,
  topPage,
  selected,
  c,
  onSelect,
  onOpenPage,
}: {
  thread: CommentThread;
  number: number;
  placement: PinPlacement;
  shown: number;
  topPage: string;
  selected: boolean;
  c: ReviewComments;
  onSelect(): void;
  onOpenPage(page: string): void;
}) {
  const { t } = useTranslation();
  const card = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ comment: Comment; open: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const name = authorName(thread.author, t);
  const resolved = thread.status === 'resolved';
  const { permissions } = c;
  const page = thread.anchor.page;
  // Until the frame reports, a pin on a page the frame does not show is elsewhere too.
  const elsewhere = placement === 'elsewhere' || (placement === 'pending' && page !== topPage);

  useEffect(() => {
    if (!selected) return;
    card.current?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [selected]);

  function startEdit(comment: Comment) {
    c.setText(`edit:${comment.id}`, comment.body);
    setEditing(comment.id);
  }

  async function changeStatus() {
    if (busy) return;
    setBusy(true);
    try {
      if (resolved) await c.actions.reopen.mutateAsync(thread.id);
      else if (c.versionId !== null) {
        await c.actions.resolve.mutateAsync({ threadId: thread.id, versionId: c.versionId });
      }
    } catch (caught) {
      toast.error(errorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    const url = new URL(`/a/${encodeURIComponent(thread.artifact_id)}`, window.location.origin);
    url.searchParams.set('comment', thread.id);
    if (await copyText(url.href)) toast.success(t('web.comments.linkCopied'));
    else toast.error(t('web.comments.copyFailed'));
  }

  const statusChange =
    permissions.canResolve && (resolved || c.versionId !== null) ? (
      <IconButton
        label={t(resolved ? 'web.comments.reopen' : 'web.comments.resolve')}
        icon={resolved ? <RotateCcw /> : <Check />}
        size="sm"
        loading={busy}
        onClick={() => void changeStatus()}
        className="-my-1 size-7 text-fg-muted hover:text-fg"
      />
    ) : null;

  return (
    // The pin is the card's keyboard control; a click anywhere else on the card is a shortcut to it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the pin button gives keyboard users the same action
    <article
      ref={card}
      data-thread-id={thread.id}
      aria-label={t('web.comments.cardLabel', { number, name })}
      aria-current={selected ? 'true' : undefined}
      onClick={(event) => {
        if (selectsCard(event)) onSelect();
      }}
      className={cn(
        'grid scroll-my-3 grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5 rounded-lg border bg-surface p-3 transition-colors duration-(--duration-fast)',
        selected ? 'border-accent' : 'border-border hover:border-border-strong',
      )}
    >
      <button
        type="button"
        aria-label={t('web.comments.showPin', { number })}
        onClick={onSelect}
        className="row-span-2 cursor-pointer self-start rounded-full"
      >
        <PinBadge number={number} resolved={resolved} selected={selected} />
      </button>

      <div className="col-start-2 flex min-w-0 items-center gap-2">
        <Avatar name={name} size="sm" />
        <span className="min-w-0 truncate font-medium text-fg text-sm">{name}</span>
        {thread.author.type === 'guest' ? <Badge>{t('web.comments.guest')}</Badge> : null}
        <span className="ml-auto flex shrink-0 items-center">
          {statusChange}
          <CommentMenu
            c={c}
            comment={thread}
            label={t('web.comments.actions', { number })}
            onEdit={startEdit}
            onCopyLink={c.scope.kind === 'artifact' ? () => void copyLink() : undefined}
            onDelete={(comment) => setDeleting({ comment, open: true })}
          />
        </span>
      </div>
      {/* Under the name, past the avatar. */}
      <Meta version={thread.version.number} at={thread.created_at} className="col-start-2 pl-8" />

      {thread.anchor.kind === 'text' && thread.anchor.quote ? (
        <QuoteText text={thread.anchor.quote.exact} className="col-start-2 mt-2.5" />
      ) : null}

      {resolved || elsewhere || placement === 'detached' ? (
        <div className="col-start-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {resolved ? (
            <p className="inline-flex items-center gap-1.5 text-fg-muted text-sm">
              <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success" />
              {thread.resolved_in_version
                ? t('web.comments.resolvedIn', { number: thread.resolved_in_version.number })
                : t('web.comments.resolved')}
            </p>
          ) : null}
          {/* Once resolved, words gone from the page are usually the fix, not a problem. */}
          {!resolved && placement === 'detached' ? (
            <Badge tone="warning" icon={<TriangleAlert />}>
              {t('web.comments.detached', { number: shown })}
            </Badge>
          ) : null}
          {elsewhere ? (
            <button
              type="button"
              onClick={() => onOpenPage(page)}
              className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-sm text-accent-text text-sm hover:underline"
            >
              <SquareArrowOutUpRight aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">
                {page === '' ? t('web.comments.onStartPage') : t('web.comments.onPage', { page })}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="col-start-2 mt-2">
        {editing === thread.id ? (
          <EditBox
            c={c}
            comment={thread}
            label={t('web.comments.editLabel')}
            onDone={() => setEditing(null)}
          />
        ) : (
          <CommentBody comment={thread} />
        )}
      </div>

      {thread.replies.length > 0 ? (
        <ol className="col-start-2 mt-3 flex flex-col gap-3 border-border border-t pt-3">
          {thread.replies.map((reply) => (
            <li key={reply.id}>
              <Reply
                c={c}
                reply={reply}
                editing={editing === reply.id}
                onEdit={startEdit}
                onDoneEditing={() => setEditing(null)}
                onDelete={(comment) => setDeleting({ comment, open: true })}
              />
            </li>
          ))}
        </ol>
      ) : null}

      {permissions.canComment ? (
        <div className="col-start-2">
          <ReplyBox c={c} threadId={thread.id} expanded={selected} onOpen={onSelect} />
        </div>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          open={deleting.open}
          onOpenChange={(open) => setDeleting((now) => (now ? { ...now, open } : now))}
          tone="danger"
          title={t(
            deleting.comment.id === thread.id
              ? 'web.comments.deleteThread.title'
              : 'web.comments.deleteReply.title',
          )}
          body={t(
            deleting.comment.id === thread.id
              ? 'web.comments.deleteThread.body'
              : 'web.comments.deleteReply.body',
          )}
          confirmLabel={t('web.comments.delete')}
          errorMessage={(caught) => errorMessage(caught, t)}
          onConfirm={() =>
            c.actions.remove.mutateAsync({ threadId: thread.id, commentId: deleting.comment.id })
          }
        />
      ) : null}
    </article>
  );
}

/** The version a comment was written on and how long ago. */
function Meta({ version, at, className }: { version: number; at: number; className?: string }) {
  const { t } = useTranslation();
  return (
    <p className={cn('flex items-center gap-2 text-fg-muted text-xs', className)}>
      <span title={t('web.comments.versionTitle', { number: version })}>
        <Badge>{t('web.comments.version', { number: version })}</Badge>
      </span>
      <time dateTime={new Date(at).toISOString()} title={formatDate(at)}>
        {formatRelativeTime(at)}
      </time>
    </p>
  );
}

/** A comment's text as written, line breaks kept, marked when its author changed it. */
function CommentBody({ comment }: { comment: Comment }) {
  const { t } = useTranslation();
  return (
    <p className="whitespace-pre-wrap text-base text-fg [overflow-wrap:anywhere]">
      {comment.body}
      {comment.edited_at === null ? null : (
        <>
          {' '}
          <span title={formatDate(comment.edited_at)} className="text-fg-muted text-xs">
            {t('web.comments.edited')}
          </span>
        </>
      )}
    </p>
  );
}

/** A reply inside a thread card. */
function Reply({
  c,
  reply,
  editing,
  onEdit,
  onDoneEditing,
  onDelete,
}: {
  c: ReviewComments;
  reply: Comment;
  editing: boolean;
  onEdit(comment: Comment): void;
  onDoneEditing(): void;
  onDelete(comment: Comment): void;
}) {
  const { t } = useTranslation();
  const name = authorName(reply.author, t);
  return (
    <div className="flex items-start gap-2">
      <Avatar name={name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium text-fg text-sm">{name}</span>
          {reply.author.type === 'guest' ? <Badge>{t('web.comments.guest')}</Badge> : null}
          <time
            dateTime={new Date(reply.created_at).toISOString()}
            title={formatDate(reply.created_at)}
            className="shrink-0 text-fg-muted text-xs"
          >
            {formatRelativeTime(reply.created_at)}
          </time>
          <span className="ml-auto flex shrink-0">
            <CommentMenu
              c={c}
              comment={reply}
              label={t('web.comments.replyActions', { name })}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          </span>
        </div>
        <div className="mt-0.5">
          {editing ? (
            <EditBox
              c={c}
              comment={reply}
              label={t('web.comments.editReplyLabel')}
              onDone={onDoneEditing}
            />
          ) : (
            <CommentBody comment={reply} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Edit, Copy link and Delete for one comment, each only when allowed; nothing when none is. */
function CommentMenu({
  c,
  comment,
  label,
  onEdit,
  onCopyLink,
  onDelete,
}: {
  c: ReviewComments;
  comment: Comment;
  label: string;
  onEdit(comment: Comment): void;
  onCopyLink?: () => void;
  onDelete(comment: Comment): void;
}) {
  const { t } = useTranslation();
  // Choosing Edit hands focus to the edit box rather than back to this menu's button.
  const keepFocus = useRef(false);
  const canEdit = c.permissions.canEdit(comment);
  const canDelete = c.permissions.canDelete(comment);
  if (!canEdit && !canDelete && !onCopyLink) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          label={label}
          icon={<MoreHorizontal />}
          size="sm"
          tooltip={false}
          className="-my-1 size-7 text-fg-muted hover:text-fg"
        />
      </MenuTrigger>
      <MenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (!keepFocus.current) return;
          keepFocus.current = false;
          event.preventDefault();
        }}
      >
        {canEdit ? (
          <MenuItem
            icon={<Pencil />}
            onSelect={() => {
              keepFocus.current = true;
              onEdit(comment);
            }}
          >
            {t('web.comments.edit')}
          </MenuItem>
        ) : null}
        {onCopyLink ? (
          <MenuItem icon={<LinkIcon />} onSelect={onCopyLink}>
            {t('web.comments.copyLink')}
          </MenuItem>
        ) : null}
        {canDelete ? (
          <>
            {canEdit || onCopyLink ? <MenuSeparator /> : null}
            <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => onDelete(comment)}>
              {t('web.comments.delete')}
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/**
 * A comment's text being changed. The text lives in the review's comments
 * while the box is open, so a version switch waits for it; leaving the box
 * drops it.
 */
function EditBox({
  c,
  comment,
  label,
  onDone,
}: {
  c: ReviewComments;
  comment: Comment;
  label: string;
  onDone(): void;
}) {
  const { t } = useTranslation();
  const key = `edit:${comment.id}` as const;
  const text = c.text(key);
  const { setText } = c;
  const box = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = text.trim() === '';

  // The text as last rendered, to put back if the box is unmounted and mounted again at once
  // (React's StrictMode does that in development).
  const latest = useRef(text);
  useLayoutEffect(() => {
    latest.current = text;
  });
  useEffect(() => {
    setText(key, latest.current);
    return () => setText(key, '');
  }, [key, setText]);

  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  async function save() {
    if (empty || busy) return;
    const body = text.trim();
    if (body === comment.body) {
      onDone();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await c.actions.edit.mutateAsync({ commentId: comment.id, body });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught, t));
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isSendKey(event)) {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      // Escape leaves an unchanged edit; it never throws away a change.
      event.stopPropagation();
      if (text === comment.body) onDone();
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Textarea
        ref={box}
        autosize
        rows={2}
        aria-label={label}
        value={text}
        readOnly={busy}
        onChange={(event) => setText(key, event.target.value)}
        onKeyDown={onKeyDown}
        className="min-h-16 text-base"
      />
      {error ? <SendError message={error} /> : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          {t('web.common.cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          loading={busy}
          disabled={empty}
          aria-keyshortcuts={ariaKeyShortcuts(['mod', 'enter'])}
        >
          {t('web.common.save')}
        </Button>
      </div>
    </form>
  );
}
