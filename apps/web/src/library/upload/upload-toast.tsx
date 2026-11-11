import { CircleAlert, CircleCheck, TriangleAlert, Upload, X } from 'lucide-react';
import { type MouseEvent, type ReactNode, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { PublishWarning } from '../../api/dto.ts';
import { formatBytes } from '../../lib/format.ts';
import type { UploadProgress } from '../../lib/upload/send.ts';
import { Button, cn, IconButton, Spinner, toast } from '../../ui/index.ts';

/** Where one upload is, from the first byte sent to the version it made or why it failed. */
export type UploadState =
  | UploadProgress
  | { phase: 'published'; name: string; number: number; href: string; warnings: PublishWarning[] }
  | { phase: 'failed'; message: string };

/** The state of one upload, which its toast follows as it changes. */
export interface UploadStore {
  get(): UploadState;
  set(next: UploadState): void;
  subscribe(listener: () => void): () => void;
}

export function createUploadStore(initial: UploadState): UploadStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * How long a toast stays: busy and failed ones until the person closes them,
 * a plain success long enough to reach its Open link.
 */
export const TOAST_STAYS = { duration: Number.POSITIVE_INFINITY } as const;
export const TOAST_PUBLISHED = { duration: 8_000 } as const;

function ProgressBar({ label, percent }: { label: string; percent: number | null }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="relative mt-2 h-1 w-full overflow-hidden rounded-full bg-selected"
    >
      {percent === null ? (
        // Waiting on the server: a short bar sweeps across, or sits still and faint without motion.
        <div className="absolute inset-y-0 left-0 w-2/5 animate-indeterminate rounded-full bg-accent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
      ) : (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-(--duration-base) ease-out"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}

function StatusIcon({ phase }: { phase: UploadState['phase'] }) {
  const icon = {
    uploading: <Upload className="text-accent-text" />,
    processing: <Spinner className="text-fg-muted" />,
    published: <CircleCheck className="text-success" />,
    failed: <CircleAlert className="text-danger" />,
  }[phase];
  return (
    <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0 [&_svg]:size-4">
      {icon}
    </span>
  );
}

function Warnings({ warnings }: { warnings: PublishWarning[] }) {
  const { t } = useTranslation();
  const [first] = warnings;
  if (!first) return null;
  return (
    <div className="mt-1.5 flex gap-2 rounded-md bg-warning-soft px-2.5 py-2 text-sm text-fg">
      <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <p>{first.message}</p>
        {warnings.length > 1 ? (
          <p className="mt-0.5 text-fg-muted">
            {t('web.upload.moreWarnings', { count: warnings.length - 1 })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A link opened in the app with a plain click, and normally with a modifier or middle click. */
function OpenLink({ href, onOpen }: { href: string; onOpen(href: string): void }) {
  const { t } = useTranslation();
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    onOpen(href);
  };
  return (
    <a
      href={href}
      onClick={open}
      className="inline-flex h-7 shrink-0 items-center rounded-full bg-primary px-3 font-medium text-primary-fg text-sm transition-colors hover:bg-primary/85"
    >
      {t('web.upload.open')}
    </a>
  );
}

/**
 * The toast of one upload. It shows what is going up and how far it is, then
 * the server at work, then either the version it published, with a link to
 * review it and the first warning, or the server's message word for word.
 */
export function UploadToast({
  label,
  store,
  onCancel,
  onOpen,
  onClose,
}: {
  /** What is being uploaded: the folder, the archive, or the first file and how many more. */
  label: string;
  store: UploadStore;
  onCancel(): void;
  onOpen(href: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);

  let title: string;
  let body: ReactNode = null;
  let actions: ReactNode = null;
  const close = (
    <IconButton
      label={t('web.common.close')}
      icon={<X />}
      size="sm"
      tooltip={false}
      onClick={onClose}
      className="-my-1 -mr-2 size-7 text-fg-muted hover:text-fg"
    />
  );

  switch (state.phase) {
    case 'uploading': {
      const percent =
        state.total > 0 ? Math.min(100, Math.round((state.loaded / state.total) * 100)) : 0;
      title = label;
      body = (
        <>
          <p className="text-fg-muted text-sm tabular-nums">
            {t('web.upload.uploading', {
              loaded: formatBytes(state.loaded),
              total: formatBytes(state.total),
            })}
          </p>
          <ProgressBar label={t('web.upload.progressLabel', { name: label })} percent={percent} />
        </>
      );
      actions = (
        <Button variant="ghost" size="sm" onClick={onCancel} className="-my-1 -mr-2 h-7 px-2.5">
          {t('web.common.cancel')}
        </Button>
      );
      break;
    }
    case 'processing':
      title = label;
      body = (
        <>
          <p className="text-fg-muted text-sm">{t('web.upload.processing')}</p>
          <ProgressBar label={t('web.upload.progressLabel', { name: label })} percent={null} />
        </>
      );
      break;
    case 'published':
      title = t('web.upload.published', { name: state.name, number: state.number });
      body = <Warnings warnings={state.warnings} />;
      actions = (
        <>
          <OpenLink href={state.href} onOpen={onOpen} />
          {close}
        </>
      );
      break;
    case 'failed':
      title = label ? t('web.upload.failed', { name: label }) : t('web.upload.nothingPublished');
      body = (
        <p role="alert" className="text-fg text-sm [overflow-wrap:anywhere]">
          {state.message}
        </p>
      );
      actions = close;
      break;
  }

  return (
    <div className="flex w-full items-start gap-3 font-normal">
      <StatusIcon phase={state.phase} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The actions sit beside the title, so the progress bar and messages get the full width. */}
        <div className="flex items-start gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 font-medium text-fg',
              state.phase === 'uploading' || state.phase === 'processing'
                ? 'truncate'
                : '[overflow-wrap:anywhere]',
            )}
          >
            {title}
          </p>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
        {body}
      </div>
    </div>
  );
}

let toastCount = 0;

/** A fresh toast id for one upload. */
export function nextUploadToastId(): string {
  toastCount += 1;
  return `upload-${toastCount}`;
}

/** A failed-upload toast for a selection that was never sent, or could not be read. */
export function toastUploadFailure(label: string, message: string): void {
  const id = nextUploadToastId();
  const store = createUploadStore({ phase: 'failed', message });
  toast.custom(
    () => (
      <UploadToast
        label={label}
        store={store}
        onCancel={() => {}}
        onOpen={() => {}}
        onClose={() => toast.dismiss(id)}
      />
    ),
    { id, ...TOAST_STAYS },
  );
}
