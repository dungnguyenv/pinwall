import type { KeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import type { CommentThread } from '../../api/dto.ts';
import { Button, cn, Kbd, Textarea } from '../../ui/index.ts';
import { ariaKeyShortcuts } from '../../ui/kbd.tsx';
import { PinBadge } from '../frame/pin.tsx';
import { COMPOSER_SIZE } from './composer-position.ts';
import { isSendKey, QuoteText, SendError } from './parts.tsx';
import type { ReviewComments } from './use-review-comments.ts';

const SEND_KEYS = ['mod', 'enter'];

/**
 * Writes the comment for the spot just picked: its pin number to come, the
 * words it points at, and the text. Comment (or ⌘↵/Ctrl+↵) sends it on the
 * version the spot was picked on and selects the new thread; Cancel drops it;
 * Escape drops it only while it is empty. A failure shows the server's words
 * and keeps the text. `floating` places it beside the pin, over the page;
 * without it, it sits in the panel's flow.
 */
export function Composer({
  c,
  number,
  floating,
  onPosted,
}: {
  c: ReviewComments;
  number: number;
  floating: { left: number; top: number } | null;
  onPosted(t: CommentThread): void;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLTextAreaElement>(null);
  const { draft, actions } = c;
  const create = actions.create;
  const text = c.text('new');
  const empty = text.trim() === '';

  // The draft shown now: a post that comes back after a new pick must not drop the new draft.
  const current = useRef(draft);
  useLayoutEffect(() => {
    current.current = draft;
  });

  // Each pick, including one that moves an open composer, puts the cursor in the box.
  const anchor = draft?.anchor;
  const floats = floating !== null;
  useEffect(() => {
    if (anchor === undefined) return;
    box.current?.focus({ preventScroll: floats });
  }, [anchor, floats]);

  if (draft === null) return null;

  async function send() {
    const sent = draft;
    if (sent === null || empty || create.isPending) return;
    try {
      const thread = await create.mutateAsync({
        body: text.trim(),
        anchor: sent.anchor,
        versionId: sent.versionId,
      });
      c.select(thread.id);
      if (current.current === sent) c.cancelDraft();
      onPosted(thread);
    } catch {
      // The mutation holds the error, shown below the text, which stays.
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape') {
      // Handled here either way: the page must not leave comment mode under a draft.
      event.stopPropagation();
      if (empty) c.cancelDraft();
    } else if (isSendKey(event)) {
      event.preventDefault();
      void send();
    }
  }

  const quote = draft.anchor.kind === 'text' ? draft.anchor.quote?.exact : undefined;

  return (
    <form
      aria-label={t('web.comments.composerTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onKeyDown={onKeyDown}
      style={
        floating
          ? {
              position: 'fixed',
              left: floating.left,
              top: floating.top,
              width: COMPOSER_SIZE.width,
            }
          : undefined
      }
      className={cn(
        'grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5 border bg-surface p-3',
        floating
          ? 'z-40 animate-pop-in rounded-xl border-border shadow-popover'
          : 'rounded-lg border-accent',
      )}
    >
      <span className="pt-1.5">
        <PinBadge number={number} resolved={false} selected />
      </span>
      <div className="col-start-2 min-w-0">
        {quote ? <QuoteText text={quote} className="mb-2.5" /> : null}
        <Textarea
          ref={box}
          autosize
          rows={2}
          aria-label={t('web.comments.composerLabel')}
          placeholder={t('web.comments.composerPlaceholder')}
          value={text}
          readOnly={create.isPending}
          onChange={(event) => c.setText('new', event.target.value)}
          className="max-h-48 min-h-16 text-base"
        />
        {create.error ? <SendError message={errorMessage(create.error, t)} /> : null}
        <div className="mt-2.5 flex items-center gap-2">
          <span aria-hidden="true" className="mr-auto hidden sm:inline-flex">
            <Kbd keys={SEND_KEYS} />
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={c.cancelDraft}
            disabled={create.isPending}
            className="max-sm:ml-auto"
          >
            {t('web.common.cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            loading={create.isPending}
            disabled={empty}
            aria-keyshortcuts={ariaKeyShortcuts(SEND_KEYS)}
          >
            {t('web.comments.post')}
          </Button>
        </div>
      </div>
    </form>
  );
}
