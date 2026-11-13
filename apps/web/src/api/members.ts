import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type ApiError, api, isApiError } from './client.ts';
import {
  type AddMemberRequest,
  MemberCandidate,
  ProjectMember,
  ProjectMemberList,
  type ProjectMemberRole,
  type UpdateMemberRequest,
} from './dto.ts';
import { qk } from './keys.ts';
import { useMe } from './session.ts';

/*
 * A project's members, in `personal` mode. Every route answers 404 in `team` mode, so callers
 * run only in `personal` mode. The owner sees emails; everyone else sees names.
 */

const membersPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/members`;
const memberPath = (projectId: string, userId: string) =>
  `${membersPath(projectId)}/${encodeURIComponent(userId)}`;

/** The people the owner let in, oldest first. The owner is not among them: see `Project.owner`. */
export function listMembers(projectId: string): Promise<ProjectMemberList> {
  return api(membersPath(projectId), { schema: ProjectMemberList });
}

/** Lets in the person with `body.email`; `body.user_id` picks one of several accounts that share it. */
export function addMember(projectId: string, body: AddMemberRequest): Promise<ProjectMember> {
  return api(membersPath(projectId), { method: 'POST', body, schema: ProjectMember });
}

export function updateMember(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
): Promise<ProjectMember> {
  const body: UpdateMemberRequest = { role };
  return api(memberPath(projectId, userId), { method: 'PATCH', body, schema: ProjectMember });
}

/** The owner removes a member; a member whose own id it is leaves the project. */
export function removeMember(projectId: string, userId: string): Promise<void> {
  return api(memberPath(projectId, userId), { method: 'DELETE' });
}

/**
 * The members of a project, read afresh each time the panel opens: people also join or go from
 * elsewhere. With `enabled: false` nothing is read.
 */
export function useMembers(
  projectId: string,
  enabled: boolean,
): UseQueryResult<ProjectMemberList, ApiError> {
  return useQuery<ProjectMemberList, ApiError>({
    queryKey: qk.members(projectId),
    queryFn: () => listMembers(projectId),
    enabled,
    staleTime: 0,
  });
}

/** Adds a member, then reads the list again. */
export function useAddMember(
  projectId: string,
): UseMutationResult<ProjectMember, ApiError, AddMemberRequest> {
  const queryClient = useQueryClient();
  return useMutation<ProjectMember, ApiError, AddMemberRequest>({
    mutationFn: (body) => addMember(projectId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.members(projectId) }),
  });
}

/** Gives a member another role, then reads the list again. */
export function useUpdateMember(
  projectId: string,
): UseMutationResult<ProjectMember, ApiError, { userId: string; role: ProjectMemberRole }> {
  const queryClient = useQueryClient();
  return useMutation<ProjectMember, ApiError, { userId: string; role: ProjectMemberRole }>({
    mutationFn: ({ userId, role }) => updateMember(projectId, userId, role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.members(projectId) }),
  });
}

/** Removes a member, then reads the list again. */
export function useRemoveMember(projectId: string): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (userId) => removeMember(projectId, userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.members(projectId) }),
  });
}

/**
 * Leaves the project: removes the signed-in person from it. They can no longer read it, so what
 * the cache holds about it goes, and the lists that showed it (the sidebar's projects, every
 * artifact list, Recent) are read again. Nothing waits for those reads: the caller leaves the
 * page at once, and the page must not ask for a project that has just become unreachable.
 */
export function useLeaveProject(projectId: string): UseMutationResult<void, ApiError, void> {
  const queryClient = useQueryClient();
  const me = useMe().data;
  return useMutation<void, ApiError, void>({
    mutationFn: () =>
      me ? removeMember(projectId, me.id) : Promise.reject(new Error('Not signed in')),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: qk.project(projectId) });
      queryClient.removeQueries({ queryKey: qk.members(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.projectLists });
      void queryClient.invalidateQueries({ queryKey: qk.artifactLists });
    },
  });
}

const CANDIDATES = MemberCandidate.array();

/** The accounts a 409 `several_accounts` offered; null for any other error. */
export function candidatesOf(e: unknown): MemberCandidate[] | null {
  if (!isApiError(e) || e.status !== 409 || e.details?.reason !== 'several_accounts') return null;
  const parsed = CANDIDATES.safeParse(e.details.candidates);
  return parsed.success ? parsed.data : null;
}

/**
 * 'email' for a refusal about the address: no account uses it (404) or it is the owner's own
 * (400), each with `details.field` 'email', or the person is already a member (409). Null for
 * every other error, which is not about the field.
 */
export function memberErrorField(e: unknown): 'email' | null {
  if (!isApiError(e)) return null;
  if ((e.status === 404 || e.status === 400) && e.details?.field === 'email') return 'email';
  if (e.status === 409 && e.details?.reason === 'already_member') return 'email';
  return null;
}
