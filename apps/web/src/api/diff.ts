import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type ApiError, api } from './client.ts';
import { MarkdownDiff, TextFileDiff, VersionDiff } from './dto.ts';
import { qk } from './keys.ts';

/*
 * Version numbers are never reused and a version's files never change, so the
 * diff between two numbers is the same whenever it is read: these queries do
 * not go stale. Each stays idle until every argument is chosen.
 */

/** The files that changed from version `from` to version `to`. */
export function useVersionDiff(
  id: string,
  from: number | null,
  to: number | null,
): UseQueryResult<VersionDiff, ApiError> {
  return useQuery<VersionDiff, ApiError>({
    queryKey: qk.diff(id, from, to),
    queryFn: () =>
      api(`/artifacts/${encodeURIComponent(id)}/diff`, {
        query: { from, to },
        schema: VersionDiff,
      }),
    enabled: from !== null && to !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The unified diff of one text file. */
export function useTextFileDiff(
  id: string,
  from: number | null,
  to: number | null,
  path: string | null,
): UseQueryResult<TextFileDiff, ApiError> {
  return useQuery<TextFileDiff, ApiError>({
    queryKey: qk.fileDiff(id, from, to, path),
    queryFn: () =>
      api(`/artifacts/${encodeURIComponent(id)}/diff/file`, {
        query: { from, to, path },
        schema: TextFileDiff,
      }),
    enabled: from !== null && to !== null && path !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The block diff of one Markdown file. Its HTML is untrusted: show it only in a sandboxed frame. */
export function useMarkdownDiff(
  id: string,
  from: number | null,
  to: number | null,
  path: string | null,
): UseQueryResult<MarkdownDiff, ApiError> {
  return useQuery<MarkdownDiff, ApiError>({
    queryKey: qk.mdDiff(id, from, to, path),
    queryFn: () =>
      api(`/artifacts/${encodeURIComponent(id)}/diff/markdown`, {
        query: { from, to, path },
        schema: MarkdownDiff,
      }),
    enabled: from !== null && to !== null && path !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
