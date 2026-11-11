import { diffWordsWithSpace } from 'diff';

/** One line of a hunk, with its number in the old file, the new file, or both. */
export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` line, as the patch has it. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of a unified diff, as the server's `createTwoFilesPatch` writes
 * them. The file headers before the first hunk (`Index:`, `===`, `---`,
 * `+++`) are skipped; inside a hunk the counts in its header decide which
 * lines belong to it, so a removed `-- note` line (`--- note` in the patch) is
 * still a line. `\ No newline at end of file` markers are dropped, and a line
 * ending in `\r` (a CRLF file) loses it.
 */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('\\')) continue;
    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      const mark = line[0];
      const text = line.slice(1);
      if (mark === '-' && oldLeft > 0) {
        hunk.lines.push({ kind: 'del', text, oldNo, newNo: null });
        oldNo += 1;
        oldLeft -= 1;
        continue;
      }
      if (mark === '+' && newLeft > 0) {
        hunk.lines.push({ kind: 'add', text, oldNo: null, newNo });
        newNo += 1;
        newLeft -= 1;
        continue;
      }
      if ((mark === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        hunk.lines.push({ kind: 'context', text, oldNo, newNo });
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue;
    const [, oldStart = '0', oldCount = '1', newStart = '0', newCount = '1'] = header;
    hunk = {
      header: line,
      oldStart: Number(oldStart),
      newStart: Number(newStart),
      lines: [],
    };
    hunks.push(hunk);
    oldNo = hunk.oldStart;
    newNo = hunk.newStart;
    oldLeft = Number(oldCount);
    newLeft = Number(newCount);
  }
  return hunks;
}

/**
 * Which removed line each added line replaces: within each run of removed
 * lines followed by added ones, the i-th removed ↔ the i-th added, by index
 * into `lines`. Lines left over on either side stay unpaired.
 */
export function pairChanges(lines: DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind !== 'del') {
      i += 1;
      continue;
    }
    const dels: number[] = [];
    while (lines[i]?.kind === 'del') dels.push(i++);
    const adds: number[] = [];
    while (lines[i]?.kind === 'add') adds.push(i++);
    dels.forEach((del, k) => {
      const add = adds[k];
      if (add !== undefined) pairs.set(del, add);
    });
  }
  return pairs;
}

/** A piece of a changed line; `changed` when the other side does not have it. */
export interface Segment {
  text: string;
  changed: boolean;
}

/** Lines longer than this are not compared word by word: the whole line is marked. */
const WORD_DIFF_MAX = 500;

/**
 * The words that differ between a removed line and the added line that
 * replaces it, each side as segments in order. Spaces count as words, so the
 * segments join back into the exact lines.
 */
export function wordSegments(del: string, add: string): { del: Segment[]; add: Segment[] } {
  if (del.length > WORD_DIFF_MAX || add.length > WORD_DIFF_MAX) {
    return { del: [{ text: del, changed: true }], add: [{ text: add, changed: true }] };
  }
  const out: { del: Segment[]; add: Segment[] } = { del: [], add: [] };
  const push = (side: Segment[], text: string, changed: boolean) => {
    const last = side[side.length - 1];
    if (last !== undefined && last.changed === changed) last.text += text;
    else side.push({ text, changed });
  };
  for (const part of diffWordsWithSpace(del, add)) {
    if (!part.added) push(out.del, part.value, part.removed);
    if (!part.removed) push(out.add, part.value, part.added);
  }
  return out;
}
