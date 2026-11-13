import { Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminUsers, useRevokeUser } from '../../api/admin.ts';
import { errorMessage } from '../../api/client.ts';
import type { AdminUser } from '../../api/dto.ts';
import { useLeaveSession, useMe, usePublicConfig } from '../../api/session.ts';
import { useMediaQuery } from '../../lib/media.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import {
  Button,
  ConfirmDialog,
  cn,
  EmptyState,
  ErrorState,
  LoadingRegion,
  Skeleton,
  toast,
} from '../../ui/index.ts';
import { useRowDialog } from '../settings/use-row-dialog.ts';
import { ApprovalSwitch, UserMenu } from './user-actions.tsx';
import { LastSeen, PersonCell, RoleCell, RoleSelect, UsageCell } from './user-parts.tsx';

/**
 * The table needs the whole width the content area ever has: that area stops
 * growing at 1136 px (`--content-library` less the page gutters), and the seven
 * columns, with the usage and sharing ones, fill about 1120 px of it. The open
 * sidebar (264 px and its border), a scrollbar and the content's maximum width
 * reach 1136 px from a window of about 1480 px, so a window narrower than this
 * gets the cards, where actions never sit off-screen. The rail leaves more room,
 * but the cards fit every case, so one number is enough.
 */
const TABLE_QUERY = '(min-width: 1500px)';

/** `/admin/users`: everyone who has signed in, their role, and the controls to change it. */
export function UsersPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.admin.users'));
  const users = useAdminUsers();
  const { data: me } = useMe();
  const roomForTable = useMediaQuery(TABLE_QUERY);
  const approvalInForce = usePublicConfig().data?.share_links === 'approved';
  const revokeUser = useRevokeUser();
  const leaveSession = useLeaveSession();
  const revoking = useRowDialog<AdminUser>();

  const items = users.data?.pages.flatMap((page) => page.items);
  const revokingSelf = revoking.item !== null && revoking.item.id === me?.id;
  const name = revoking.item?.name ?? '';

  return (
    <div className="flex flex-col gap-5">
      <div className="flex max-w-prose flex-col gap-2 text-pretty text-base text-fg-muted">
        <p>{t('web.admin.users.hint')}</p>
        {approvalInForce ? null : <p>{t('web.admin.approval.inactive')}</p>}
      </div>

      {items === undefined ? (
        users.isError ? (
          <ErrorState message={errorMessage(users.error, t)} onRetry={() => void users.refetch()} />
        ) : (
          <UsersSkeleton />
        )
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={t('web.admin.users.emptyTitle')}
          description={t('web.admin.users.emptyBody')}
        />
      ) : (
        <>
          {roomForTable ? (
            <UserTable users={items} meId={me?.id} onRevoke={revoking.show} />
          ) : (
            <UserCards users={items} meId={me?.id} onRevoke={revoking.show} />
          )}
          {users.isFetchNextPageError ? (
            <p role="alert" className="text-center text-danger text-sm">
              {errorMessage(users.error, t)}
            </p>
          ) : null}
          {users.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                loading={users.isFetchingNextPage}
                onClick={() => void users.fetchNextPage()}
              >
                {t('web.admin.users.loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={revoking.open}
        onOpenChange={revoking.onOpenChange}
        title={
          revokingSelf ? t('web.admin.revoke.selfTitle') : t('web.admin.revoke.title', { name })
        }
        body={
          <>
            <p>
              {revokingSelf ? t('web.admin.revoke.selfBody') : t('web.admin.revoke.body', { name })}
            </p>
            <p className="mt-2">{t('web.admin.revoke.shareLinks')}</p>
          </>
        }
        confirmLabel={t('web.admin.revoke.button')}
        tone="danger"
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          if (!revoking.item) return;
          const result = await revokeUser.mutateAsync(revoking.item.id);
          toast.success(
            t('web.admin.revoke.done', {
              sessions: t('web.admin.revoke.sessions', { count: result.sessions }),
              tokens: t('web.admin.revoke.tokens', { count: result.api_tokens }),
              agents: t('web.admin.revoke.agents', { count: result.oauth_grants }),
            }),
          );
          // Revoking yourself ended this session too: there is nobody left to show these pages to.
          if (revokingSelf) await leaveSession();
        }}
      />
    </div>
  );
}

function UsersSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.admin.users.loading')}>
      <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border bg-border">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 bg-surface px-4 py-4">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3.5 w-56 max-w-full" />
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

interface UserListProps {
  users: AdminUser[];
  meId: string | undefined;
  onRevoke(user: AdminUser): void;
}

// A heading cell and a data cell; the person is the row's header, so a screen
// reader says whose role and last seen it is reading.
const TH = 'whitespace-nowrap px-3 py-2.5 text-left font-medium text-fg-muted text-sm';
const TD = 'px-3 py-3.5 align-middle';

/** Where the content area is wide: one row per user. If it still overflows (large text), the table scrolls within its box. */
function UserTable({ users, meId, onRevoke }: UserListProps) {
  const { t } = useTranslation();
  return (
    // `relative` holds the screen-reader-only texts inside the box; left to the page they would widen it.
    <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[56rem] border-collapse text-base">
        <caption className="sr-only">{t('web.admin.users')}</caption>
        <thead className="border-border border-b bg-surface-muted/60">
          <tr>
            <th scope="col" className={TH}>
              {t('web.admin.col.user')}
            </th>
            <th scope="col" className={TH}>
              {t('web.admin.col.role')}
            </th>
            <th scope="col" className={TH}>
              {t('web.admin.col.override')}
            </th>
            <th scope="col" className={TH}>
              {t('web.admin.col.usage')}
            </th>
            <th scope="col" className={TH}>
              {t('web.admin.col.sharing')}
            </th>
            <th scope="col" className={TH}>
              {t('web.admin.col.lastSeen')}
            </th>
            <th scope="col" className={TH}>
              <span className="sr-only">{t('web.admin.col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {users.map((user) => {
            const isSelf = user.id === meId;
            return (
              <tr key={user.id}>
                <th scope="row" className={`${TD} min-w-52 text-left font-normal`}>
                  <PersonCell user={user} isSelf={isSelf} />
                </th>
                <td className={`${TD} min-w-36`}>
                  <RoleCell user={user} />
                </td>
                <td className={`${TD} w-52`}>
                  <RoleSelect user={user} isSelf={isSelf} />
                </td>
                <td className={`${TD} min-w-44`}>
                  <UsageCell user={user} />
                </td>
                <td className={`${TD} min-w-24`}>
                  <ApprovalSwitch user={user} />
                </td>
                <td className={`${TD} whitespace-nowrap text-fg`}>
                  <LastSeen at={user.last_seen_at} />
                </td>
                <td className={`${TD} whitespace-nowrap text-right`}>
                  <div className="flex items-center justify-end gap-1">
                    <RevokeButton user={user} onRevoke={onRevoke} />
                    <UserMenu user={user} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Everywhere narrower: one card per user, the same facts stacked. */
function UserCards({ users, meId, onRevoke }: UserListProps) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('web.admin.users')} className="flex flex-col gap-3">
      {users.map((user) => {
        const isSelf = user.id === meId;
        return (
          <li
            key={user.id}
            className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
          >
            <PersonCell user={user} isSelf={isSelf} />
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 text-sm">
              <CardFact label={t('web.admin.col.role')}>
                <RoleCell user={user} />
              </CardFact>
              <CardFact label={t('web.admin.col.lastSeen')}>
                <LastSeen at={user.last_seen_at} />
              </CardFact>
              <CardFact label={t('web.admin.col.usage')} wide>
                <UsageCell user={user} />
              </CardFact>
            </dl>
            <ApprovalSwitch user={user} hideLabel={false} />
            <RoleSelect user={user} isSelf={isSelf} showReason hideLabel={false} />
            <div className="flex items-center gap-2">
              <RevokeButton user={user} onRevoke={onRevoke} stacked />
              <UserMenu user={user} variant="secondary" size="md" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CardFact({
  label,
  wide = false,
  children,
}: {
  label: string;
  /** Spans both columns, for a fact with several lines. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col items-start gap-1', wide && 'col-span-2')}>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="text-fg">{children}</dd>
    </div>
  );
}

function RevokeButton({
  user,
  onRevoke,
  stacked = false,
}: {
  user: AdminUser;
  onRevoke(user: AdminUser): void;
  stacked?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant={stacked ? 'secondary' : 'ghost'}
      size={stacked ? 'md' : 'sm'}
      className={cn('text-danger', stacked && 'flex-1')}
      aria-label={t('web.admin.revoke.buttonFor', { name: user.name })}
      onClick={() => onRevoke(user)}
    >
      {t('web.admin.revoke.button')}
    </Button>
  );
}
