import { AppWindow, FileText, Search, X } from 'lucide-react';
import { Dialog as RadixDialog, VisuallyHidden } from 'radix-ui';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client.ts';
import type { ArtifactSummary } from '../../api/dto.ts';
import { useArtifactSearch, useProjects } from '../../api/library.ts';
import { formatRelativeTime } from '../../lib/format.ts';
import { OVERLAY_CLASS, panelClass, useReturnFocus } from '../../ui/dialog.tsx';
import { Button, cn, IconButton, isApplePlatform, Spinner } from '../../ui/index.ts';

/** The server accepts search terms up to this many characters. */
const MAX_QUERY = 256;
const DEBOUNCE_MS = 200;

/** Opens search on mod+K (⌘K on Apple platforms, Ctrl+K elsewhere), from anywhere in the app. */
export function useSearchShortcut(open: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
      const apple = isApplePlatform();
      const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function ResultIcon({ kind }: { kind: ArtifactSummary['kind'] }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface text-fg-muted [&_svg]:size-4"
    >
      {kind === 'markdown' ? <FileText /> : <AppWindow />}
    </span>
  );
}

/**
 * The search box and its results, following the ARIA combobox pattern: focus
 * stays in the input, arrows move the highlighted option, and Enter opens it.
 * With nothing highlighted, Enter shows every result on the search page.
 */
function SearchPanel({ onGo }: { onGo(path: string): void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const term = useDebounced(text.trim(), DEBOUNCE_MS);
  const search = useArtifactSearch(term);
  const projects = useProjects(false);
  const listboxId = useId();
  const optionId = (artifactId: string) => `${listboxId}-${artifactId}`;

  const typed = text.trim();
  const results = typed !== '' && term !== '' ? (search.data?.items ?? []) : [];
  const expanded = results.length > 0;
  const activeIndex = results.findIndex((artifact) => artifact.id === activeId);
  const active = activeIndex === -1 ? null : (results[activeIndex] ?? null);
  const busy = typed !== '' && (typed !== term || search.isFetching);
  const projectName = (id: string) => projects.data?.items.find((p) => p.id === id)?.name;

  const activeOptionId = active ? optionId(active.id) : undefined;
  useEffect(() => {
    if (activeOptionId)
      document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

  const move = (step: 1 | -1) => {
    if (results.length === 0) return;
    const from = activeIndex === -1 ? (step === 1 ? -1 : results.length) : activeIndex;
    const next = (from + step + results.length) % results.length;
    setActiveId(results[next]?.id ?? null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active) onGo(`/a/${active.id}`);
      else if (typed !== '') onGo(`/search?${new URLSearchParams({ q: typed })}`);
    }
  };

  let body: ReactNode = null;
  if (typed === '') {
    body = <p className="px-5 py-6 text-base text-fg-muted">{t('web.search.hint')}</p>;
  } else if (search.isError && !search.isFetching && typed === term) {
    body = (
      <div role="alert" className="flex flex-wrap items-center gap-3 px-5 py-6">
        <p className="min-w-0 flex-1 text-base text-fg-muted">{errorMessage(search.error, t)}</p>
        <Button variant="secondary" size="sm" onClick={() => void search.refetch()}>
          {t('web.common.retry')}
        </Button>
      </div>
    );
  } else if (
    search.isSuccess &&
    !search.isPlaceholderData &&
    typed === term &&
    results.length === 0
  ) {
    body = (
      <p role="status" className="break-words px-5 py-6 text-base text-fg-muted">
        {t('web.search.noResults', { q: term })}
      </p>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-border border-b pr-3 pl-5 shadow-[inset_0_-2px_0_transparent] transition-shadow focus-within:shadow-[inset_0_-2px_0_var(--pw-accent)]">
        <Search aria-hidden="true" className="size-4.5 shrink-0 text-fg-muted" />
        <input
          type="text"
          role="combobox"
          aria-label={t('web.search.label')}
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={MAX_QUERY}
          placeholder={t('web.search.placeholder')}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-14 min-w-0 flex-1 bg-transparent text-fg text-md outline-none placeholder:text-fg-subtle pointer-coarse:text-[1rem]"
        />
        {busy ? <Spinner label={t('web.search.searching')} className="text-fg-muted" /> : null}
        <RadixDialog.Close asChild>
          <IconButton
            label={t('web.common.close')}
            icon={<X />}
            size="sm"
            tooltip={false}
            className="text-fg-muted hover:text-fg"
          />
        </RadixDialog.Close>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('web.search.results')}
          hidden={!expanded}
          className="flex flex-col gap-px p-2"
        >
          {results.map((artifact) => {
            const isActive = artifact.id === active?.id;
            const project = projectName(artifact.project_id);
            return (
              // Focus stays in the combobox input, which handles the keys and
              // points at the highlighted option with aria-activedescendant.
              // biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant pattern
              // biome-ignore lint/a11y/useKeyWithClickEvents: aria-activedescendant pattern
              <div
                key={artifact.id}
                id={optionId(artifact.id)}
                role="option"
                aria-selected={isActive}
                onMouseMove={() => setActiveId(artifact.id)}
                onClick={() => onGo(`/a/${artifact.id}`)}
                className={cn(
                  'flex cursor-pointer select-none items-center gap-3 rounded-md px-3 py-2',
                  isActive && 'bg-selected',
                )}
              >
                <ResultIcon kind={artifact.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-base text-fg">
                    {artifact.name}
                  </span>
                  {project ? (
                    <span className="block truncate text-fg-muted text-sm">{project}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-fg-muted text-xs">
                  {formatRelativeTime(artifact.updated_at)}
                </span>
              </div>
            );
          })}
        </div>
        {body}
      </div>

      <div className="flex shrink-0 items-center border-border border-t px-5 py-2.5 text-fg-muted text-xs max-sm:pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        {t('web.search.enterHint')}
      </div>
    </>
  );
}

/**
 * Search across every artifact. It sits high on wide screens, so results grow
 * downward without the box moving, and fills most of a phone's height so the
 * box stays above the on-screen keyboard. Each opening starts empty.
 */
export function SearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const returnFocus = useReturnFocus();
  // After opening a result, the new page focuses its own heading.
  const leaving = useRef(false);

  const go = (path: string) => {
    leaving.current = true;
    onOpenChange(false);
    void navigate(path);
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={cn(OVERLAY_CLASS, 'sm:items-start sm:pt-[12dvh]')}>
          <RadixDialog.Content
            aria-describedby={undefined}
            className={cn(
              panelClass('md'),
              'overflow-hidden sm:max-h-[min(36rem,76dvh)] sm:max-w-xl max-sm:h-[90dvh]',
            )}
            onOpenAutoFocus={returnFocus.onOpenAutoFocus}
            onCloseAutoFocus={(event) => {
              if (leaving.current) event.preventDefault();
              leaving.current = false;
              returnFocus.onCloseAutoFocus(event);
            }}
          >
            <VisuallyHidden.Root asChild>
              <RadixDialog.Title>{t('web.search.title')}</RadixDialog.Title>
            </VisuallyHidden.Root>
            <SearchPanel onGo={go} />
          </RadixDialog.Content>
        </RadixDialog.Overlay>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
