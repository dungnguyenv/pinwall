import { Bot, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useRevokeToken, useTokens } from '../../api/account.ts';
import { errorMessage } from '../../api/client.ts';
import type { ApiToken } from '../../api/dto.ts';
import { formatDate, formatRelativeTime } from '../../lib/format.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingRegion,
  Skeleton,
  toast,
} from '../../ui/index.ts';
import { CreateTokenDialog } from './create-token-dialog.tsx';
import { CardBody, CardRows, Facts, SettingsCard } from './settings-card.tsx';
import { useRowDialog } from './use-row-dialog.ts';

/** `/settings/tokens`: the personal API tokens agents and scripts publish with. */
export function TokensPage() {
  const { t } = useTranslation();
  usePageTitle(t('web.settings.tokens'));
  const tokens = useTokens();
  const revokeToken = useRevokeToken();
  const [creating, setCreating] = useState(false);
  const revoking = useRowDialog<ApiToken>();

  return (
    <SettingsCard
      title={t('web.tokens.title')}
      description={t('web.tokens.hint')}
      actions={
        <Button leadingIcon={<Plus />} onClick={() => setCreating(true)}>
          {t('web.tokens.create')}
        </Button>
      }
    >
      {tokens.isPending ? (
        <div className="border-border border-t">
          <LoadingRegion label={t('web.tokens.loading')}>
            <div className="flex flex-col gap-5 px-4 py-5 sm:px-5">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          </LoadingRegion>
        </div>
      ) : tokens.isError ? (
        <CardBody>
          <ErrorState
            compact
            message={errorMessage(tokens.error, t)}
            onRetry={() => void tokens.refetch()}
          />
        </CardBody>
      ) : tokens.data.items.length === 0 ? (
        <div className="border-border border-t">
          <EmptyState
            icon={<Bot />}
            title={t('web.tokens.emptyTitle')}
            description={t('web.tokens.emptyBody')}
            action={
              <Button asChild variant="secondary">
                <Link to="/connect">{t('web.account.connect')}</Link>
              </Button>
            }
          />
        </div>
      ) : (
        <CardRows label={t('web.tokens.listLabel')}>
          {tokens.data.items.map((token) => (
            <TokenRow key={token.id} token={token} onRevoke={() => revoking.show(token)} />
          ))}
        </CardRows>
      )}

      <CreateTokenDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={revoking.open}
        onOpenChange={revoking.onOpenChange}
        title={t('web.tokens.revokeTitle')}
        body={t('web.tokens.revokeBody', { name: revoking.item?.name ?? '' })}
        confirmLabel={t('web.tokens.revokeConfirm')}
        tone="danger"
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async () => {
          if (!revoking.item) return;
          await revokeToken.mutateAsync(revoking.item.id);
          toast.success(t('web.tokens.revoked'));
        }}
      />
    </SettingsCard>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiToken; onRevoke(): void }) {
  const { t } = useTranslation();
  const expired = token.expires_at !== null && token.expires_at <= Date.now();
  return (
    <li className="flex items-start gap-3 px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <p className="break-words font-medium text-base text-fg">{token.name}</p>
          {expired ? <Badge tone="danger">{t('web.tokens.expired')}</Badge> : null}
        </div>
        <p className="mt-0.5 text-sm">
          <code className="font-mono text-fg-muted">{token.prefix}</code>
          <span aria-hidden="true" className="text-fg-subtle">
            …
          </span>
        </p>
        <div className="mt-2">
          <Facts
            items={[
              { label: t('web.tokens.created'), value: formatDate(token.created_at) },
              {
                label: t('web.tokens.lastUsed'),
                value: token.last_used_at
                  ? formatRelativeTime(token.last_used_at)
                  : t('web.tokens.neverUsed'),
              },
              {
                label: t('web.tokens.expires'),
                value: token.expires_at
                  ? formatDate(token.expires_at)
                  : t('web.tokens.neverExpires'),
              },
            ]}
          />
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-danger"
        aria-label={t('web.tokens.revokeNamed', { name: token.name })}
        onClick={onRevoke}
      >
        {t('web.tokens.revoke')}
      </Button>
    </li>
  );
}
