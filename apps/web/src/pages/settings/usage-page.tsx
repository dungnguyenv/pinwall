import { useQuery } from '@tanstack/react-query';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';
import { usePurgeMyContent } from '../../api/account.ts';
import { type ApiError, errorMessage } from '../../api/client.ts';
import type { Me } from '../../api/dto.ts';
import { qk } from '../../api/keys.ts';
import { getMe } from '../../api/session.ts';
import { useVisibility } from '../../api/spaces.ts';
import { formatBytes } from '../../lib/format.ts';
import { usePageTitle } from '../../lib/page-title.ts';
import { Button, cn, TypedConfirmDialog, toast } from '../../ui/index.ts';
import { CardBody, SettingsCard } from './settings-card.tsx';

type Tone = 'normal' | 'warning' | 'danger';

/** Where a meter stands: warned from 90 percent of its limit, full at or over it. No limit never warns. */
function toneOf(used: number, limit: number | null): Tone {
  if (limit === null) return 'normal';
  if (used >= limit) return 'danger';
  return used * 10 >= limit * 9 ? 'warning' : 'normal';
}

const FILL: Record<Tone, string> = {
  normal: 'bg-accent',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

const FIGURE: Record<Tone, string> = {
  normal: 'text-fg-muted',
  warning: 'text-warning',
  danger: 'text-danger',
};

/**
 * One measure against its limit: a name, the figures in words, and a bar. The
 * bar is the `meter`, and its value text is the sentence beside it. A limit of
 * `null` leaves the bar empty and dashed: there is nothing to fill it against,
 * so it is no meter either, only a picture, and the figures speak alone.
 */
function Meter({
  label,
  used,
  limit,
  text,
  tone,
}: {
  label: string;
  used: number;
  limit: number | null;
  text: string;
  tone: Tone;
}) {
  const share = limit === null || limit <= 0 ? 0 : Math.min(100, (used / limit) * 100);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <span className="font-medium text-base text-fg">{label}</span>
        <span className={cn('flex items-center gap-1.5 text-sm tabular-nums', FIGURE[tone])}>
          {tone === 'warning' ? <TriangleAlert aria-hidden="true" className="size-3.5" /> : null}
          {tone === 'danger' ? <CircleAlert aria-hidden="true" className="size-3.5" /> : null}
          {text}
        </span>
      </div>
      {limit === null ? (
        <div
          aria-hidden="true"
          className="mt-2 h-2 rounded-full border border-border-strong border-dashed"
        />
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: a <meter> cannot take the tones and the rounded end
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          // Over the limit the bar is simply full; the value text says by how much.
          aria-valuenow={Math.min(used, limit)}
          aria-valuemax={limit}
          aria-valuetext={text}
          data-tone={tone}
          className="mt-2 h-2 overflow-hidden rounded-full bg-selected"
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-(--duration-base) ease-out motion-reduce:transition-none',
              FILL[tone],
            )}
            style={{ width: `${share}%` }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * `/settings/usage`: what the person's space holds against what it may hold.
 * It reads `me` again on opening, since publishing and deleting change it all
 * the time. The server sends `usage` only in personal mode or under a quota;
 * without it there is nothing to show and the profile opens instead.
 */
export function UsagePage() {
  const { t } = useTranslation();
  usePageTitle(t('web.settings.usage'));
  const visibility = useVisibility();
  const { data: me } = useQuery<Me | null, ApiError>({
    queryKey: qk.me,
    queryFn: getMe,
    refetchOnMount: 'always',
  });
  // A ended session is the shell's to handle; it sends the person to sign in.
  if (!me) return null;
  if (!me.usage) return <Navigate to="/settings/profile" replace />;

  const { usage } = me;
  const limits = me.limits ?? { bytes: null, artifacts: null };
  const bytesTone = toneOf(usage.bytes, limits.bytes);
  const artifactsTone = toneOf(usage.artifacts, limits.artifacts);
  // Files are shown only under a files limit: without one they are no concern of the person's.
  const files =
    typeof limits.files === 'number'
      ? {
          used: usage.files ?? 0,
          limit: limits.files,
          tone: toneOf(usage.files ?? 0, limits.files),
        }
      : null;
  const full = [bytesTone, artifactsTone, files?.tone].includes('danger');

  return (
    <>
      <SettingsCard title={t('web.settings.usage')} description={t('web.usage.counting')}>
        <CardBody className="flex flex-col gap-6">
          <Meter
            label={t('web.usage.storage')}
            used={usage.bytes}
            limit={limits.bytes}
            text={
              limits.bytes === null
                ? t('web.usage.usedNoLimit', { used: formatBytes(usage.bytes) })
                : t('web.usage.ofLimit', {
                    used: formatBytes(usage.bytes),
                    limit: formatBytes(limits.bytes),
                  })
            }
            tone={bytesTone}
          />
          <Meter
            label={t('web.usage.artifacts')}
            used={usage.artifacts}
            limit={limits.artifacts}
            text={
              limits.artifacts === null
                ? t('web.usage.artifactsNoLimit', { count: usage.artifacts })
                : t('web.usage.artifactsOf', { count: usage.artifacts, limit: limits.artifacts })
            }
            tone={artifactsTone}
          />
          {files ? (
            <Meter
              label={t('web.usage.files')}
              used={files.used}
              limit={files.limit}
              text={t('web.usage.filesOf', { count: files.used, limit: files.limit })}
              tone={files.tone}
            />
          ) : null}
          {full ? (
            <p className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-danger text-sm">
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{t('web.usage.full')}</span>
            </p>
          ) : null}
        </CardBody>
      </SettingsCard>
      {visibility === 'personal' ? <DeleteContentCard me={me} /> : null}
    </>
  );
}

/**
 * Deletes everything the person owns, after they type their email address
 * (their id when they have none). Personal mode only: it is their own space.
 */
function DeleteContentCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const purge = usePurgeMyContent();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  // The server takes the id when the email is absent or empty.
  const expected = me.email || me.id;
  const title = t('web.purge.self.title');

  return (
    <section aria-labelledby={titleId} className="rounded-lg border border-danger/40 bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 py-5 sm:px-5">
        <div className="min-w-0 flex-1 basis-64">
          <h2 id={titleId} className="font-semibold text-danger text-md">
            {title}
          </h2>
          <p className="mt-1 text-pretty text-base text-fg-muted">{t('web.purge.self.body')}</p>
        </div>
        <Button
          variant="secondary"
          className="shrink-0 border-danger/50 text-danger hover:bg-danger-soft"
          onClick={() => setOpen(true)}
        >
          {title}
        </Button>
      </div>
      <TypedConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        body={t('web.purge.self.body')}
        confirmLabel={t('web.purge.button')}
        expected={expected}
        fieldLabel={t('web.purge.type', { value: expected })}
        errorMessage={(error) => errorMessage(error, t)}
        onConfirm={async (typed) => {
          const result = await purge.mutateAsync(typed);
          // Everything this person owned is gone: leave before any page asks for it again.
          void navigate('/');
          toast.success(
            t('web.purge.done', {
              projects: t('web.purge.projects', { count: result.projects }),
              artifacts: t('web.purge.artifacts', { count: result.artifacts }),
            }),
          );
        }}
      />
    </section>
  );
}
