import type { VersionSummary } from '../../api/dto.ts';

/** What the compare screen shows: the two pages side by side, overlaid, the files, or rendered Markdown. */
export type CompareView = 'side' | 'overlay' | 'files' | 'rendered';

export const COMPARE_VIEWS: readonly CompareView[] = ['side', 'overlay', 'files', 'rendered'];

/**
 * The two versions to compare, from the numbers in the address when they
 * name versions that exist. `to` is the given number, else the current
 * version (else the newest). `from` is the given number when it differs from
 * `to`, else the highest number below `to`, else the lowest above it. Fewer
 * than two versions have no pair.
 */
export function defaultPair(
  versions: VersionSummary[],
  from?: number,
  to?: number,
): { from: number; to: number } | null {
  if (versions.length < 2) return null;
  const numbers = versions.map((v) => v.number).sort((a, b) => a - b);
  const exists = (n: number | undefined): n is number => n !== undefined && numbers.includes(n);
  const current = versions.find((v) => v.is_current)?.number ?? numbers[numbers.length - 1];
  const right = exists(to) ? to : current;
  if (right === undefined) return null;
  if (exists(from) && from !== right) return { from, to: right };
  const below = numbers.filter((n) => n < right).pop();
  const above = numbers.find((n) => n > right);
  const left = below ?? above;
  return left === undefined ? null : { from: left, to: right };
}

/** Whether a changed file is one the rendered Markdown diff can show. */
export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}
