import { LayoutGrid, Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useArtifacts, useProjectNames } from '../api/library.ts';
import { PageHeader } from '../app/shell/page-header.tsx';
import { usePageTitle } from '../lib/page-title.ts';
import { ArtifactCollection, isEmptyCollection } from '../library/artifact-collection.tsx';
import { useLibraryView, ViewToggle } from '../library/view-toggle.tsx';
import { Button, EmptyState } from '../ui/index.ts';
import { LibraryPage } from './library-page.tsx';

/** Every artifact of the active projects, the latest updated first. */
export function AllArtifactsPage() {
  const { t } = useTranslation();
  const artifacts = useArtifacts({});
  const projectNames = useProjectNames();
  const [view, setView] = useLibraryView();
  const title = t('web.library.allTitle');
  usePageTitle(title);

  return (
    <LibraryPage>
      <PageHeader
        title={title}
        description={t('web.library.allDescription')}
        actions={
          isEmptyCollection(artifacts) ? null : <ViewToggle value={view} onChange={setView} />
        }
      />
      <ArtifactCollection
        query={artifacts}
        view={view}
        label={title}
        projectNames={projectNames}
        empty={
          <EmptyState
            icon={<LayoutGrid />}
            title={t('web.library.emptyTitle')}
            description={t('web.library.emptyBody')}
            action={
              <Button asChild variant="secondary" leadingIcon={<Plug />}>
                <Link to="/connect">{t('web.library.connectAgent')}</Link>
              </Button>
            }
          />
        }
      />
    </LibraryPage>
  );
}
