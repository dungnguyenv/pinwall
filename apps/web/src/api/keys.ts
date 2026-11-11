/** Which artifacts a list shows: one project's, a search's, or all of them. */
export interface ArtifactFilter {
  projectId?: string;
  q?: string;
}

/**
 * Every TanStack Query key the app uses, so invalidations and cache writes
 * name the same keys as the queries they target. Each screen adds its keys
 * here rather than spelling them inline.
 *
 * Every artifact list (a filtered list, Recent, a search) starts with
 * `'artifacts'`, so invalidating `['artifacts']` refreshes them all after an
 * artifact changes.
 */
export const qk = {
  me: ['me'] as const,
  /** Both project lists, active and archived. */
  projectLists: ['projects'] as const,
  /** Every artifact list: filtered lists, Recent and searches. */
  artifactLists: ['artifacts'] as const,
  publicConfig: ['config', 'public'] as const,
  setupCheck: (token: string) => ['setup', 'check', token] as const,
  projects: (archived: boolean) => ['projects', { archived }] as const,
  project: (id: string) => ['project', id] as const,
  artifacts: (filter: ArtifactFilter) => ['artifacts', 'list', filter] as const,
  recent: ['artifacts', 'recent'] as const,
  search: (q: string) => ['artifacts', 'search', q] as const,
  artifact: (id: string) => ['artifact', id] as const,
};
