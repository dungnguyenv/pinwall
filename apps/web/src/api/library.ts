import {
  type InfiniteData,
  keepPreviousData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { type ApiError, api } from './client.ts';
import {
  ArtifactList,
  ArtifactSummary,
  type CreateProjectRequest,
  Project,
  ProjectList,
  type UpdateProjectRequest,
} from './dto.ts';
import { type ArtifactFilter, qk } from './keys.ts';

/** Artifacts per page of a library list: a multiple of 2, 3, 4 and 6 columns. */
export const ARTIFACT_PAGE_SIZE = 48;
/** The longest project instructions the server accepts. */
export const INSTRUCTIONS_MAX = 20_000;
/** The longest search term the server accepts. */
export const SEARCH_MAX_CHARS = 256;

const SIDEBAR_PROJECTS = 200;
const SIDEBAR_RECENT = 8;
const SEARCH_PREVIEW = 8;

/** Active projects, or the archived ones; the default project comes first. */
export function listProjects(p: {
  archived: boolean;
  cursor?: string | null;
  limit?: number;
}): Promise<ProjectList> {
  return api('/projects', {
    query: { archived: p.archived, cursor: p.cursor, limit: p.limit },
    schema: ProjectList,
  });
}

export function createProject(body: CreateProjectRequest): Promise<Project> {
  return api('/projects', { method: 'POST', body, schema: Project });
}

export function getProject(id: string): Promise<Project> {
  return api(`/projects/${encodeURIComponent(id)}`, { schema: Project });
}

/** Renames, rewrites the instructions of, archives or unarchives a project. */
export function updateProject(id: string, body: UpdateProjectRequest): Promise<Project> {
  return api(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body, schema: Project });
}

export function getArtifact(id: string): Promise<ArtifactSummary> {
  return api(`/artifacts/${encodeURIComponent(id)}`, { schema: ArtifactSummary });
}

/** Artifacts, the latest updated first; with `q`, the best matches first. */
export function listArtifacts(p: {
  projectId?: string;
  q?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<ArtifactList> {
  return api('/artifacts', {
    query: { project_id: p.projectId, q: p.q, cursor: p.cursor, limit: p.limit },
    schema: ArtifactList,
  });
}

/** The artifacts the signed-in person opened last, the latest first. */
export function listRecent(limit: number): Promise<ArtifactList> {
  return api('/artifacts/recent', { query: { limit }, schema: ArtifactList });
}

/** The sidebar's projects: the first 200, active or archived. */
export function useProjects(archived: boolean): UseQueryResult<ProjectList, ApiError> {
  return useQuery<ProjectList, ApiError>({
    queryKey: qk.projects(archived),
    queryFn: () => listProjects({ archived, limit: SIDEBAR_PROJECTS }),
  });
}

/** Active project names by id, for lists that mix the artifacts of several projects. */
export function useProjectNames(): Map<string, string> {
  const projects = useProjects(false);
  return useMemo(
    () => new Map((projects.data?.items ?? []).map((project) => [project.id, project.name])),
    [projects.data],
  );
}

export function useRecent(): UseQueryResult<ArtifactList, ApiError> {
  return useQuery<ArtifactList, ApiError>({
    queryKey: qk.recent,
    queryFn: () => listRecent(SIDEBAR_RECENT),
  });
}

/**
 * The first matches for `q`, for the search dialog. Runs only for a term with
 * something besides spaces; the caller debounces typing.
 */
export function useArtifactSearch(q: string): UseQueryResult<ArtifactList, ApiError> {
  const term = q.trim();
  return useQuery<ArtifactList, ApiError>({
    queryKey: qk.search(term),
    queryFn: () => listArtifacts({ q: term, limit: SEARCH_PREVIEW }),
    enabled: term !== '',
    // The last results stay up while the next ones load, so the list does not flicker.
    placeholderData: keepPreviousData,
  });
}

/** Creates a project, then refreshes the project list and caches the new project. */
export function useCreateProject(): UseMutationResult<Project, ApiError, CreateProjectRequest> {
  const queryClient = useQueryClient();
  return useMutation<Project, ApiError, CreateProjectRequest>({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.setQueryData(qk.project(project.id), project);
      return queryClient.invalidateQueries({ queryKey: qk.projects(false) });
    },
  });
}

/** One project; with `enabled: false` it is not read (default: it is). */
export function useProject(
  id: string,
  o: { enabled?: boolean } = {},
): UseQueryResult<Project, ApiError> {
  return useQuery<Project, ApiError>({
    queryKey: qk.project(id),
    queryFn: () => getProject(id),
    enabled: o.enabled,
  });
}

/**
 * Changes a project. The answer replaces the cached project and the project
 * lists refresh, so the sidebar moves or renames it. Archiving or unarchiving
 * also refreshes every artifact list, since archived projects' artifacts
 * leave All artifacts and search.
 */
export function useUpdateProject(
  id: string,
): UseMutationResult<Project, ApiError, UpdateProjectRequest> {
  const queryClient = useQueryClient();
  return useMutation<Project, ApiError, UpdateProjectRequest>({
    mutationFn: (body) => updateProject(id, body),
    onSuccess: (project, body) => {
      queryClient.setQueryData(qk.project(id), project);
      const refreshes = [queryClient.invalidateQueries({ queryKey: qk.projectLists })];
      if (body.archived !== undefined) {
        refreshes.push(queryClient.invalidateQueries({ queryKey: qk.artifactLists }));
      }
      return Promise.all(refreshes);
    },
  });
}

/**
 * A library list, a page of 48 at a time: one project's artifacts, a search's
 * matches, or every artifact of the active projects. A blank `q` searches for
 * nothing, so it sends no request.
 */
export function useArtifacts(
  f: ArtifactFilter,
): UseInfiniteQueryResult<InfiniteData<ArtifactList>, ApiError> {
  const filter: ArtifactFilter = {};
  if (f.projectId !== undefined) filter.projectId = f.projectId;
  if (f.q !== undefined) filter.q = f.q.trim().slice(0, SEARCH_MAX_CHARS);
  return useInfiniteQuery<
    ArtifactList,
    ApiError,
    InfiniteData<ArtifactList>,
    ReturnType<typeof qk.artifacts>,
    string | null
  >({
    queryKey: qk.artifacts(filter),
    queryFn: ({ pageParam }) =>
      listArtifacts({ ...filter, cursor: pageParam, limit: ARTIFACT_PAGE_SIZE }),
    initialPageParam: null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: filter.q !== '',
  });
}

export function useArtifact(id: string): UseQueryResult<ArtifactSummary, ApiError> {
  return useQuery<ArtifactSummary, ApiError>({
    queryKey: qk.artifact(id),
    queryFn: () => getArtifact(id),
  });
}
