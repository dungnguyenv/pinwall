import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import { type ProjectMember, ProjectMemberRole } from '../../api/dto.ts';
import { useUpdateMember } from '../../api/members.ts';
import { Avatar, Badge, IconButton, Select, toast } from '../../ui/index.ts';

/** The roles an owner can give, as a Select's options. */
export function useRoleOptions(): { value: ProjectMemberRole; label: string }[] {
  const { t } = useTranslation();
  // Spelled out, so every key can be found by search.
  return [
    { value: 'editor', label: t('web.role.editor') },
    { value: 'viewer', label: t('web.role.viewer') },
  ];
}

/** The name an account is shown by; an account without one is still a person to name. */
export function useDisplayName(): (name: string | null) => string {
  const { t } = useTranslation();
  return (name) => name ?? t('web.members.unnamed');
}

/** Who a row is about: their avatar and name, an optional badge, "You" when it is the viewer, and an optional line under. */
function Person({
  name,
  line,
  you,
  badge,
}: {
  name: string | null;
  line?: string | null;
  you: boolean;
  badge?: ReactNode;
}) {
  const { t } = useTranslation();
  const display = useDisplayName();
  return (
    <div className="flex min-w-0 flex-1 basis-44 items-center gap-3">
      <Avatar name={name ?? ''} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium text-base text-fg">
          <span className="[overflow-wrap:anywhere]">{display(name)}</span>
          {badge}
          {you ? (
            <span className="font-normal text-fg-muted text-sm">{t('web.members.you')}</span>
          ) : null}
        </p>
        {line ? <p className="text-fg-muted text-sm [overflow-wrap:anywhere]">{line}</p> : null}
      </div>
    </div>
  );
}

/** The project's owner: first in the list, and the one person nobody can change. */
export function OwnerRow({ owner, you }: { owner: { name: string | null }; you: boolean }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center py-3">
      <Person name={owner.name} you={you} badge={<Badge>{t('web.role.owner')}</Badge>} />
    </li>
  );
}

/**
 * A member. In the owner's view (`manage`) it shows their email, lets the owner give them
 * another role and offers Remove (`onRemove` asks first); everyone else sees the name only.
 */
export function MemberRow({
  projectId,
  member,
  manage,
  you,
  onRemove,
}: {
  projectId: string;
  member: ProjectMember;
  manage: boolean;
  you: boolean;
  onRemove(): void;
}) {
  const { t } = useTranslation();
  const display = useDisplayName();
  const roles = useRoleOptions();
  const update = useUpdateMember(projectId);
  const name = display(member.user.name);
  // The role asked for shows while the answer is on its way.
  const role = update.isPending && update.variables ? update.variables.role : member.role;

  const changeRole = (next: string) => {
    const parsed = ProjectMemberRole.safeParse(next);
    if (!parsed.success || parsed.data === member.role) return;
    update.mutate(
      { userId: member.user.id, role: parsed.data },
      { onError: (error) => toast.error(errorMessage(error, t)) },
    );
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <Person name={member.user.name} line={manage ? member.user.email : null} you={you} />
      {manage ? (
        <>
          <div className="w-32 shrink-0">
            <Select
              hideLabel
              label={t('web.members.roleFor', { name })}
              value={role}
              onValueChange={changeRole}
              options={roles}
              disabled={update.isPending}
            />
          </div>
          <IconButton
            label={t('web.members.removeFor', { name })}
            icon={<Trash2 />}
            size="sm"
            className="text-danger"
            onClick={onRemove}
          />
        </>
      ) : null}
    </li>
  );
}
