import {
  hashKey,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { signInPath } from '../lib/return-to.ts';
import { type ApiError, api, isApiError } from './client.ts';
import { Me, PublicConfig } from './dto.ts';
import { qk } from './keys.ts';

/** The signed-in user, or `null` when there is no session. */
export async function getMe(): Promise<Me | null> {
  try {
    return await api('/me', { schema: Me, redirectOn401: false });
  } catch (e) {
    if (isApiError(e, 'unauthorized') && e.status === 401) return null;
    throw e;
  }
}

export function getPublicConfig(): Promise<PublicConfig> {
  return api('/config/public', { schema: PublicConfig });
}

/** Ends the browser session; API tokens stay valid. */
export function signOut(): Promise<void> {
  return api('/auth/sign-out', { method: 'POST' });
}

/** Cached queries that outlive a change of person: who is signed in, and what is the same for everyone. */
const SESSION_KEYS = new Set([hashKey(qk.me), hashKey(qk.publicConfig)]);

/**
 * Makes `me` the signed-in person (`null`: nobody) and forgets every query
 * cached for whoever came before, so a page never shows a previous person's
 * data. `me` is written rather than removed so the components reading it
 * update at once; the public configuration is the same for everyone and the
 * sign-in page is showing it, so it stays.
 */
export function replaceSession(queryClient: QueryClient, me: Me | null): void {
  queryClient.removeQueries({ predicate: (query) => !SESSION_KEYS.has(query.queryHash) });
  queryClient.setQueryData(qk.me, me);
}

export function useMe(): UseQueryResult<Me | null, ApiError> {
  return useQuery<Me | null, ApiError>({ queryKey: qk.me, queryFn: getMe });
}

/** The public configuration changes only when the server restarts, so it is read once. */
export function usePublicConfig(): UseQueryResult<PublicConfig, ApiError> {
  return useQuery<PublicConfig, ApiError>({
    queryKey: qk.publicConfig,
    queryFn: getPublicConfig,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * What happens in the browser once the session has ended on the server:
 * forgets everything cached for this person and opens the sign-in page. With
 * `returnTo`, signing in again goes back there; with `chooseAccount` too, the
 * sign-in page offers the provider's account picker (see `signInPath`).
 * Sign-out and "Revoke now" on your own account both end this way.
 */
export function useLeaveSession(
  o: { returnTo?: string; chooseAccount?: boolean } = {},
): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { returnTo, chooseAccount } = o;
  return async () => {
    // Signed out first, so the sign-in page does not send the person back in.
    queryClient.setQueryData(qk.me, null);
    // Then leave the signed-in pages, in one synchronous render, so none of
    // them asks for its data again after the cache is emptied.
    await navigate(returnTo === undefined ? '/signin' : signInPath(returnTo, { chooseAccount }), {
      flushSync: true,
    });
    replaceSession(queryClient, null);
  };
}

/**
 * Signs out, forgets everything cached for this user, and opens the sign-in
 * page. With `returnTo`, signing in again goes back there; see
 * `useLeaveSession` for `chooseAccount`.
 */
export function useSignOut(
  o: { returnTo?: string; chooseAccount?: boolean } = {},
): UseMutationResult<void, ApiError, void> {
  const leave = useLeaveSession(o);
  return useMutation<void, ApiError, void>({ mutationFn: signOut, onSuccess: leave });
}
