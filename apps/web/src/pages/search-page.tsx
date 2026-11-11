import { Search, SearchX } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { SEARCH_MAX_CHARS, useArtifacts, useProjectNames } from '../api/library.ts';
import { PageHeader } from '../app/shell/page-header.tsx';
import { usePageTitle } from '../lib/page-title.ts';
import { ArtifactCollection, isEmptyCollection } from '../library/artifact-collection.tsx';
import { useLibraryView, ViewToggle } from '../library/view-toggle.tsx';
import { cn, EmptyState } from '../ui/index.ts';
import { CONTROL_CLASS } from '../ui/input.tsx';
import { LibraryPage } from './library-page.tsx';

/**
 * Every match for `?q=`, the best first. The server ignores accents and case,
 * so "chup anh" finds "Chụp ảnh". The box is filled from the address, and
 * Enter puts a new term in the address, so Back returns to the last search.
 */
export function SearchPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const results = useArtifacts({ q });
  const projectNames = useProjectNames();
  const [view, setView] = useLibraryView();

  // The box follows the address when it changes (Back, or the search dialog).
  const [text, setText] = useState(q);
  const [shownQ, setShownQ] = useState(q);
  if (q !== shownQ) {
    setShownQ(q);
    setText(q);
  }

  const title = q ? t('web.search.resultsFor', { q }) : t('web.search.pageTitle');
  usePageTitle(title);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const term = text.trim();
    setParams(term ? { q: term } : {});
  };

  return (
    <LibraryPage>
      <PageHeader
        title={title}
        actions={
          q && !isEmptyCollection(results) ? <ViewToggle value={view} onChange={setView} /> : null
        }
      >
        <search className="block max-w-xl">
          <form onSubmit={submit} className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted"
            />
            <input
              type="search"
              aria-label={t('web.search.label')}
              placeholder={t('web.search.placeholder')}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              maxLength={SEARCH_MAX_CHARS}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className={cn(CONTROL_CLASS, 'h-10 rounded-full bg-surface pr-4 pl-9')}
            />
          </form>
        </search>
      </PageHeader>
      {q ? (
        <ArtifactCollection
          query={results}
          view={view}
          label={t('web.search.results')}
          projectNames={projectNames}
          empty={
            <EmptyState
              icon={<SearchX />}
              title={t('web.search.empty', { q })}
              description={t('web.search.emptyHint')}
            />
          }
        />
      ) : (
        <p className="text-base text-fg-muted">{t('web.search.hint')}</p>
      )}
    </LibraryPage>
  );
}
