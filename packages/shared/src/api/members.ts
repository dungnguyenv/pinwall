import { z } from 'zod';
import { Timestamp } from './common.ts';

/** What a member may do in a project: an editor publishes, a viewer only reads and comments. */
export const ProjectMemberRole = z.enum(['editor', 'viewer']);
export type ProjectMemberRole = z.infer<typeof ProjectMemberRole>;

/** Someone the project's owner let in. Sent only in `personal` mode. */
export const ProjectMember = z.object({
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    /** Only in the owner's view; null otherwise. */
    email: z.string().nullable(),
  }),
  role: ProjectMemberRole,
  added_at: Timestamp,
});
export type ProjectMember = z.infer<typeof ProjectMember>;

/** The project's members, oldest first. The owner is not listed: see `Project.owner`. */
export const ProjectMemberList = z.object({ items: z.array(ProjectMember) });
export type ProjectMemberList = z.infer<typeof ProjectMemberList>;

/**
 * Lets the person with `email` into the project. When several accounts have that email,
 * `user_id` picks one of the candidates the refusal listed.
 */
export const AddMemberRequest = z.object({
  email: z.email().max(254),
  role: ProjectMemberRole,
  user_id: z.string().min(1).max(100).optional(),
});
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

export const UpdateMemberRequest = z.object({ role: ProjectMemberRole });
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

/** One of several accounts with the email asked for, and how it signs in. */
export const MemberCandidate = z.object({
  user_id: z.string(),
  name: z.string().nullable(),
  kind: z.enum(['owner', 'oidc']),
});
export type MemberCandidate = z.infer<typeof MemberCandidate>;
