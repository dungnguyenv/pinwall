import { Reply } from 'lucide-react';
import { type FocusEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import { Button } from '../../ui/button.tsx';
import { ariaKeyShortcuts } from '../../ui/kbd.tsx';
import { Textarea } from '../../ui/textarea.tsx';
import { isSendKey, SendError } from './parts.tsx';
import type { ReviewComments } from './use-review-comments.ts';

/**
 * Where a reply to a thread is written. A thread that is not selected shows
 * only a quiet Reply button, so a long list stays calm; the selected thread,
 * or one holding unsent text, shows the box, which grows as it is typed in.
 * The text lives in the review's comments, so it survives the card leaving
 * the list and coming back.
 */
export function ReplyBox({
  c,
  threadId,
  expanded,
  onOpen,
}: {
  c: ReviewComments;
  threadId: string;
  /** Show the box even while empty: its thread is selected. */
  expanded: boolean;
  /** The Reply button was used: select the thread. */
  onOpen(): void;
}) {
  const { t } = useTranslation();
  const key = `reply:${threadId}` as const;
  const text = c.text(key);
  const box = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [focusBox, setFocusBox] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = text.trim() === '';
  const open = expanded || focused || focusBox || text !== '';

  useEffect(() => {
    if (!focusBox || !open) return;
    setFocusBox(false);
    box.current?.focus();
  }, [focusBox, open]);

  async function send() {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await c.actions.reply.mutateAsync({ threadId, body: text.trim() });
      c.setText(key, '');
    } catch (caught) {
      setError(errorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<Reply />}
        onClick={() => {
          setFocusBox(true);
          onOpen();
        }}
        className="mt-2 -ml-3 text-fg-muted hover:text-fg"
      >
        {t('web.comments.reply')}
      </Button>
    );
  }

  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onFocus={() => setFocused(true)}
      onBlur={(event: FocusEvent<HTMLFormElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <Textarea
        ref={box}
        autosize
        rows={1}
        aria-label={t('web.comments.replyLabel')}
        placeholder={t('web.comments.replyPlaceholder')}
        value={text}
        readOnly={busy}
        onChange={(event) => c.setText(key, event.target.value)}
        onKeyDown={(event) => {
          if (!isSendKey(event)) return;
          event.preventDefault();
          void send();
        }}
        className="min-h-9 py-1.5 text-sm"
      />
      {error ? <SendError message={error} /> : null}
      {focused || !empty ? (
        <div className="mt-2 flex justify-end">
          <Button
            type="submit"
            size="sm"
            loading={busy}
            disabled={empty}
            aria-keyshortcuts={ariaKeyShortcuts(['mod', 'enter'])}
          >
            {t('web.comments.reply')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
