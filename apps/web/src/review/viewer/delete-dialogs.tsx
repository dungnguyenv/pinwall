import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import type { ArtifactSummary } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { deleteArtifact, deleteVersion, refreshVersions, reviewPath } from '../../api/versions.ts';
import { useGoTo } from '../../lib/navigation.ts';
import { ConfirmDialog, toast } from '../../ui/index.ts';

interface DialogProps {
  artifact: ArtifactSummary;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * Asks before deleting version `number`, then goes back to the artifact's
 * latest version. The server refuses anyone but an admin or the publisher;
 * its message shows in the dialog, which stays open.
 */
export function DeleteVersionDialog({
  artifact,
  number,
  open,
  onOpenChange,
}: DialogProps & { number: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const goTo = useGoTo();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="danger"
      title={t('web.review.deleteVersion.title', { number })}
      body={t('web.review.deleteVersion.body', { number })}
      confirmLabel={t('web.review.deleteVersion.confirm', { number })}
      errorMessage={(caught) => errorMessage(caught, t)}
      onConfirm={async () => {
        await deleteVersion(artifact.id, number);
        // Read what is current now first, so the page that follows shows it straight away.
        await refreshVersions(queryClient, artifact.id);
        goTo(reviewPath(artifact.id));
        toast.success(t('web.review.deleteVersion.done', { number }));
      }}
    />
  );
}

/** Asks before deleting the artifact, then goes to its project. */
export function DeleteArtifactDialog({ artifact, open, onOpenChange }: DialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const goTo = useGoTo();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="danger"
      title={t('web.review.deleteArtifact.title', { name: artifact.name })}
      body={t('web.review.deleteArtifact.body', { name: artifact.name })}
      confirmLabel={t('web.review.deleteArtifact.confirm')}
      errorMessage={(caught) => errorMessage(caught, t)}
      onConfirm={async () => {
        await deleteArtifact(artifact.id);
        // Counts and lists change; the artifact's own queries are left alone, since it is gone.
        void queryClient.invalidateQueries({ queryKey: qk.artifactLists });
        void queryClient.invalidateQueries({ queryKey: qk.projectLists });
        void queryClient.invalidateQueries({ queryKey: qk.project(artifact.project_id) });
        goTo(`/projects/${encodeURIComponent(artifact.project_id)}`);
        toast.success(t('web.review.deleteArtifact.done', { name: artifact.name }));
      }}
    />
  );
}
