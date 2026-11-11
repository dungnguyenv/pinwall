import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type ApiError, api } from './client.ts';
import {
  type AddPasskeyRequest,
  ApiTokenList,
  CeremonyOptions,
  type ChangePasswordRequest,
  type CreateApiTokenRequest,
  CreatedApiToken,
  Me,
  Passkey,
  PasskeyList,
  type UpdateProfileRequest,
} from './dto.ts';
import { qk } from './keys.ts';

/*
 * The owner's account: profile, password, passkeys and API tokens. Managing
 * how the owner signs in, and tokens, takes a browser session, which this app
 * always is; the server refuses a bearer token on these routes.
 */

/** Changes the profile; only the fields sent change, and `email: null` removes the email. */
export function updateProfile(body: UpdateProfileRequest): Promise<Me> {
  return api('/me', { method: 'PATCH', body, schema: Me });
}

/**
 * Sets the password. `current_password` is required once there is one and
 * left out when the owner has none. Every other browser session ends.
 */
export function changePassword(body: ChangePasswordRequest): Promise<void> {
  return api('/me/password', { method: 'PUT', body });
}

/** Refused (409) while it is the last way to sign in. */
export function removePassword(): Promise<void> {
  return api('/me/password', { method: 'DELETE' });
}

export function listPasskeys(): Promise<PasskeyList> {
  return api('/me/passkeys', { schema: PasskeyList });
}

/** Begins adding a passkey; the result goes to the browser, then to `addPasskey`. */
export function addPasskeyOptions(): Promise<CeremonyOptions> {
  return api('/me/passkeys/options', { method: 'POST', schema: CeremonyOptions });
}

export function addPasskey(body: AddPasskeyRequest): Promise<Passkey> {
  return api('/me/passkeys', { method: 'POST', body, schema: Passkey });
}

export function renamePasskey(id: string, name: string): Promise<Passkey> {
  return api(`/me/passkeys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name },
    schema: Passkey,
  });
}

/** Refused (409) while it is the last way to sign in. */
export function deletePasskey(id: string): Promise<void> {
  return api(`/me/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** The tokens that are not revoked, newest first. Secrets are never listed. */
export function listTokens(): Promise<ApiTokenList> {
  return api('/me/tokens', { schema: ApiTokenList });
}

/** The response holds the token's secret, the only time anything does. */
export function createToken(body: CreateApiTokenRequest): Promise<CreatedApiToken> {
  return api('/me/tokens', { method: 'POST', body, schema: CreatedApiToken });
}

export function revokeToken(id: string): Promise<void> {
  return api(`/me/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** The days a new token lasts, offered in this order; `null` never expires. */
export const TOKEN_EXPIRY_CHOICES = [30, 90, 365, null] as const;
export type TokenExpiry = (typeof TOKEN_EXPIRY_CHOICES)[number];
export const DEFAULT_TOKEN_EXPIRY: TokenExpiry = 90;

export function usePasskeys(): UseQueryResult<PasskeyList, ApiError> {
  return useQuery<PasskeyList, ApiError>({ queryKey: qk.passkeys, queryFn: listPasskeys });
}

export function useTokens(): UseQueryResult<ApiTokenList, ApiError> {
  return useQuery<ApiTokenList, ApiError>({ queryKey: qk.tokens, queryFn: listTokens });
}

/** Saves the profile and shows the answer wherever the signed-in person is named. */
export function useUpdateProfile(): UseMutationResult<Me, ApiError, UpdateProfileRequest> {
  const queryClient = useQueryClient();
  return useMutation<Me, ApiError, UpdateProfileRequest>({
    mutationFn: updateProfile,
    onSuccess: (me) => queryClient.setQueryData(qk.me, me),
  });
}

/**
 * Refreshes what Settings reads about how the owner signs in, after a change
 * to the password or the passkeys. `me` counts the credentials, so it
 * refreshes along with the passkey list.
 */
export function useRefreshCredentials(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.me }),
      queryClient.invalidateQueries({ queryKey: qk.passkeys }),
    ]);
  };
}

export function useChangePassword(): UseMutationResult<void, ApiError, ChangePasswordRequest> {
  const refresh = useRefreshCredentials();
  return useMutation<void, ApiError, ChangePasswordRequest>({
    mutationFn: changePassword,
    onSuccess: refresh,
  });
}

export function useRemovePassword(): UseMutationResult<void, ApiError, void> {
  const refresh = useRefreshCredentials();
  return useMutation<void, ApiError, void>({ mutationFn: removePassword, onSuccess: refresh });
}

export function useRenamePasskey(): UseMutationResult<
  Passkey,
  ApiError,
  { id: string; name: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renamePasskey(id, name),
    // Only the list shows names; `me` counts credentials and did not change.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.passkeys }),
  });
}

export function useDeletePasskey(): UseMutationResult<void, ApiError, string> {
  const refresh = useRefreshCredentials();
  return useMutation<void, ApiError, string>({ mutationFn: deletePasskey, onSuccess: refresh });
}

export function useRevokeToken(): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: revokeToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.tokens }),
  });
}
