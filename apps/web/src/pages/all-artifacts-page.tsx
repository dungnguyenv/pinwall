import { LayoutGrid, Plug, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useArtifacts, useProjectNames, useProjects } from '../api/library.ts';
import { ownDefaultProject, useVisibility } from '../api/spaces.ts';
import { PageHeader } from '../app/shell/page-header.tsx';
import { useShellActions } from '../app/shell/shell-actions.ts';
import { usePageTitle } from '../lib/page-title.ts';
import { ArtifactCollection, isEmptyCollection } from '../library/artifact-collection.tsx';
import { DropOverlay } from '../library/upload/drop-overlay.tsx';
import { UploadButton, UploadDialog } from '../library/upload/upload-dialog.tsx';
import { useUpload } from '../library/upload/use-upload.tsx';
import { useLibraryView, ViewToggle } from '../library/view-toggle.tsx';
import { Button, EmptyState } from '../ui/index.ts';
import { LibraryPage } from './library-page.tsx';

/**
 * Every artifact of the active projects, the latest updated first. Uploads
 * here go to the person's own default project, whichever project that is.
 */
export function AllArtifactsPage() {
  const { t } = useTranslation();
  const artifacts = useArtifacts({});
  const projectNames = useProjectNames();
  const defaultProject = ownDefaultProject(useProjects(false).data?.items);
  const upload = useUpload({
    projectId: null,
    projectName: defaultProject?.name ?? t('web.upload.defaultProject'),
  });
  const personal = useVisibility() === 'personal';
  const { openNewProject } = useShellActions();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [view, setView] = useLibraryView();
  const title = t('web.library.allTitle');
  usePageTitle(title);

  return (
    <LibraryPage>
      <PageHeader
        title={title}
        description={t('web.library.allDescription')}
        actions={
          <>
            {isEmptyCollection(artifacts) ? null : <ViewToggle value={view} onChange={setView} />}
            <UploadButton
              label={t('web.upload.action')}
              variant="primary"
              onClick={() => setUploadOpen(true)}
            />
          </>
        }
      />
      <ArtifactCollection
        query={artifacts}
        view={view}
        label={title}
        projectNames={projectNames}
        empty={
          personal ? (
            <EmptyState
              icon={<LayoutGrid />}
              title={t('web.library.spaceEmptyTitle')}
              description={t('web.library.spaceEmptyBody')}
              action={
                <>
                  <Button asChild variant="primary" leadingIcon={<Plug />}>
                    <Link to="/connect">{t('web.library.connectAgent')}</Link>
                  </Button>
                  <UploadButton
                    label={t('web.upload.actionFiles')}
                    variant="secondary"
                    onClick={() => setUploadOpen(true)}
                  />
                  <Button variant="secondary" leadingIcon={<Plus />} onClick={openNewProject}>
                    {t('web.sidebar.newProject')}
                  </Button>
                </>
              }
            />
          ) : (
            <EmptyState
              icon={<LayoutGrid />}
              title={t('web.library.emptyTitle')}
              description={t('web.library.emptyBody')}
              action={
                <>
                  <UploadButton
                    label={t('web.upload.actionFiles')}
                    variant="secondary"
                    onClick={() => setUploadOpen(true)}
                  />
                  <Button asChild variant="secondary" leadingIcon={<Plug />}>
                    <Link to="/connect">{t('web.library.connectAgent')}</Link>
                  </Button>
                </>
              }
            />
          )
        }
      />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} upload={upload} />
      <DropOverlay label={upload.projectName} onSelection={upload.start} />
      {upload.inputs}
    </LibraryPage>
  );
}
