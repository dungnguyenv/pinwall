import { useMemo } from 'react';
import { canRevoke } from '../review/share/share-status.ts';
import type { ApiError } from './client.ts';
import type { ArtifactSummary, Me, Project, ShareLink, VersionSummary } from './dto.ts';
import { useProject } from './library.ts';
import { useMe, usePublicConfig } from './session.ts';

/*
 * What the signed-in person may change, as the server decides it. In `team`
 * mode that is the 1.0 rules. In `personal` mode it is their role in the
 * project, and for an artifact also whether they may manage it; until the
 * role is known they may change nothing. The SPA only hides what is refused:
 * the server still judges every request.
 */

export type Visibility = 'team' | 'personal';
export type ProjectRole = NonNullable<Project['role']>;

/** Inside the shell: 'personal' when the server says so, else 'team'. */
export function useVisibility(): Visibility {
  // `RequireAuth` waits for the configuration, so inside the shell it has answered or failed.
  return usePublicConfig().data?.visibility === 'personal' ? 'personal' : 'team';
}

/** 'team' (1.0 rules), the viewer's role in personal mode, or null while that role is not known. */
export type Standing = 'team' | ProjectRole | null;

export function standingOf(
  visibility: Visibility,
  project: Pick<Project, 'role'> | undefined,
): Standing {
  if (visibility === 'team') return 'team';
  return project?.role ?? null;
}

/** The person's standing, and how the read of the project that tells it went. */
export interface StandingRead {
  standing: Standing;
  /** Why the project could not be read, while that leaves the standing unknown; else null. */
  error: ApiError | null;
  /** Reads the project again. */
  retry(): void;
}

/** `useStanding`, with the read of the project behind it, for a page that waits on it. */
export function useStandingRead(projectId: string | null | undefined): StandingRead {
  const visibility = useVisibility();
  const personal = visibility === 'personal' && projectId != null && projectId !== '';
  const project = useProject(projectId ?? '', { enabled: personal });
  const standing = standingOf(visibility, personal ? project.data : undefined);
  return {
    standing,
    error: standing === null && personal ? project.error : null,
    retry: () => void project.refetch(),
  };
}

/** The person's standing in the project; in personal mode the project is read for its role. */
export function useStanding(projectId: string | null | undefined): Standing {
  return useStandingRead(projectId).standing;
}

export interface Rights {
  /** Upload into the project, restore a version. */
  publish: boolean;
  /** Rename, archive, edit instructions. */
  manageProject: boolean;
  deleteArtifact: boolean;
  deleteVersion(v: Pick<VersionSummary, 'created_by'> | null, versionCount: number): boolean;
  deleteOthersComments: boolean;
  /** The role's part; the policy part is `mayExpose(me)`. */
  createShareLinks: boolean;
  revokeLink(l: Pick<ShareLink, 'created_by'>): boolean;
}

const never = (): false => false;

/** Every flag false, every function false. */
export const NO_RIGHTS: Rights = Object.freeze({
  publish: false,
  manageProject: false,
  deleteArtifact: false,
  deleteVersion: never,
  deleteOthersComments: false,
  createShareLinks: false,
  revokeLink: never,
});

/** Whether `me` may delete the artifact or any of its versions, as 1.0 decides: an admin or its publisher. */
export function canDelete(me: Me, artifact: { created_by: string | null }): boolean {
  return me.role === 'admin' || artifact.created_by === me.id;
}

/** What `standing` allows `me` on `artifact`; with no artifact, the project-level flags only. */
export function rightsFor(
  me: Me,
  artifact: Pick<ArtifactSummary, 'created_by' | 'can_manage'> | null,
  standing: Standing,
): Rights {
  if (standing === null || standing === 'viewer') return NO_RIGHTS;
  const project = {
    ...NO_RIGHTS,
    publish: true,
    manageProject: standing !== 'editor',
    createShareLinks: true,
  };
  if (artifact === null) return project;

  switch (standing) {
    case 'team': {
      const deleteArtifact = canDelete(me, artifact);
      return {
        ...project,
        deleteArtifact,
        deleteVersion: (_v, versionCount) => deleteArtifact && versionCount > 1,
        deleteOthersComments: me.role === 'admin' || artifact.created_by === me.id,
        revokeLink: (l) => canRevoke(me, artifact, l),
      };
    }
    case 'owner':
      return {
        ...project,
        deleteArtifact: true,
        deleteVersion: (_v, versionCount) => versionCount > 1,
        deleteOthersComments: true,
        revokeLink: () => true,
      };
    case 'editor':
      return {
        ...project,
        deleteArtifact: artifact.can_manage === true,
        deleteVersion: (v, versionCount) => versionCount > 1 && v?.created_by === me.id,
        revokeLink: (l) => l.created_by?.user_id === me.id,
      };
  }
}

/** The signed-in person's rights on `artifact`; none while they or their role are not known. */
export function useArtifactRights(artifact: ArtifactSummary): Rights {
  const me = useMe().data;
  const standing = useStanding(artifact.project_id);
  const { created_by, can_manage } = artifact;
  return useMemo(
    () => (me ? rightsFor(me, { created_by, can_manage }, standing) : NO_RIGHTS),
    [me, created_by, can_manage, standing],
  );
}

/** The signed-in person's rights in a project, without an artifact. */
export function useProjectRights(projectId: string): Rights {
  const me = useMe().data;
  const standing = useStanding(projectId);
  return useMemo(() => (me ? rightsFor(me, null, standing) : NO_RIGHTS), [me, standing]);
}

/** Whether `me` may make share links and open raw links. Absent means 1.0: everyone may. */
export function mayExpose(me: Me): boolean {
  return me.can_create_share_links !== false;
}

/** Whether `project` is the signed-in person's own: they own it, or team mode sends no role. */
const isOwn = (project: Project) => project.role === undefined || project.role === 'owner';

/** The person's own default project, never one shared with them. */
export function ownDefaultProject(projects: readonly Project[] | undefined): Project | undefined {
  return projects?.find((project) => project.is_default && isOwn(project));
}

/** The person's own projects (every project in team mode), and those shared with them. */
export function splitProjects(projects: readonly Project[]): { own: Project[]; shared: Project[] } {
  return {
    own: projects.filter(isOwn),
    shared: projects.filter((project) => !isOwn(project)),
  };
}
