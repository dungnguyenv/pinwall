import { Archive, ArchiveRestore, Ellipsis, LayoutGrid, Pencil, Plug, Upload } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/client.ts';
import { Label, type Project } from '../api/dto.ts';
import { useArtifacts, useProject, useUpdateProject } from '../api/library.ts';
import { PageHeader } from '../app/shell/page-header.tsx';
import { formatRelativeTime } from '../lib/format.ts';
import { usePageTitle } from '../lib/page-title.ts';
import { ArtifactCollection, isEmptyCollection } from '../library/artifact-collection.tsx';
import { InstructionsEditor } from '../library/instructions-editor.tsx';
import { useLibraryView, ViewToggle } from '../library/view-toggle.tsx';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadingRegion,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Skeleton,
  toast,
} from '../ui/index.ts';
import { LibraryPage, PageError } from './library-page.tsx';

const MAX_NAME = 100;

function RenameDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const update = useUpdateProject(project.id);
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(project.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(project.name);
      setNameError(null);
      setFormError(null);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (update.isPending) return;
    const parsed = Label.safeParse(name);
    if (!parsed.success) {
      setNameError(t('web.project.nameRequired'));
      input.current?.focus();
      return;
    }
    if (parsed.data === project.name) {
      onOpenChange(false);
      return;
    }
    setFormError(null);
    update.mutate(
      { name: parsed.data },
      {
        onSuccess: () => onOpenChange(false),
        onError: (error) => setFormError(errorMessage(error, t)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('web.project.renameTitle')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('web.common.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={update.isPending}>
            {t('web.common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('web.project.name')} error={nameError ?? formError}>
          {(control) => (
            <Input
              {...control}
              ref={input}
              value={name}
              maxLength={MAX_NAME}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setNameError(null);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function ProjectMenu({ project, onRename }: { project: Project; onRename(): void }) {
  const { t } = useTranslation();
  const update = useUpdateProject(project.id);
  const setArchived = (archived: boolean) =>
    update.mutate({ archived }, { onError: (error) => toast.error(errorMessage(error, t)) });
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          label={t('web.project.menu')}
          icon={<Ellipsis />}
          variant="secondary"
          loading={update.isPending}
        />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem icon={<Pencil />} onSelect={onRename}>
          {t('web.project.rename')}
        </MenuItem>
        {project.is_default ? null : project.archived_at === null ? (
          <MenuItem icon={<Archive />} onSelect={() => setArchived(true)}>
            {t('web.project.archive')}
          </MenuItem>
        ) : (
          <MenuItem icon={<ArchiveRestore />} onSelect={() => setArchived(false)}>
            {t('web.project.unarchive')}
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

function ArchivedBanner({ project }: { project: Project }) {
  const { t } = useTranslation();
  const update = useUpdateProject(project.id);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg bg-warning-soft px-4 py-3 sm:px-5">
      <Archive aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 basis-56 text-base text-fg">{t('web.project.archivedBanner')}</p>
      <Button
        variant="secondary"
        size="sm"
        loading={update.isPending}
        onClick={() =>
          update.mutate(
            { archived: false },
            { onError: (error) => toast.error(errorMessage(error, t)) },
          )
        }
      >
        {t('web.project.unarchive')}
      </Button>
    </div>
  );
}

function ProjectSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.project.loading')}>
      <div className="flex flex-col gap-5 pt-6 pb-6 md:pt-10">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="-mt-2 h-4 w-48" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </LoadingRegion>
  );
}

function ProjectView({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const project = useProject(projectId);
  const artifacts = useArtifacts({ projectId });
  const [view, setView] = useLibraryView();
  const [renaming, setRenaming] = useState(false);
  usePageTitle(project.data?.name ?? null);

  if (!project.data) {
    if (project.isError) {
      return (
        <PageError
          error={project.error}
          unavailableTitle={t('web.project.unavailable')}
          onRetry={() => void project.refetch()}
        />
      );
    }
    return <ProjectSkeleton />;
  }

  const p = project.data;
  const archived = p.archived_at !== null;
  const newest = Math.max(p.updated_at, artifacts.data?.pages[0]?.items[0]?.updated_at ?? 0);
  const upload = (label: string, primary: boolean) => (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      leadingIcon={<Upload />}
      disabled={archived}
    >
      {label}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={p.name}
        description={t('web.project.summary', {
          count: p.artifact_count,
          time: formatRelativeTime(newest),
        })}
        actions={
          <>
            {upload(t('web.project.upload'), true)}
            <ProjectMenu project={p} onRename={() => setRenaming(true)} />
          </>
        }
      >
        {archived ? <ArchivedBanner project={p} /> : null}
        <InstructionsEditor project={p} />
      </PageHeader>

      {isEmptyCollection(artifacts) ? null : (
        <div className="flex items-center justify-between gap-3 pb-4">
          <h2 className="font-medium text-fg text-md">{t('web.project.artifacts')}</h2>
          <ViewToggle value={view} onChange={setView} />
        </div>
      )}
      <ArtifactCollection
        query={artifacts}
        view={view}
        label={t('web.project.artifacts')}
        empty={
          <EmptyState
            icon={<LayoutGrid />}
            title={t('web.project.emptyTitle')}
            description={t('web.project.emptyBody')}
            action={
              <>
                {upload(t('web.project.uploadFiles'), false)}
                <Button asChild variant="secondary" leadingIcon={<Plug />}>
                  <Link to="/connect">{t('web.project.connectAgent')}</Link>
                </Button>
              </>
            }
          />
        }
      />
      <RenameDialog project={p} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}

/** A project: its name and counts, the instructions agents read, and its artifacts. */
export function ProjectPage() {
  const { projectId = '' } = useParams();
  // A new project starts fresh: no half-typed instructions or open dialog carry over.
  return (
    <LibraryPage>
      <ProjectView key={projectId} projectId={projectId} />
    </LibraryPage>
  );
}
