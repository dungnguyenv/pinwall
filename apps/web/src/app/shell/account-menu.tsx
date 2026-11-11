import { ChevronsUpDown, LogOut, Plug, Settings, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client.ts';
import { useMe, useSignOut } from '../../api/session.ts';
import {
  Avatar,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
  toast,
} from '../../ui/index.ts';

/**
 * The signed-in person's menu at the foot of the sidebar: their avatar and
 * name, or in the rail (`compact`) the avatar alone, named by a tooltip.
 */
export function AccountMenu({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const signOut = useSignOut();
  if (!me) return null;

  const trigger = compact ? (
    <MenuTrigger asChild>
      <button
        type="button"
        aria-label={me.name}
        className="inline-grid size-9 cursor-pointer place-items-center rounded-full transition-colors hover:bg-selected/70 aria-expanded:bg-selected"
      >
        <Avatar name={me.name} size="sm" />
      </button>
    </MenuTrigger>
  ) : (
    <MenuTrigger asChild>
      <button
        type="button"
        className="flex h-11 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 text-left outline-offset-[-2px] transition-colors hover:bg-selected/70 aria-expanded:bg-selected"
      >
        <Avatar name={me.name} size="sm" />
        <span className="min-w-0 flex-1 truncate font-medium text-base text-fg">{me.name}</span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      </button>
    </MenuTrigger>
  );

  return (
    <Menu>
      {compact ? (
        <Tooltip content={me.name} side="right">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <MenuContent
        side={compact ? 'right' : 'top'}
        align={compact ? 'end' : 'start'}
        className={compact ? 'w-60' : 'w-(--radix-dropdown-menu-trigger-width) min-w-56'}
      >
        {me.email ? <MenuLabel>{me.email}</MenuLabel> : null}
        <MenuItem icon={<Settings />} asChild>
          <Link to="/settings">{t('web.account.settings')}</Link>
        </MenuItem>
        <MenuItem icon={<Plug />} asChild>
          <Link to="/connect">{t('web.account.connect')}</Link>
        </MenuItem>
        {me.role === 'admin' ? (
          <MenuItem icon={<ShieldCheck />} asChild>
            <Link to="/admin">{t('web.account.admin')}</Link>
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem
          icon={<LogOut />}
          disabled={signOut.isPending}
          onSelect={() =>
            signOut.mutate(undefined, { onError: (error) => toast.error(errorMessage(error, t)) })
          }
        >
          {t('web.account.signOut')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
