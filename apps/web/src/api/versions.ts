import {
  type InfiniteData,
  skipToken,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { type ApiError, api } from './client.ts';
import { ContentGrant, VersionList, VersionSummary } from './dto.ts';
import { qk } from './keys.ts';

/** Versions per page of the version list. */
const VERSION_PAGE_SIZE = 50;
/** A review grant is renewed this long before it expires. */
const RENEW_BEFORE_EXPIRY_MS = 300_000;
/** The shortest wait between two renewals, so a grant about to expire is not asked for in a loop. */
const MIN_RENEW_INTERVAL_MS = 60_000;

/** The review page of an artifact: its newest version, or version `n` when given. */
export function reviewPath(artifactId: string, n?: number | null): string {
  const base = `/a/${encodeURIComponent(artifactId)}`;
  return n === undefined || n === null ? base : `${base}/v/${n}`;
}

/** The raw files of an artifact's newest version, or of version `n` when given. */
export function rawPath(artifactId: string, n?: number | null): string {
  return `${reviewPath(artifactId, n)}/raw`;
}

function listVersions(artifactId: string, cursor: string | null): Promise<VersionList> {
  return api(`/artifacts/${encodeURIComponent(artifactId)}/versions`, {
    query: { limit: VERSION_PAGE_SIZE, cursor },
    schema: VersionList,
  });
}

/** The versions of an artifact, the newest first, 50 at a time. */
export function useVersions(
  artifactId: string,
): UseInfiniteQueryResult<InfiniteData<VersionList>, ApiError> {
  return useInfiniteQuery<
    VersionList,
    ApiError,
    InfiniteData<VersionList>,
    ReturnType<typeof qk.versions>,
    string | null
  >({
    queryKey: qk.versions(artifactId),
    queryFn: ({ pageParam }) => listVersions(artifactId, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

/**
 * A short-lived content URL for version `n`. `review` is what the review
 * frame loads (and counts as opening the artifact); `raw` serves the stored
 * files as they are.
 */
export function getPreview(
  artifactId: string,
  n: number,
  mode: 'review' | 'raw',
): Promise<ContentGrant> {
  return api(`/artifacts/${encodeURIComponent(artifactId)}/versions/${n}/preview`, {
    query: { mode },
    schema: ContentGrant,
  });
}

/**
 * The grant the review frame loads version `n` from; idle while `n` is null.
 * It never goes stale by itself and is asked for again five minutes before it
 * expires (at least a minute apart), so a tab left open for a day keeps a
 * working URL. The frame's address changes each time: the page that shows it
 * decides when to load the new one.
 */
export function useReviewGrant(
  artifactId: string,
  n: number | null,
): UseQueryResult<ContentGrant, ApiError> {
  return useQuery<ContentGrant, ApiError>({
    queryKey: qk.preview(artifactId, n, 'review'),
    queryFn: n === null ? skipToken : () => getPreview(artifactId, n, 'review'),
    staleTime: Number.POSITIVE_INFINITY,
    // A tab in the background keeps renewing too: it is the one left open for hours.
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const grant = query.state.data;
      if (!grant) return false;
      return Math.max(
        MIN_RENEW_INTERVAL_MS,
        grant.expires_at - Date.now() - RENEW_BEFORE_EXPIRY_MS,
      );
    },
  });
}

/**
 * Restores version `n` as a new version on top of the one the caller saw
 * (`expectedVersionId`); a newer one fails with `version_conflict`.
 */
export function restoreVersion(
  artifactId: string,
  n: number,
  expectedVersionId: string,
): Promise<VersionSummary> {
  return api(`/artifacts/${encodeURIComponent(artifactId)}/versions/${n}/restore`, {
    method: 'POST',
    body: { expected_version_id: expectedVersionId },
    schema: VersionSummary,
  });
}

export function deleteVersion(artifactId: string, n: number): Promise<void> {
  return api(`/artifacts/${encodeURIComponent(artifactId)}/versions/${n}`, { method: 'DELETE' });
}

export function deleteArtifact(artifactId: string): Promise<void> {
  return api(`/artifacts/${encodeURIComponent(artifactId)}`, { method: 'DELETE' });
}
