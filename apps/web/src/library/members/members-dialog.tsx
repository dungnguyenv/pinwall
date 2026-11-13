import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client.ts';
import type { Project, ProjectMember } from '../../api/dto.ts';
import { useLeaveProject, useMembers, useRemoveMember } from '../../api/members.ts';
import { useMe } from '../../api/session.ts';
import { useRowDialog } from '../../pages/settings/use-row-dialog.ts';
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  LoadingRegion,
  Skeleton,
  toast,
} from '../../ui/index.ts';
import { AddMemberForm } from './add-member-form.tsx';
import { MemberRow, OwnerRow, useDisplayName } from './member-row.tsx';

function MembersSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.members.loading')}>
      <div className="flex flex-col gap-4 py-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </LoadingRegion>
  );
}

/**
 * The people in a project, in `personal` mode. The owner comes first, then the members, oldest
 * first. The owner sees emails and roles and can add, change and remove people; an editor or
 * viewer sees names only, and may leave.
 */
export function MembersDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const me = useMe().data;
  const display = useDisplayName();
  const removeMember = useRemoveMember(project.id);
  const leave = useLeaveProject(project.id);
  // Once the person has left, the list is out of reach: leaving drops it, and nothing asks again.
  const members = useMembers(project.id, open && !leave.isSuccess);
  const removing = useRowDialog<ProjectMember>();
  const [leaving, setLeaving] = useState(false);
  // Anyone but the owner (or whoever the server did not tell) gets the names-only view.
  const isOwner = project.role === 'owner';
  const items = members.data?.items;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('web.members.title', { project: project.name })}
        footer={
          isOwner ? undefined : (
            <Button variant="secondary" className="text-danger" onClick={() => setLeaving(true)}>
              {t('web.members.leave')}
            </Button>
          )
        }
      >
        {items ? (
          <div className="flex flex-col gap-5">
            <ul aria-label={t('web.members.listLabel')} className="divide-y divide-border">
              {project.owner ? (
                <OwnerRow owner={project.owner} you={project.owner.id === me?.id} />
              ) : null}
              {items.map((member) => (
                <MemberRow
                  key={member.user.id}
                  projectId={project.id}
                  member={member}
                  manage={isOwner}
                  you={member.user.id === me?.id}
                  onRemove={() => removing.show(member)}
                />
              ))}
            </ul>
            {isOwner && items.length === 0 ? (
              <p className="rounded-lg border border-border-strong border-dashed px-4 py-5 text-center text-fg-muted text-sm">
                {t('web.members.empty')}
              </p>
            ) : null}
            {isOwner ? (
              <AddMemberForm project={project} />
            ) : (
              <p className="text-fg-muted text-sm">{t('web.members.memberHint')}</p>
            )}
          </div>
        ) : members.isError ? (
          <ErrorState
            compact
            message={errorMessage(members.error, t)}
            onRetry={() => void members.refetch()}
          />
        ) : (
          <MembersSkeleton />
        )}
      </Dialog>
      <ConfirmDialog
        open={removing.open}
        onOpenChange={removing.onOpenChange}
        tone="danger"
        title={t('web.members.remove.title')}
        body={t('web.members.remove.body', {
          name: display(removing.item?.user.name ?? null),
          project: project.name,
        })}
        confirmLabel={t('web.members.remove.confirm')}
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          if (removing.item) await removeMember.mutateAsync(removing.item.user.id);
        }}
      />
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        tone="danger"
        title={t('web.members.leave.title')}
        body={t('web.members.leave.body')}
        confirmLabel={t('web.members.leave')}
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          await leave.mutateAsync();
          // The project is out of reach now: leave its page before anything asks for it again.
          void navigate('/');
          toast.success(t('web.members.left', { project: project.name }));
        }}
      />
    </>
  );
}
