import { BadgeCheck, UserX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ROLE_OPTIONS, type RoleOption, toRoleOption, useSetUserRole } from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import type { AdminUser } from '../../api/dto.ts';
import { formatDate, formatRelativeTime } from '../../lib/format.ts';
import { Avatar, Badge, type BadgeTone, Select, Tooltip, toast } from '../../ui/index.ts';

/*
 * The pieces of a user shared by the table (wide content areas) and the
 * stacked cards (everything narrower), so both show the same facts and take
 * the same actions.
 */

type Role = NonNullable<AdminUser['effective_role']>;

const ROLE_TONES: Record<Role, BadgeTone> = {
  admin: 'accent',
  member: 'neutral',
  blocked: 'danger',
};

/** The role Pinwall acts on. A user with no role at all cannot use Pinwall, which is worth a warning. */
function RoleBadge({ role }: { role: AdminUser['effective_role'] }) {
  const { t } = useTranslation();
  return role === null ? (
    <Badge tone="warning">{t('web.admin.role.none')}</Badge>
  ) : (
    <Badge tone={ROLE_TONES[role]}>{t(`web.admin.role.${role}`)}</Badge>
  );
}

/**
 * The effective role, and under it what the identity provider gave, so a
 * glance shows both the role in force and whether an override caused it. The
 * owner has no identity provider.
 */
export function RoleCell({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const given =
    user.idp_role === null ? t('web.admin.role.idpNone') : t(`web.admin.role.${user.idp_role}`);
  return (
    <div className="flex flex-col items-start gap-1">
      <RoleBadge role={user.effective_role} />
      {user.kind === 'owner' ? null : (
        <span className="text-fg-muted text-sm">
          {t('web.admin.role.fromIdp', { role: given })}
        </span>
      )}
    </div>
  );
}

/** The avatar, name, email and badges that say who this is. */
export function PersonCell({ user, isSelf }: { user: AdminUser; isSelf: boolean }) {
  const { t } = useTranslation();
  const disabled = user.disabled_reason !== null || user.disabled_at !== null;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <Avatar name={user.name} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-words font-medium text-base text-fg [overflow-wrap:anywhere]">
            {user.name}
          </span>
          {isSelf ? <span className="text-fg-muted text-sm">{t('web.admin.you')}</span> : null}
          <Badge>{t(`web.admin.kind.${user.kind}`)}</Badge>
        </div>
        <p className="mt-0.5 flex items-center gap-1.5 text-fg-muted text-sm">
          {user.email ? (
            <>
              <span className="min-w-0 [overflow-wrap:anywhere]">{user.email}</span>
              {user.email_verified ? (
                <span title={t('web.admin.emailVerified')} className="inline-flex shrink-0">
                  <BadgeCheck aria-hidden="true" className="size-3.5 text-success" />
                  <span className="sr-only">{t('web.admin.emailVerified')}</span>
                </span>
              ) : null}
            </>
          ) : (
            t('web.admin.noEmail')
          )}
        </p>
        {disabled ? (
          <div className="mt-1.5">
            <Badge tone="warning" icon={<UserX />}>
              {user.disabled_reason === 'idp_removed'
                ? t('web.admin.status.idp_removed')
                : t('web.admin.status.disabled')}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function LastSeen({ at }: { at: number | null }) {
  const { t } = useTranslation();
  if (at === null) return <span className="text-fg-muted">{t('web.admin.lastSeen.never')}</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDate(at)}>
      {formatRelativeTime(at)}
    </time>
  );
}

/**
 * Sets or clears a user's role override. Choosing saves at once; the Select
 * shows the choice while it saves and goes back if the server refuses, whose
 * message is shown as it wrote it. When the role is locked the Select is
 * disabled and a focusable wrapper explains why, since a disabled control
 * takes no focus. With `showReason`, the reason is also printed under it, for
 * screens that cannot hover.
 */
export function RoleSelect({
  user,
  isSelf,
  showReason = false,
  hideLabel = true,
}: {
  user: AdminUser;
  isSelf: boolean;
  showReason?: boolean;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const setRole = useSetUserRole();
  // The server refuses the same two cases: your own role, and the owner's.
  const reason = isSelf ? t('auth.ownRole') : user.kind === 'owner' ? t('auth.ownerRole') : null;
  const label = t('web.admin.role.overrideFor', { name: user.name });

  // The owner is always an admin, whatever an override says.
  const saved: RoleOption = user.kind === 'owner' ? 'admin' : toRoleOption(user.role_override);
  const shown = setRole.isPending ? setRole.variables.option : saved;

  const select = (
    <Select
      label={label}
      hideLabel={hideLabel}
      value={shown}
      disabled={reason !== null}
      options={ROLE_OPTIONS.map((option) => ({
        value: option,
        label: t(`web.admin.role.${option}`),
      }))}
      onValueChange={(value) => {
        const option = ROLE_OPTIONS.find((o) => o === value);
        if (option === undefined || option === saved || setRole.isPending) return;
        setRole.mutate(
          { id: user.id, option },
          {
            onSuccess: () => toast.success(t('web.admin.role.saved', { name: user.name })),
            onError: (error) => toast.error(errorMessage(error, t)),
          },
        );
      }}
    />
  );

  if (reason === null) return select;
  return (
    <div className="flex flex-col gap-1.5">
      <Tooltip content={reason}>
        <fieldset
          aria-label={label}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled Select takes no focus, so this carries the reason
          tabIndex={0}
          className="m-0 min-w-0 rounded-md border-0 p-0"
        >
          {select}
        </fieldset>
      </Tooltip>
      {showReason ? <p className="text-fg-muted text-sm">{reason}</p> : null}
    </div>
  );
}
