import { useTranslation } from 'react-i18next';
import { useAdminDeleteArtifact, useAdminRevokeShareLink } from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import { ConfirmDialog, toast } from '../../ui/index.ts';

/*
 * The two takedowns that the share-link list and the look-up both offer. Each asks first, says
 * what will happen, shows the server's words when it refuses, and tells the caller when it is
 * done, so the look-up can run again.
 */

interface DialogProps<T> {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** What the dialog is about; it keeps its words while it fades out after `null`. */
  target: T | null;
  onDone?(): void;
}

/** Asks before revoking a share link, whoever made it. */
export function RevokeLinkDialog({
  open,
  onOpenChange,
  target,
  onDone,
}: DialogProps<{ linkId: string; artifactName: string }>) {
  const { t } = useTranslation();
  const revoke = useAdminRevokeShareLink();
  const name = target?.artifactName ?? '';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="danger"
      title={t('web.admin.links.revokeTitle')}
      body={t('web.admin.links.revokeBody', { name })}
      confirmLabel={t('web.admin.links.revokeConfirm')}
      errorMessage={(error) => errorMessage(error, t)}
      onConfirm={async () => {
        if (!target) return;
        await revoke.mutateAsync(target.linkId);
        toast.success(t('web.admin.links.revoked', { name }));
        onDone?.();
      }}
    />
  );
}

/** Asks before deleting an artifact for its owner too, with everything in it. */
export function DeleteArtifactDialog({
  open,
  onOpenChange,
  target,
  onDone,
}: DialogProps<{ artifactId: string; artifactName: string }>) {
  const { t } = useTranslation();
  const deleteArtifact = useAdminDeleteArtifact();
  const name = target?.artifactName ?? '';
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="danger"
      title={t('web.admin.links.deleteTitle', { name })}
      body={t('web.admin.links.deleteBody', { name })}
      confirmLabel={t('web.admin.links.deleteArtifact')}
      errorMessage={(error) => errorMessage(error, t)}
      onConfirm={async () => {
        if (!target) return;
        await deleteArtifact.mutateAsync(target.artifactId);
        toast.success(t('web.admin.links.deleted', { name }));
        onDone?.();
      }}
    />
  );
}
