import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type ApiError, api } from './client.ts';
import { AdminConfig, AdminUser, AdminUserList, RevokeResult, type SetRoleRequest } from './dto.ts';
import { qk } from './keys.ts';

/*
 * Admin only: the people who can use this Pinwall, and the configuration it
 * runs with. The server refuses everyone else with 403.
 */

/** Users per page of the admin list. */
export const ADMIN_USERS_PAGE_SIZE = 50;

/** Oldest first, a page at a time; pass `next_cursor` back as `cursor` for the next page. */
export function listAdminUsers(p: {
  cursor?: string | null;
  limit?: number;
}): Promise<AdminUserList> {
  return api('/admin/users', {
    query: { cursor: p.cursor, limit: p.limit },
    schema: AdminUserList,
  });
}

/** `null` clears the override, so the identity provider's role applies again. */
export function setUserRole(
  id: string,
  role_override: SetRoleRequest['role_override'],
): Promise<AdminUser> {
  const body: SetRoleRequest = { role_override };
  return api(`/admin/users/${encodeURIComponent(id)}/role`, {
    method: 'PUT',
    body,
    schema: AdminUser,
  });
}

/** Ends the user's sessions, API tokens and agent connections at once. */
export function revokeUser(id: string): Promise<RevokeResult> {
  return api(`/admin/users/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    schema: RevokeResult,
  });
}

/** The effective settings. Secrets come as "set or not", never as values. */
export function getAdminConfig(): Promise<AdminConfig> {
  return api('/admin/config', { schema: AdminConfig });
}

/**
 * What an admin can pick for a user's role. `idp` stands for no override
 * (`null` on the wire): the Select has no empty value to use for it.
 */
export const ROLE_OPTIONS = ['idp', 'admin', 'member', 'blocked'] as const;
export type RoleOption = (typeof ROLE_OPTIONS)[number];

export function toRoleOption(override: SetRoleRequest['role_override']): RoleOption {
  return override ?? 'idp';
}

export function toRoleOverride(option: RoleOption): SetRoleRequest['role_override'] {
  return option === 'idp' ? null : option;
}

type AdminUsersData = InfiniteData<AdminUserList>;

export function useAdminUsers(): UseInfiniteQueryResult<AdminUsersData, ApiError> {
  return useInfiniteQuery<
    AdminUserList,
    ApiError,
    AdminUsersData,
    typeof qk.adminUsers,
    string | null
  >({
    queryKey: qk.adminUsers,
    queryFn: ({ pageParam }) => listAdminUsers({ cursor: pageParam, limit: ADMIN_USERS_PAGE_SIZE }),
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

/**
 * Saves a role override and shows the server's answer in the list at once,
 * without loading every page again.
 */
export function useSetUserRole(): UseMutationResult<
  AdminUser,
  ApiError,
  { id: string; option: RoleOption }
> {
  const queryClient = useQueryClient();
  return useMutation<AdminUser, ApiError, { id: string; option: RoleOption }>({
    mutationFn: ({ id, option }) => setUserRole(id, toRoleOverride(option)),
    onSuccess: (saved) => {
      queryClient.setQueryData<AdminUsersData>(qk.adminUsers, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((user) => (user.id === saved.id ? saved : user)),
              })),
            }
          : data,
      );
    },
  });
}

export function useRevokeUser(): UseMutationResult<RevokeResult, ApiError, string> {
  return useMutation<RevokeResult, ApiError, string>({ mutationFn: revokeUser });
}

export function useAdminConfig(): UseQueryResult<AdminConfig, ApiError> {
  return useQuery<AdminConfig, ApiError>({ queryKey: qk.adminConfig, queryFn: getAdminConfig });
}
