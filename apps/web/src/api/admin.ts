import {
  type InfiniteData,
  type QueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type ApiError, api } from './client.ts';
import {
  AdminConfig,
  AdminUser,
  AdminUserList,
  type PurgeRequest,
  PurgeResult,
  RevokeResult,
  type SetRoleRequest,
  type UpdateAdminUserRequest,
} from './dto.ts';
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

/** Changes only the keys sent: whether the person may expose content, and their own limits. */
export function updateAdminUser(id: string, body: UpdateAdminUserRequest): Promise<AdminUser> {
  return api(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: AdminUser,
  });
}

/**
 * Deletes every project the person owns. Personal mode only. `confirm_email` is their email
 * address, or their id when they have none.
 */
export function purgeUser(id: string, confirm_email: string): Promise<PurgeResult> {
  const body: PurgeRequest = { confirm_email };
  return api(`/admin/users/${encodeURIComponent(id)}/purge`, {
    method: 'POST',
    body,
    schema: PurgeResult,
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

/**
 * A limit an admin sets on one person: the instance's own, none at all, or a number. On the wire
 * that is `null`, `0` and the number; bytes for storage, a count for artifacts.
 */
export type QuotaChoice =
  | { kind: 'instance' }
  | { kind: 'none' }
  | { kind: 'custom'; value: number };

/** What the person's limit says now; an old server that sends none means the instance's. */
export function fromQuota(q: number | null | undefined): QuotaChoice {
  if (q === null || q === undefined) return { kind: 'instance' };
  return q === 0 ? { kind: 'none' } : { kind: 'custom', value: q };
}

export function toQuota(c: QuotaChoice): number | null {
  switch (c.kind) {
    case 'instance':
      return null;
    case 'none':
      return 0;
    case 'custom':
      return c.value;
  }
}

/** The units a storage limit is typed in; decimal, as the server's limits are. */
export const BYTE_UNITS = { MB: 1_000_000, GB: 1_000_000_000 } as const;

type AdminUsersData = InfiniteData<AdminUserList>;

/** Shows `saved` in the list at once, without loading every page again. */
function writeUser(queryClient: QueryClient, saved: AdminUser): void {
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
}

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
    onSuccess: (saved) => writeUser(queryClient, saved),
  });
}

/** Saves an approval or limits change and shows the server's answer in the list at once. */
export function useUpdateAdminUser(): UseMutationResult<
  AdminUser,
  ApiError,
  { id: string; patch: UpdateAdminUserRequest }
> {
  const queryClient = useQueryClient();
  return useMutation<AdminUser, ApiError, { id: string; patch: UpdateAdminUserRequest }>({
    mutationFn: ({ id, patch }) => updateAdminUser(id, patch),
    onSuccess: (saved) => writeUser(queryClient, saved),
  });
}

/**
 * Deletes a person's content, then loads the list again: their usage fell to zero. Projects and
 * artifacts that were shared with the signed-in admin are gone as well, so their lists load again
 * too.
 */
export function usePurgeUser(): UseMutationResult<
  PurgeResult,
  ApiError,
  { id: string; confirm: string }
> {
  const queryClient = useQueryClient();
  return useMutation<PurgeResult, ApiError, { id: string; confirm: string }>({
    mutationFn: ({ id, confirm }) => purgeUser(id, confirm),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.adminUsers }),
        queryClient.invalidateQueries({ queryKey: qk.artifactLists }),
        queryClient.invalidateQueries({ queryKey: qk.projectLists }),
      ]),
  });
}

export function useRevokeUser(): UseMutationResult<RevokeResult, ApiError, string> {
  return useMutation<RevokeResult, ApiError, string>({ mutationFn: revokeUser });
}

export function useAdminConfig(): UseQueryResult<AdminConfig, ApiError> {
  return useQuery<AdminConfig, ApiError>({ queryKey: qk.adminConfig, queryFn: getAdminConfig });
}
