import type { ThreadScope } from '../review/comments/threads.ts';

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
  /** The people a project's owner let in, as the signed-in person sees them. */
  members: (projectId: string) => ['members', projectId] as const,
  /** The owner's passkeys, for Settings. */
  passkeys: ['passkeys'] as const,
  /** The signed-in person's API tokens, for Settings. Never holds a token's secret. */
  tokens: ['tokens'] as const,
  /** The admin user list, every page of it. */
  adminUsers: ['admin', 'users'] as const,
  /** The effective configuration, for the admin Configuration page. */
  adminConfig: ['admin', 'config'] as const,
  /** An OAuth authorization request waiting on the consent page. */
  consent: (id: string) => ['oauth', 'consent', id] as const,
  /** The versions of an artifact, newest first, a page at a time. */
  versions: (id: string) => ['versions', id] as const,
  /**
   * One version of an artifact, read on its own (`null`: none asked for). Its
   * own prefix: a number is never reused, so refreshing the list leaves it be.
   */
  version: (id: string, n: number | null) => ['version', id, n] as const,
  /**
   * A content grant for one version (`null`: none chosen yet). Its own prefix,
   * not under `versions`: refreshing the version list must not hand the frame
   * a new URL.
   */
  preview: (id: string, n: number | null, mode: 'review' | 'raw') =>
    ['preview', id, n, mode] as const,
  /**
   * Every comment thread of an artifact, or of what a share link shows. A
   * share scope holds the link's token: like every key, it lives in memory
   * only, and signing out drops it.
   */
  threads: (scope: ThreadScope) =>
    scope.kind === 'artifact'
      ? (['threads', 'artifact', scope.artifactId] as const)
      : (['threads', 'share', scope.token] as const),
  shareLinks: (id: string) => ['share-links', id] as const,
  shareInfo: (token: string) => ['share', 'info', token] as const,
  /** The files that changed between two versions; `null` while a side is not chosen. */
  diff: (id: string, from: number | null, to: number | null) => ['diff', id, from, to] as const,
  /** The unified diff of one text file between two versions. */
  fileDiff: (id: string, from: number | null, to: number | null, path: string | null) =>
    ['diff', id, from, to, 'file', path] as const,
  /** The block diff of one Markdown file between two versions. */
  mdDiff: (id: string, from: number | null, to: number | null, path: string | null) =>
    ['diff', id, from, to, 'markdown', path] as const,
};
