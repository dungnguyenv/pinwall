import {
  keepPreviousData,
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { type ApiError, api } from './client.ts';
import { ArtifactSummary, type CreateProjectRequest, Project, ProjectList, page } from './dto.ts';
import { qk } from './keys.ts';

/** An artifact as the library shows it. */
export const LibraryArtifact = ArtifactSummary.extend({
  // M5 adds both to ArtifactSummary as required fields; until it merges they are absent.
  open_thread_count: z.number().int().min(0).optional(),
  share_link_count: z.number().int().min(0).optional(),
});
export type LibraryArtifact = z.infer<typeof LibraryArtifact>;

export const LibraryArtifactList = page(LibraryArtifact);
export type LibraryArtifactList = z.infer<typeof LibraryArtifactList>;

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

/** Artifacts, the latest updated first; with `q`, the best matches first. */
export function listArtifacts(p: {
  projectId?: string;
  q?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<LibraryArtifactList> {
  return api('/artifacts', {
    query: { project_id: p.projectId, q: p.q, cursor: p.cursor, limit: p.limit },
    schema: LibraryArtifactList,
  });
}

/** The artifacts the signed-in person opened last, the latest first. */
export function listRecent(limit: number): Promise<LibraryArtifactList> {
  return api('/artifacts/recent', { query: { limit }, schema: LibraryArtifactList });
}

/** The sidebar's projects: the first 200, active or archived. */
export function useProjects(archived: boolean): UseQueryResult<ProjectList, ApiError> {
  return useQuery<ProjectList, ApiError>({
    queryKey: qk.projects(archived),
    queryFn: () => listProjects({ archived, limit: SIDEBAR_PROJECTS }),
  });
}

export function useRecent(): UseQueryResult<LibraryArtifactList, ApiError> {
  return useQuery<LibraryArtifactList, ApiError>({
    queryKey: qk.recent,
    queryFn: () => listRecent(SIDEBAR_RECENT),
  });
}

/**
 * The first matches for `q`, for the search dialog. Runs only for a term with
 * something besides spaces; the caller debounces typing.
 */
export function useArtifactSearch(q: string): UseQueryResult<LibraryArtifactList, ApiError> {
  const term = q.trim();
  return useQuery<LibraryArtifactList, ApiError>({
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
