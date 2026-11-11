import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../api/client.ts';
import { useMarkdownDiff } from '../../api/diff.ts';
import type { ArtifactSummary } from '../../api/dto.ts';
import { cn, ErrorState, Select } from '../../ui/index.ts';
import { renderedDiffDocument } from './rendered-diff-doc.ts';
import { CenteredNote, TextFileDiffView } from './source-diff.tsx';

/**
 * A changed Markdown file as it reads, block by block, with added, removed and
 * changed blocks marked. Its HTML is the artifact's own, so it is shown only in
 * an `<iframe sandbox="" srcdoc>`, a document with no permissions, never in the
 * app's. A file too large to render shows its line changes instead.
 */
export function RenderedDiff({
  artifact,
  pair,
  paths,
  entry,
}: {
  artifact: ArtifactSummary;
  pair: { from: number; to: number };
  /** The changed Markdown files. */
  paths: string[];
  /** The `to` version's entry file, the first one shown when it changed. */
  entry: string | undefined;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | null>(null);
  const path =
    paths.find((p) => p === chosen) ?? paths.find((p) => p === entry) ?? paths[0] ?? null;
  const query = useMarkdownDiff(artifact.id, pair.from, pair.to, path);
  const blocks = query.data?.too_large === false ? query.data.blocks : null;
  const doc = useMemo(
    () =>
      blocks === null
        ? null
        : renderedDiffDocument(blocks, {
            added: t('web.compare.status.added'),
            removed: t('web.compare.status.removed'),
            changed: t('web.compare.status.modified'),
          }),
    [blocks, t],
  );

  if (path === null) return <CenteredNote>{t('web.compare.noMarkdown')}</CenteredNote>;

  const body = (() => {
    if (query.isError) {
      return (
        <div className="grid size-full place-items-center">
          <ErrorState
            title={t('web.compare.diffFailed')}
            message={errorMessage(query.error, t)}
            onRetry={() => void query.refetch()}
          />
        </div>
      );
    }
    if (query.data === undefined) {
      return (
        <div
          role="progressbar"
          aria-label={t('web.compare.diffLoading')}
          className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-accent-soft"
        >
          <div className="h-full w-2/5 animate-indeterminate bg-accent motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
        </div>
      );
    }
    if (doc === null) {
      return (
        <div className="size-full overflow-auto">
          <p
            role="note"
            className="border-border border-b bg-surface-muted px-4 py-2 text-fg-muted text-sm"
          >
            {t('web.compare.renderTooLarge')}
          </p>
          <TextFileDiffView artifactId={artifact.id} pair={pair} path={path} />
        </div>
      );
    }
    return (
      <iframe
        sandbox=""
        srcDoc={doc}
        title={t('web.compare.renderedTitle', { path })}
        className="block size-full border-0 bg-canvas"
      />
    );
  })();

  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-border border-b px-3 py-2">
        <div className="min-w-0 max-w-full">
          <Select
            inline
            label={t('web.compare.file')}
            value={path}
            onValueChange={setChosen}
            options={paths.map((p) => ({ value: p, label: p }))}
          />
        </div>
        <Legend />
      </div>
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}

/** What the marks in the rendered diff mean, in words as well as color. */
function Legend() {
  const { t } = useTranslation();
  const items = [
    {
      mark: '+',
      label: t('web.compare.status.added'),
      tone: 'border-success/40 bg-success-soft text-success',
    },
    {
      mark: '−',
      label: t('web.compare.status.removed'),
      tone: 'border-danger/40 bg-danger-soft text-danger',
    },
    {
      mark: '±',
      label: t('web.compare.status.modified'),
      tone: 'border-border bg-surface-muted text-fg-muted',
    },
  ];
  return (
    <ul
      aria-label={t('web.compare.legend')}
      className="flex items-center gap-4 text-fg-muted text-sm"
    >
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              'grid size-5 place-items-center rounded-sm border font-mono font-semibold text-xs',
              item.tone,
            )}
          >
            {item.mark}
          </span>
          {item.label}
        </li>
      ))}
    </ul>
  );
}
