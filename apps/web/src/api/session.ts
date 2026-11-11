import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate } from 'react-router';
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

/** Signs out, forgets everything cached for this user, and opens the sign-in page. */
export function useSignOut(): UseMutationResult<void, ApiError, void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation<void, ApiError, void>({
    mutationFn: signOut,
    onSuccess: async () => {
      // Leave the signed-in pages first, in one synchronous render, so none of
      // them asks for its data again after the cache is emptied.
      await navigate('/signin', { flushSync: true });
      queryClient.clear();
    },
  });
}
