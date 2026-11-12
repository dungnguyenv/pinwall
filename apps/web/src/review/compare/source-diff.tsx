import type { UseQueryResult } from '@tanstack/react-query';
import { FileDiff, FileMinus, FilePlus, FileX } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ApiError, errorMessage } from '../../api/client.ts';
import { useTextFileDiff } from '../../api/diff.ts';
import type { FileChange, VersionDiff } from '../../api/dto.ts';
import { formatBytes } from '../../lib/format.ts';
import { cn, ErrorState, LoadingRegion, Select, Skeleton } from '../../ui/index.ts';
import { DiffLines } from './diff-lines.tsx';
import { parseUnifiedDiff } from './unified-diff.ts';

const STATUS_ICON: Record<FileChange['status'], ReactNode> = {
  added: <FilePlus />,
  removed: <FileMinus />,
  modified: <FileDiff />,
};

const STATUS_TONE: Record<FileChange['status'], string> = {
  added: 'text-success',
  removed: 'text-danger',
  modified: 'text-fg-muted',
};

/**
 * The files that changed between the two versions and, for the one chosen,
 * its line changes. Wide screens list the files beside the lines; phones
 * choose the file from a select. The first file is chosen to begin with.
 */
export function SourceDiff({
  artifactId,
  pair,
  diff,
  phone,
}: {
  artifactId: string;
  pair: { from: number; to: number };
  diff: UseQueryResult<VersionDiff, ApiError>;
  phone: boolean;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | null>(null);

  if (diff.isError) return <DiffListError diff={diff} />;
  if (diff.data === undefined) return <DiffSkeleton />;
  const files = diff.data.files;
  if (files.length === 0) return <CenteredNote>{t('web.compare.noChanges')}</CenteredNote>;
  const file = files.find((f) => f.path === chosen) ?? files[0];
  if (file === undefined) return null;
  const status = (f: FileChange) => t(`web.compare.status.${f.status}`);

  return (
    <div className="flex size-full min-h-0 max-md:flex-col">
      {phone ? (
        <div className="shrink-0 border-border border-b px-3 py-2">
          <Select
            label={t('web.compare.file')}
            hideLabel
            value={file.path}
            onValueChange={setChosen}
            options={files.map((f) => ({
              value: f.path,
              label: t('web.compare.fileOption', { path: f.path, status: status(f) }),
            }))}
          />
        </div>
      ) : (
        <div className="flex w-72 shrink-0 flex-col border-border border-r lg:w-80">
          <p className="shrink-0 px-4 pt-3 pb-2 text-fg-muted text-sm">
            {t('web.compare.fileCount', { count: files.length })}
          </p>
          <ul
            aria-label={t('web.compare.files')}
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          >
            {files.map((f) => {
              const current = f.path === file.path;
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    aria-current={current ? 'true' : undefined}
                    onClick={() => setChosen(f.path)}
                    title={f.path}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-(--duration-fast) hover:bg-surface-muted [&_svg]:size-4 [&_svg]:shrink-0',
                      current ? 'bg-selected text-fg' : 'text-fg-muted hover:text-fg',
                    )}
                  >
                    <span aria-hidden="true" className={STATUS_TONE[f.status]}>
                      {STATUS_ICON[f.status]}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                    <span className={cn('shrink-0 text-xs', STATUS_TONE[f.status])}>
                      {status(f)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <section aria-label={file.path} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {phone ? null : (
          <div className="flex h-10 shrink-0 items-center gap-3 border-border border-b px-4">
            <h2
              className="min-w-0 flex-1 truncate font-medium font-mono text-fg text-sm"
              title={file.path}
            >
              {file.path}
            </h2>
            <span className={cn('shrink-0 text-xs', STATUS_TONE[file.status])}>{status(file)}</span>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <TextFileDiffView artifactId={artifactId} pair={pair} path={file.path} />
        </div>
      </section>
    </div>
  );
}

/** The list of changed files could not be read: why, and Retry. */
export function DiffListError({ diff }: { diff: UseQueryResult<VersionDiff, ApiError> }) {
  const { t } = useTranslation();
  if (diff.error === null) return null;
  return (
    <div className="grid size-full place-items-center">
      <ErrorState
        title={t('web.compare.diffFailed')}
        message={errorMessage(diff.error, t)}
        onRetry={() => void diff.refetch()}
      />
    </div>
  );
}

/** The line changes of one file, or why there are none to show. */
export function TextFileDiffView({
  artifactId,
  pair,
  path,
}: {
  artifactId: string;
  pair: { from: number; to: number };
  path: string;
}) {
  const { t } = useTranslation();
  const query = useTextFileDiff(artifactId, pair.from, pair.to, path);
  const patch = query.data?.patch ?? null;
  const hunks = useMemo(() => (patch === null ? [] : parseUnifiedDiff(patch)), [patch]);

  if (query.isError) {
    return (
      <ErrorState
        title={t('web.compare.diffFailed')}
        message={errorMessage(query.error, t)}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const data = query.data;
  if (data === undefined) return <DiffSkeleton />;
  if (data.binary) {
    const sizes = [data.old, data.new]
      .filter((side) => side !== null)
      .map((s) => formatBytes(s.size));
    return (
      <CenteredNote
        icon={<FileX />}
        detail={
          sizes.length === 2 ? t('web.compare.sizes', { old: sizes[0], new: sizes[1] }) : sizes[0]
        }
      >
        {t('web.compare.binary')}
      </CenteredNote>
    );
  }
  if (data.too_large || patch === null) {
    return <CenteredNote>{t('web.compare.tooLarge')}</CenteredNote>;
  }
  if (hunks.length === 0) return <CenteredNote>{t('web.compare.noLineChanges')}</CenteredNote>;
  return <DiffLines hunks={hunks} />;
}

/** A short note in the middle of an empty pane. */
export function CenteredNote({
  icon,
  detail,
  children,
}: {
  icon?: ReactNode;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid size-full min-h-40 place-items-center p-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        {icon ? (
          <div aria-hidden="true" className="mb-3 text-fg-subtle [&_svg]:size-6">
            {icon}
          </div>
        ) : null}
        <p className="text-base text-fg-muted">{children}</p>
        {detail ? <p className="mt-1 font-mono text-fg-muted text-xs">{detail}</p> : null}
      </div>
    </div>
  );
}

/** Grey lines where the changes will be. */
function DiffSkeleton() {
  const { t } = useTranslation();
  return (
    <LoadingRegion label={t('web.compare.diffLoading')}>
      <div className="flex flex-col gap-2 p-4">
        {['w-2/3', 'w-1/2', 'w-3/4', 'w-1/3', 'w-3/5'].map((width) => (
          <Skeleton key={width} className={cn('h-3.5', width)} />
        ))}
      </div>
    </LoadingRegion>
  );
}
