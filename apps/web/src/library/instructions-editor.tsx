import { CircleAlert, Pencil, Plus } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../api/client.ts';
import type { Project } from '../api/dto.ts';
import { INSTRUCTIONS_MAX, useUpdateProject } from '../api/library.ts';
import { ariaKeyShortcuts, Button, cn, isApplePlatform, Textarea } from '../ui/index.ts';

const count = new Intl.NumberFormat('en');
const SAVE_SHORTCUT = ['mod', 'enter'];

/** Whether `event` is mod+Enter: ⌘↵ on Apple platforms, Ctrl+Enter elsewhere. */
function isSaveShortcut(event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return false;
  return isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * The instructions as text, clamped to four lines with "Show more" when they
 * run longer. Whether they do is measured, so it follows the width.
 */
function InstructionsText({ text }: { text: string }) {
  const { t } = useTranslation();
  const id = useId();
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // A new text can overflow at the same box size, which the observer would miss.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the trigger
  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="mt-3">
      <p
        ref={paragraph}
        id={id}
        className={cn(
          'whitespace-pre-wrap break-words text-base text-fg',
          !expanded && 'line-clamp-4',
        )}
      >
        {text}
      </p>
      {overflowing || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((open) => !open)}
          className="mt-1.5 cursor-pointer rounded-sm font-medium text-fg-muted text-sm underline-offset-2 hover:text-fg hover:underline"
        >
          {expanded ? t('web.instructions.showLess') : t('web.instructions.showMore')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The project's instructions for agents, edited in place. mod+Enter saves and
 * Escape cancels; a refusal from the server shows under the box as the server
 * worded it, and the draft stays.
 */
export function InstructionsEditor({ project }: { project: Project }) {
  const { t } = useTranslation();
  const update = useUpdateProject(project.id);
  const titleId = useId();
  const helpId = useId();
  const counterId = useId();
  const errorId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Where focus goes once the mode changes: into the box, or back to its button.
  const focusNext = useRef<'textarea' | 'button' | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each change of mode
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'textarea' && textarea.current) {
      const end = textarea.current.value.length;
      textarea.current.focus();
      textarea.current.setSelectionRange(end, end);
    } else if (target === 'button') {
      editButton.current?.focus();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(project.instructions);
    setError(null);
    focusNext.current = 'textarea';
    setEditing(true);
  };

  const stopEditing = () => {
    setError(null);
    focusNext.current = 'button';
    setEditing(false);
  };

  const over = draft.length > INSTRUCTIONS_MAX;

  const save = () => {
    if (over || update.isPending) return;
    if (draft === project.instructions) {
      stopEditing();
      return;
    }
    setError(null);
    update.mutate(
      { instructions: draft },
      {
        onSuccess: stopEditing,
        onError: (e) => setError(errorMessage(e, t)),
      },
    );
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (isSaveShortcut(event)) {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape' && !update.isPending) {
      event.preventDefault();
      stopEditing();
    }
  };

  const text = project.instructions;
  const describedBy = [helpId, counterId, error || over ? errorId : null].filter(Boolean).join(' ');

  return (
    <section aria-labelledby={titleId} className="rounded-lg bg-surface-muted px-4 py-3.5 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="font-medium text-base text-fg">
            {t('web.instructions.title')}
          </h2>
          <p id={helpId} className="mt-0.5 text-fg-muted text-sm">
            {t('web.instructions.help')}
          </p>
        </div>
        {editing ? null : (
          <Button
            ref={editButton}
            variant="ghost"
            size="sm"
            className="-mt-1 -mr-2 shrink-0 hover:bg-selected"
            leadingIcon={text ? <Pencil /> : <Plus />}
            onClick={startEditing}
          >
            {text ? t('web.instructions.edit') : t('web.instructions.add')}
          </Button>
        )}
      </div>

      {editing ? (
        <form noValidate onSubmit={onSubmit} onKeyDown={onKeyDown} className="mt-3">
          <Textarea
            ref={textarea}
            autosize
            rows={4}
            value={draft}
            aria-labelledby={titleId}
            aria-describedby={describedBy}
            aria-invalid={over || undefined}
            aria-keyshortcuts={ariaKeyShortcuts(SAVE_SHORTCUT)}
            onChange={(event) => setDraft(event.target.value)}
            className="bg-surface"
          />
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <span
              id={counterId}
              className={cn('text-sm tabular-nums', over ? 'text-danger' : 'text-fg-muted')}
            >
              {t('web.instructions.counter', {
                length: count.format(draft.length),
                max: count.format(INSTRUCTIONS_MAX),
              })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                aria-keyshortcuts="Escape"
                disabled={update.isPending}
                onClick={stopEditing}
              >
                {t('web.common.cancel')}
              </Button>
              <Button
                type="submit"
                size="sm"
                aria-keyshortcuts={ariaKeyShortcuts(SAVE_SHORTCUT)}
                disabled={over}
                loading={update.isPending}
              >
                {t('web.common.save')}
              </Button>
            </div>
          </div>
          {error || over ? (
            <p
              id={errorId}
              role="alert"
              className="mt-2 flex items-start gap-1.5 text-danger text-sm"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {error ?? t('web.instructions.tooLong', { max: count.format(INSTRUCTIONS_MAX) })}
              </span>
            </p>
          ) : null}
        </form>
      ) : text ? (
        <InstructionsText text={text} />
      ) : (
        <p className="mt-3 text-base text-fg-muted">{t('web.instructions.empty')}</p>
      )}
    </section>
  );
}
