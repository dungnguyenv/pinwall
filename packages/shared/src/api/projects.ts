import { z } from 'zod';
import { Label, page, Timestamp } from './common.ts';

/** What the agent reads about a project before it publishes into it. */
const Instructions = z.string().max(20_000);

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  /** The project publishes without a project go to. It cannot be archived. */
  is_default: z.boolean(),
  /** When the project was archived; `null` while it is active. */
  archived_at: Timestamp.nullable(),
  /** Artifacts in the project, whatever their state. */
  artifact_count: z.number().int(),
  created_at: Timestamp,
  updated_at: Timestamp,
  /**
   * Who owns the project, and so whose space it is in; `null` for one nobody owns. Sent only in
   * `personal` mode.
   */
  owner: z.object({ id: z.string(), name: z.string().nullable() }).nullable().optional(),
  /** What the caller is to the project. Sent only in `personal` mode. */
  role: z.enum(['owner', 'editor', 'viewer']).optional(),
  /**
   * Whether everyone who signs in can view the project now, as a viewer: its owner made it
   * visible to everyone, and this Pinwall lets their projects be. Sent only in `personal` mode.
   */
  everyone_can_view: z.boolean().optional(),
  /**
   * The owner's choice to make the project visible to everyone. It is in effect as
   * `everyone_can_view` says. Sent only to the owner, in `personal` mode.
   */
  visible_to_everyone: z.boolean().optional(),
});
export type Project = z.infer<typeof Project>;

export const ProjectList = page(Project);
export type ProjectList = z.infer<typeof ProjectList>;

export const CreateProjectRequest = z.object({
  name: Label,
  instructions: Instructions.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/**
 * Only the fields given change. `archived: true` archives, `false` brings the project back.
 * `visible_to_everyone: true` lets everyone who signs in view the project, where this Pinwall
 * allows it (`PublicConfig.everyone_projects`); `false` keeps it to its owner and members.
 */
export const UpdateProjectRequest = z.object({
  name: Label.optional(),
  instructions: Instructions.optional(),
  archived: z.boolean().optional(),
  visible_to_everyone: z.boolean().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;
