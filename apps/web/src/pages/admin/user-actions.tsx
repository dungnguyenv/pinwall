import { Ellipsis, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePurgeUser, useUpdateAdminUser } from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import type { AdminUser } from '../../api/dto.ts';
import { usePublicConfig } from '../../api/session.ts';
import { useVisibility } from '../../api/spaces.ts';
import {
  ConfirmDialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Switch,
  TypedConfirmDialog,
  toast,
} from '../../ui/index.ts';
import { QuotaDialog } from './quota-dialog.tsx';

/**
 * Whether the person may expose content (`PINWALL_SHARE_LINKS=approved`). Turning it on saves at
 * once. Turning it off revokes every link they made, so while approval is in force it asks
 * first; otherwise nothing depends on it and it saves at once. Admins always may: their switch
 * is on and locked. The switch shows the choice while it saves and goes back to the server's
 * value if the server refuses, whose message is shown as it wrote it.
 */
export function ApprovalSwitch({
  user,
  hideLabel = true,
}: {
  user: AdminUser;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdateAdminUser();
  const inForce = usePublicConfig().data?.share_links === 'approved';
  const [asking, setAsking] = useState(false);
  const admin = user.effective_role === 'admin';
  const saved = admin || user.share_approved === true;
  const shown = update.isPending ? update.variables.patch.share_approved === true : saved;
  const save = (approved: boolean) =>
    update.mutateAsync({ id: user.id, patch: { share_approved: approved } });

  return (
    <>
      <Switch
        label={t('web.admin.approval.for', { name: user.name })}
        hideLabel={hideLabel}
        description={admin ? t('web.admin.approval.admin') : undefined}
        checked={shown}
        disabled={admin}
        onCheckedChange={(approved) => {
          if (update.isPending) return;
          if (!approved && inForce) {
            setAsking(true);
            return;
          }
          save(approved).catch((error: unknown) => toast.error(errorMessage(error, t)));
        }}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        tone="danger"
        title={t('web.admin.approval.removeTitle', { name: user.name })}
        body={t('web.admin.approval.removeBody', { name: user.name })}
        confirmLabel={t('web.admin.approval.removeConfirm')}
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={() => save(false)}
      />
    </>
  );
}

/**
 * More actions on one person: their limits, and in `personal` mode deleting all of their
 * content, which asks for their email address (their id when they have none) first. Nothing
 * here moves content between people.
 */
export function UserMenu({
  user,
  variant = 'ghost',
  size = 'sm',
}: {
  user: AdminUser;
  variant?: 'ghost' | 'secondary';
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  const personal = useVisibility() === 'personal';
  const purge = usePurgeUser();
  const [limiting, setLimiting] = useState(false);
  const [purging, setPurging] = useState(false);
  // The server takes the id when the email is missing or empty.
  const expected = user.email || user.id;

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton
            label={t('web.admin.more', { name: user.name })}
            icon={<Ellipsis />}
            variant={variant}
            size={size}
          />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<SlidersHorizontal />} onSelect={() => setLimiting(true)}>
            {t('web.admin.quota.item')}
          </MenuItem>
          {personal ? (
            <>
              <MenuSeparator />
              <MenuItem tone="danger" icon={<Trash2 />} onSelect={() => setPurging(true)}>
                {t('web.admin.purge.item')}
              </MenuItem>
            </>
          ) : null}
        </MenuContent>
      </Menu>
      <QuotaDialog user={user} open={limiting} onOpenChange={setLimiting} />
      {personal ? (
        <TypedConfirmDialog
          open={purging}
          onOpenChange={setPurging}
          title={t('web.admin.purge.title', { name: user.name })}
          body={t('web.admin.purge.body', { name: user.name })}
          confirmLabel={t('web.purge.button')}
          expected={expected}
          fieldLabel={t('web.purge.type', { value: expected })}
          errorMessage={(error) => errorMessage(error, t)}
          onConfirm={async (typed) => {
            const result = await purge.mutateAsync({ id: user.id, confirm: typed });
            toast.success(
              t('web.admin.purge.done', {
                projects: t('web.purge.projects', { count: result.projects }),
                artifacts: t('web.purge.artifacts', { count: result.artifacts }),
                name: user.name,
              }),
            );
          }}
        />
      ) : null}
    </>
  );
}
