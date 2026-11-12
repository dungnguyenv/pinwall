import { type CSSProperties, useMemo } from 'react';
import { cn } from '../../ui/index.ts';
import {
  type DiffHunk,
  type DiffLine,
  pairChanges,
  type Segment,
  wordSegments,
} from './unified-diff.ts';

const MARK: Record<DiffLine['kind'], string> = { add: '+', del: '−', context: '' };

const LINE_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-success-soft',
  del: 'bg-danger-soft',
  context: '',
};

const MARK_TONE: Record<DiffLine['kind'], string> = {
  add: 'text-success',
  del: 'text-danger',
  context: '',
};

/** The changed words of a paired line, a shade deeper than the line's own tint. */
const WORD_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-success/25',
  del: 'bg-danger/25',
  context: '',
};

/**
 * A file's hunks as lines: the old and new line numbers, a `+` or `−` mark
 * and a tint for added and removed lines, and, where a removed line pairs with
 * the added line that replaced it, the words that changed. Each hunk's header
 * stays at the top while its lines scroll by. Every line is React text.
 */
export function DiffLines({ hunks }: { hunks: DiffHunk[] }) {
  const digits = useMemo(() => {
    let most = 1;
    for (const hunk of hunks) {
      for (const line of hunk.lines) most = Math.max(most, line.oldNo ?? 0, line.newNo ?? 0);
    }
    return String(most).length;
  }, [hunks]);
  return (
    <div
      className="min-w-0 pb-6 font-mono text-xs leading-5 [tab-size:4]"
      style={{ '--gutter': `${digits}ch` } as CSSProperties}
    >
      {hunks.map((hunk, i) => (
        // A hunk's place in the file is all that tells it apart.
        // biome-ignore lint/suspicious/noArrayIndexKey: hunks never move within a patch
        <Hunk key={i} hunk={hunk} />
      ))}
    </div>
  );
}

function Hunk({ hunk }: { hunk: DiffHunk }) {
  const segments = useMemo(() => {
    const out = new Map<number, Segment[]>();
    for (const [del, add] of pairChanges(hunk.lines)) {
      const a = hunk.lines[del];
      const b = hunk.lines[add];
      if (a === undefined || b === undefined) continue;
      const words = wordSegments(a.text, b.text);
      out.set(del, words.del);
      out.set(add, words.add);
    }
    return out;
  }, [hunk]);
  return (
    <section>
      <div className="sticky top-0 z-10 truncate border-border border-y bg-surface-muted px-3 py-0.5 text-fg-muted">
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines never move within a hunk
        <Line key={i} line={line} segments={segments.get(i)} />
      ))}
    </section>
  );
}

const NUMBER =
  'w-[calc(var(--gutter)+1.25rem)] select-none px-2 text-right text-fg-muted tabular-nums';

function Line({ line, segments }: { line: DiffLine; segments: Segment[] | undefined }) {
  return (
    <div data-kind={line.kind} className={cn('flex', LINE_TONE[line.kind])}>
      <span className={cn(NUMBER, 'shrink-0')}>{line.oldNo ?? ''}</span>
      <span className={cn(NUMBER, 'shrink-0')}>{line.newNo ?? ''}</span>
      <span
        className={cn('w-5 shrink-0 select-none text-center font-semibold', MARK_TONE[line.kind])}
      >
        {MARK[line.kind]}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap pr-4 text-fg [overflow-wrap:anywhere]">
        {segments === undefined
          ? line.text
          : segments.map((s, i) =>
              s.changed ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: segments are fixed for a line
                <mark key={i} className={cn('rounded-[3px] text-fg', WORD_TONE[line.kind])}>
                  {s.text}
                </mark>
              ) : (
                s.text
              ),
            )}
      </span>
    </div>
  );
}
